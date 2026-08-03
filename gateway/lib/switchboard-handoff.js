"use strict";

const crypto = require("node:crypto");

const CONTRACT_VERSION = 1;
const GOAL_CONTRACT_VERSION = 2;
const SOURCE_SYSTEM = "chief-moa";
const RECEIPT_EVENT = "capture.handoff.received";
const MAX_REFS = 20;
const MAX_REF_BYTES = 32 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_DESIRED_OUTCOME_CHARS = 100_000;
const MAX_ACCEPTANCE_CRITERIA = 32;
const MAX_ACCEPTANCE_CRITERION_CHARS = 1_000;

class SwitchboardHandoffError extends Error {
  constructor(message, code = "validation", statusCode = 400) {
    super(message);
    this.name = "SwitchboardHandoffError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function createSwitchboardHandoffService(options = {}) {
  const events = options.events;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const baseUrl = String(options.baseUrl || "").trim().replace(/\/$/, "");
  const token = String(options.token || "").trim();
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  if (!events || typeof events.appendEvent !== "function" || typeof events.listEvents !== "function") {
    throw new Error("Switchboard handoff requires an event substrate");
  }
  if (typeof events.withStreamLock !== "function") throw new Error("Switchboard handoff requires stream locking");
  if (typeof fetchImpl !== "function") throw new Error("Switchboard handoff requires fetch");

  async function handoffCaptureBlock(input = {}) {
    requireExecuteConfirmation(input);
    if (!baseUrl) throw new SwitchboardHandoffError(
      "Agent Switchboard is not configured",
      "unavailable",
      503,
    );
    const envelope = captureBlockEnvelope(input);
    const requestDigest = `sha256:${digest(canonicalJson(envelope))}`;
    const streamId = handoffStreamId(envelope.source_record_id, envelope.source_revision);
    return events.withStreamLock(streamId, async () => {
      const prior = await receiptForStream(events, streamId);
      if (prior) {
        if (prior.request_digest !== requestDigest) {
          throw new SwitchboardHandoffError(
            "handoff request conflicts with the retained source-revision receipt",
            "conflict",
            409,
          );
        }
        return prior;
      }
      const response = await postEnvelope({ fetchImpl, baseUrl, token, envelope, timeoutMs });
      const admission = requireAdmission(response, envelope);
      const receipt = receiptFromAdmission({ envelope, requestDigest, admission });
      await events.appendEvent({
        event_type: RECEIPT_EVENT,
        event_schema_version: 1,
        stream_id: streamId,
        actor: { kind: "gateway", id: "switchboard-handoff" },
        authority: { boundary: "external-intent", execution: "user_confirmed" },
        correlation_id: envelope.source_record_id,
        idempotency_key: `switchboard-receipt:${requestDigest}`,
        payload: receipt,
      });
      return receipt;
    });
  }

  return Object.freeze({ handoffCaptureBlock });
}

function captureBlockEnvelope(input) {
  const block = input.captureBlock;
  if (!block || typeof block !== "object") throw validation("capture block is required");
  const sourceId = requireText(block.id, "capture block id", 160);
  if (Number(block.schema_version) === 2) return audioCaptureBlockEnvelope(input, block, sourceId);
  if (block.schema_version != null && Number(block.schema_version) !== 1) {
    throw validation("capture block schema version is unsupported");
  }
  const exactText = requireText(block.literal_transcript, "capture block literal transcript", 1024 * 1024, false);
  const textDigest = digest(exactText);
  const sourceHash = `sha256:${textDigest}`;
  const sourceRevision = `capture-block-v1:${textDigest}`;
  return withConfirmedGoal(input, {
    contract_version: CONTRACT_VERSION,
    source_system: SOURCE_SYSTEM,
    source_record_id: sourceId,
    source_revision: sourceRevision,
    source_hash: sourceHash,
    exact_text: exactText,
    evidence_refs: captureEvidenceRefs(block),
    context_refs: boundedRefs(input.context_refs, "context_refs"),
    project_hint: optionalText(input.project_hint, 160),
    authority: "execute",
    idempotency_key: `${SOURCE_SYSTEM}:${sourceId}:${textDigest}`,
  });
}

function audioCaptureBlockEnvelope(input, block, sourceId) {
  if (block.source?.kind !== "audio_note") throw validation("schema-v2 capture block must be audio-note backed");
  if (block.processing_state !== "transcribed" || block.transcript?.state !== "transcribed") {
    throw validation("audio-backed capture block must be transcribed before handoff");
  }
  const exactText = requireText(
    block.transcript.literal,
    "capture block transcript literal",
    1024 * 1024,
    false,
  );
  const resultId = requireText(block.transcript.result_id, "transcript result id", 160);
  const provider = transcriptProviderEvidence(block.transcript.provider);
  const audioNoteId = requireText(block.audio?.audio_note_id, "audio note id", 160);
  const sourceAudioNoteId = requireText(block.source.audio_note_id, "source audio note id", 160);
  if (sourceAudioNoteId !== audioNoteId) throw validation("capture block audio note identity is inconsistent");
  const binding = {
    audio_note_id: audioNoteId,
    literal: exactText,
    provider,
    result_id: resultId,
  };
  const revisionDigest = digest(canonicalJson(binding));
  return withConfirmedGoal(input, {
    contract_version: CONTRACT_VERSION,
    source_system: SOURCE_SYSTEM,
    source_record_id: sourceId,
    source_revision: `capture-block-v2:${revisionDigest}`,
    source_hash: `sha256:${revisionDigest}`,
    exact_text: exactText,
    evidence_refs: [
      { type: "capture_block", id: sourceId },
      { type: "audio_note", id: audioNoteId },
      { type: "transcript_result", id: resultId, provider },
    ],
    context_refs: boundedRefs(input.context_refs, "context_refs"),
    project_hint: optionalText(input.project_hint, 160),
    authority: "execute",
    idempotency_key: `${SOURCE_SYSTEM}:${sourceId}:${revisionDigest}`,
  });
}

function withConfirmedGoal(input, envelope) {
  const hasOutcome = input.desired_outcome != null;
  const hasCriteria = input.acceptance_criteria != null;
  if (!hasOutcome && !hasCriteria) return envelope;
  if (!hasOutcome || !hasCriteria) throw validation(
    "desired outcome and acceptance criteria must be confirmed together",
  );
  return {
    ...envelope,
    contract_version: GOAL_CONTRACT_VERSION,
    desired_outcome: requireCharacters(
      input.desired_outcome,
      "desired outcome",
      MAX_DESIRED_OUTCOME_CHARS,
    ),
    acceptance_criteria: acceptanceCriteria(input.acceptance_criteria),
  };
}

function acceptanceCriteria(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ACCEPTANCE_CRITERIA) {
    throw validation("acceptance criteria must contain 1 to 32 items");
  }
  const seen = new Set();
  const criteria = [];
  for (const item of value) {
    const criterion = requireCharacters(
      item,
      "acceptance criterion",
      MAX_ACCEPTANCE_CRITERION_CHARS,
    );
    if (seen.has(criterion)) continue;
    seen.add(criterion);
    criteria.push(criterion);
  }
  if (!criteria.length) throw validation("acceptance criteria must not be empty");
  return criteria;
}

function transcriptProviderEvidence(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw validation("transcript provider evidence is required");
  }
  return {
    id: requireText(value.id, "transcript provider id", 120),
    model: optionalText(value.model, 160),
    request_id: optionalText(value.request_id, 160),
  };
}

function captureEvidenceRefs(block) {
  const refs = [{ type: "capture_block", id: block.id }];
  if (block.audio?.storage_ref) refs.push({ type: "audio", id: String(block.audio.storage_ref) });
  return refs;
}

function requireExecuteConfirmation(input) {
  if (input.confirmed !== true) throw validation("explicit user confirmation is required");
  if (input.authority !== "execute") throw new SwitchboardHandoffError(
    "handoff requires authority='execute'",
    "forbidden",
    403,
  );
}

async function postEnvelope({ fetchImpl, baseUrl, token, envelope, timeoutMs }) {
  const controller = new AbortController();
  let timeout;
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new SwitchboardHandoffError("Agent Switchboard timed out", "upstream", 502));
    }, timeoutMs);
  });
  let response;
  try {
    response = await Promise.race([fetchImpl(`${baseUrl}/api/v1/external-intents`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(envelope),
      signal: controller.signal,
    }), deadline]);
  } catch (error) {
    clearTimeout(timeout);
    if (error instanceof SwitchboardHandoffError) throw error;
    throw new SwitchboardHandoffError("Agent Switchboard is unreachable", "upstream", 502);
  }
  let body;
  try {
    if (!response.ok) throw new SwitchboardHandoffError(
      `Agent Switchboard rejected the handoff (${response.status})`,
      "upstream",
      502,
    );
    body = await Promise.race([response.json(), deadline]);
    return body;
  } catch (error) {
    if (error instanceof SwitchboardHandoffError) throw error;
    throw new SwitchboardHandoffError("Switchboard returned an invalid receipt", "upstream", 502);
  } finally {
    clearTimeout(timeout);
  }
}

function requireAdmission(response, envelope) {
  const admission = response?.admission;
  if (!admission || typeof admission !== "object") throw upstream("Switchboard returned no admission receipt");
  if (admission.contractVersion !== envelope.contract_version
      || admission.sourceSystem !== SOURCE_SYSTEM
      || admission.sourceRecordId !== envelope.source_record_id
      || admission.sourceRevision !== envelope.source_revision
      || admission.sourceHash !== envelope.source_hash
      || admission.authority !== "execute"
      || admission.idempotencyKey !== envelope.idempotency_key
      || admission.exactText !== envelope.exact_text
      || canonicalJson(admission.evidenceRefs) !== canonicalJson(envelope.evidence_refs)
      || canonicalJson(admission.contextRefs) !== canonicalJson(envelope.context_refs)
      || (admission.projectHint ?? null) !== envelope.project_hint
      || (envelope.contract_version === GOAL_CONTRACT_VERSION
        && (admission.desiredOutcome !== envelope.desired_outcome
          || canonicalJson(admission.acceptanceCriteria) !== canonicalJson(envelope.acceptance_criteria)))) {
    throw upstream("Switchboard returned a mismatched admission receipt");
  }
  return admission;
}

function receiptFromAdmission({ envelope, requestDigest, admission }) {
  if (!Array.isArray(admission.compiledIntents)) throw upstream("Switchboard returned invalid compiled intent identities");
  return {
    schema_version: envelope.contract_version,
    contract_version: envelope.contract_version,
    source_system: SOURCE_SYSTEM,
    source_record_id: envelope.source_record_id,
    source_revision: envelope.source_revision,
    source_hash: envelope.source_hash,
    request_digest: requestDigest,
    idempotency_key: envelope.idempotency_key,
    ...(envelope.contract_version === GOAL_CONTRACT_VERSION ? {
      desired_outcome: requireUpstreamCharacters(
        admission.desiredOutcome,
        "desired outcome",
        MAX_DESIRED_OUTCOME_CHARS,
      ),
      acceptance_criteria: requireUpstreamCriteria(admission.acceptanceCriteria),
    } : {}),
    switchboard: {
      admission_id: requireUpstreamText(admission.id, "admission id", 160),
      raw_intent_id: optionalUpstreamText(admission.rawIntentId, "raw intent id", 160),
      message_id: optionalUpstreamText(admission.messageId, "message id", 160),
      compiled_intent_ids: admission.compiledIntents.map((item) => requireUpstreamText(
        item?.intentId || item?.intent_id || item?.id,
        "compiled intent id",
        160,
      )),
      state: optionalUpstreamText(admission.state, "admission state", 80),
    },
  };
}

function requireUpstreamCriteria(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ACCEPTANCE_CRITERIA) {
    throw upstream("Switchboard returned invalid acceptance criteria");
  }
  return value.map((item) => requireUpstreamCharacters(
    item,
    "acceptance criterion",
    MAX_ACCEPTANCE_CRITERION_CHARS,
  ));
}

async function receiptForStream(events, streamId) {
  const rows = await events.listEvents({ stream_id: streamId, event_type: RECEIPT_EVENT, order: "asc", limit: 1 });
  return rows[0]?.payload || null;
}

function handoffStreamId(sourceId, revision) {
  return `capture-handoff:${digest(`${sourceId}\0${revision}`)}`;
}

function boundedRefs(value, field) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > MAX_REFS) throw validation(`${field} must be a bounded array`);
  const normalized = value.map((item) => normalizeOpaqueRef(item, field, 0));
  if (Buffer.byteLength(canonicalJson(normalized), "utf8") > MAX_REF_BYTES) {
    throw validation(`${field} is too large`);
  }
  return normalized;
}

function normalizeOpaqueRef(value, field, depth) {
  if (depth > 6) throw validation(`${field} is too deeply nested`);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return requireText(value, `${field} text`, 2_000);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (value.length > MAX_REFS) throw validation(`${field} contains an oversized array`);
    return value.map((item) => normalizeOpaqueRef(item, field, depth + 1));
  }
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const keys = Object.keys(value);
    if (keys.length > 30) throw validation(`${field} contains an oversized object`);
    return Object.fromEntries(keys.map((key) => [
      requireText(key, `${field} key`, 80),
      normalizeOpaqueRef(value[key], field, depth + 1),
    ]));
  }
  throw validation(`${field} contains unsupported data`);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function digest(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function requireText(value, field, max, trim = true) {
  if (typeof value !== "string") throw validation(`${field} is required`);
  const result = trim ? value.trim() : value;
  if (!result || Buffer.byteLength(result, "utf8") > max) throw validation(`${field} is invalid`);
  return result;
}

function requireCharacters(value, field, max) {
  if (typeof value !== "string") throw validation(`${field} is required`);
  const result = value.trim();
  if (!result || [...result].length > max) throw validation(`${field} is invalid`);
  return result;
}

function optionalText(value, max) {
  if (value == null || value === "") return null;
  return requireText(String(value), "optional text", max);
}

function requireUpstreamText(value, field, max) {
  if (typeof value !== "string") throw upstream(`Switchboard returned invalid ${field}`);
  const result = value.trim();
  if (!result || Buffer.byteLength(result, "utf8") > max) throw upstream(`Switchboard returned invalid ${field}`);
  return result;
}

function optionalUpstreamText(value, field, max) {
  if (value == null || value === "") return null;
  return requireUpstreamText(value, field, max);
}

function requireUpstreamCharacters(value, field, max) {
  if (typeof value !== "string") throw upstream(`Switchboard returned invalid ${field}`);
  const result = value.trim();
  if (!result || [...result].length > max) throw upstream(`Switchboard returned invalid ${field}`);
  return result;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function validation(message) {
  return new SwitchboardHandoffError(message, "validation", 400);
}

function upstream(message) {
  return new SwitchboardHandoffError(message, "upstream", 502);
}

module.exports = {
  CONTRACT_VERSION,
  GOAL_CONTRACT_VERSION,
  RECEIPT_EVENT,
  SwitchboardHandoffError,
  canonicalJson,
  captureBlockEnvelope,
  createSwitchboardHandoffService,
  handoffStreamId,
};
