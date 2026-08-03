"use strict";

const crypto = require("node:crypto");
const { MAX_LITERAL_BYTES, requireCaptureBlockId } = require("./capture-blocks");
const { PROCESSING_EVENT, AudioCaptureBlockError } = require("./audio-capture-blocks");

const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_FAILURE_CHARS = 500;

function createAudioCaptureTranscriptionService({ events, captureBlocks, clock = () => new Date(),
  leaseMs = DEFAULT_LEASE_MS, maxAttempts = DEFAULT_MAX_ATTEMPTS } = {}) {
  if (!events?.appendEvent || !events?.withStreamLock || !captureBlocks?.get) {
    throw new Error("capture transcription requires locked events and capture blocks");
  }
  const leaseDuration = boundedInteger(leaseMs, "lease_ms", 1_000, 15 * 60_000);
  const attemptLimit = boundedInteger(maxAttempts, "max_attempts", 1, 20);

  async function claim(input = {}) {
    const blockId = requireCaptureBlockId(input.capture_block_id);
    const workerId = requireToken(input.worker_id, "worker_id", 160);
    const languageProfile = normalizeLanguageProfile(input.language_profile);
    const providerId = requireToken(input.provider_id, "provider_id", 120);
    return transition(blockId, async (block) => {
      let current = block;
      if (current.processing_state === "transcribing") {
        const active = current.processing_claim;
        if (Date.parse(active?.lease_expires_at || "") <= clockMs(clock)) {
          const failedAt = isoNow(clock);
          const retryable = active.attempt + 1 < attemptLimit;
          await appendTransition(events, current, {
            from_state: "transcribing", to_state: "failed", attempt: active.attempt,
            retryable, created_at: failedAt, claim_id: active.id,
            failure: { code: "lease_expired", message: "transcription worker lease expired", retryable },
          }, `capture:${blockId}:transcription:failed:${active.id}`);
          current = await captureBlocks.get(blockId);
          if (!retryable) throw conflict("capture block has no retry attempts remaining");
          const recoveredAttempt = active.attempt + 1;
          await appendTransition(events, current, {
            from_state: "failed", to_state: "queued", attempt: recoveredAttempt,
            retryable: true, created_at: isoNow(clock),
          }, `capture:${blockId}:transcription:retry:${recoveredAttempt}`);
          current = await captureBlocks.get(blockId);
        }
      }
      if (current.processing_state === "transcribing") {
        const active = current.processing_claim;
        if (active?.worker_id === workerId && active?.attempt === current.retry_count
          && active?.provider_id === providerId && active?.language_profile?.digest === languageProfile.digest) {
          return { block: current, claim: active, claimed: false };
        }
        throw conflict("capture block already has an active transcription lease");
      }
      if (current.processing_state !== "queued") throw conflict("capture block is not queued for transcription");
      const attempt = current.retry_count;
      const claimedAt = isoNow(clock);
      const claimId = `claim_${digest(`${blockId}\0${attempt}\0${workerId}\0${providerId}\0${languageProfile.digest}`)}`;
      const claimRecord = {
        schema_version: 1,
        id: claimId,
        capture_block_id: blockId,
        audio_note_id: current.audio.audio_note_id,
        worker_id: workerId,
        provider_id: providerId,
        language_profile: languageProfile,
        attempt,
        claimed_at: claimedAt,
        lease_expires_at: new Date(Date.parse(claimedAt) + leaseDuration).toISOString(),
      };
      await appendTransition(events, current, {
        from_state: "queued", to_state: "transcribing", attempt, retryable: true,
        created_at: claimedAt, claim: claimRecord,
      }, `capture:${blockId}:transcription:claim:${attempt}`);
      return { block: await captureBlocks.get(blockId), claim: claimRecord, claimed: true };
    });
  }

  async function complete(input = {}) {
    const literal = exactLiteral(input.literal);
    return finish(input, "transcribed", {
      result: {
        schema_version: 1,
        id: `literal_${digest(`${input.claim_id || ""}\0${literal}`)}`,
        literal,
        provider: normalizeProviderEvidence(input.provider),
        language_evidence: normalizeLanguageEvidence(input.language_evidence),
      },
    });
  }

  async function fail(input = {}) {
    return finish(input, "failed", {
      failure: {
        code: cleanText(input.code || "transcription_failed", 120),
        message: cleanText(input.message || "transcription failed", MAX_FAILURE_CHARS),
        retryable: input.retryable !== false,
      },
    });
  }

  async function finish(input, toState, extra) {
    const blockId = requireCaptureBlockId(input.capture_block_id);
    const claimId = requireToken(input.claim_id, "claim_id", 160);
    return transition(blockId, async (block) => {
      const claimRecord = block.processing_claim;
      if (block.processing_state === toState && block.last_claim_id === claimId) {
        const terminal = [...(block.processing_events || [])].reverse()
          .find((event) => event.to_state === toState && event.claim_id === claimId);
        const exactRetry = toState === "transcribed"
          ? sameJson(terminal?.result, extra.result)
          : sameJson(terminal?.failure, extra.failure);
        if (!exactRetry) throw conflict("transcription terminal result conflicts with the recorded claim result");
        return block;
      }
      if (block.processing_state !== "transcribing" || claimRecord?.id !== claimId) {
        throw conflict("transcription claim is not current");
      }
      const createdAt = isoNow(clock);
      const retryable = toState === "failed"
        && extra.failure.retryable && claimRecord.attempt + 1 < attemptLimit;
      await appendTransition(events, block, {
        from_state: "transcribing", to_state: toState, attempt: claimRecord.attempt,
        retryable, created_at: createdAt, claim_id: claimId, ...extra,
      }, `capture:${blockId}:transcription:${toState}:${claimId}`);
      return captureBlocks.get(blockId);
    });
  }

  async function retry(input = {}) {
    const blockId = requireCaptureBlockId(input.capture_block_id);
    return transition(blockId, async (block) => {
      if (block.processing_state === "queued") {
        const latest = block.processing_events?.at(-1);
        if (latest?.from_state === "failed") return block;
        throw conflict("capture block is not in failed transcription state");
      }
      if (block.processing_state !== "failed") throw conflict("capture block is not in failed transcription state");
      if (block.failure?.retryable !== true || block.retry_count + 1 >= attemptLimit) {
        throw conflict("capture block has no retry attempts remaining");
      }
      const attempt = block.retry_count + 1;
      const createdAt = isoNow(clock);
      await appendTransition(events, block, {
        from_state: "failed", to_state: "queued", attempt, retryable: true, created_at: createdAt,
      }, `capture:${blockId}:transcription:retry:${attempt}`);
      return captureBlocks.get(blockId);
    });
  }

  function transition(blockId, action) {
    return events.withStreamLock(`capture-block:${blockId}`, async () => {
      const block = await captureBlocks.get(blockId);
      if (!block) throw new AudioCaptureBlockError("capture block not found", "not_found", 404);
      if (block.schema_version !== 2 || block.source?.kind !== "audio_note") {
        throw conflict("capture block is not audio-note backed");
      }
      return action(block);
    });
  }

  return Object.freeze({ claim, complete, fail, retry, max_attempts: attemptLimit });
}

function createAudioCaptureTranscriptionWorker({ service, audioNotes, transcriberForClaim,
  languageProfileForBlock, providerIdForBlock, providerRegistry,
  workerId = "capture-transcription-worker" } = {}) {
  if (!service?.claim || !service?.complete || !service?.fail || !audioNotes?.stream
    || typeof transcriberForClaim !== "function") {
    throw new Error("capture transcription worker requires service, audio notes, and a transcriber factory");
  }
  async function processBlock(captureBlockId) {
    const languageProfile = await valueFor(languageProfileForBlock, captureBlockId, { languages: ["en-US"] });
    const providerId = typeof providerIdForBlock === "function"
      ? await providerIdForBlock(captureBlockId)
      : selectedSttProviderId(providerRegistry);
    const claimed = await service.claim({
      capture_block_id: captureBlockId, worker_id: workerId, language_profile: languageProfile,
      provider_id: providerId,
    });
    // An exact duplicate means this worker identity already owns an active
    // lease. Do not repeat paid provider work; the original call or lease
    // expiry remains authoritative.
    if (!claimed.claimed) return claimed.block;
    const claim = claimed.claim;
    let audio = null;
    let output;
    try {
      // Source media is intentionally resolved only after the durable claim.
      audio = await audioNotes.stream(claim.audio_note_id);
      if (!audio) throw Object.assign(new Error("retained audio is unavailable"), { code: "audio_unavailable" });
      const transcriber = await transcriberForClaim(claim);
      if (!transcriber || typeof transcriber.transcribe !== "function") {
        throw Object.assign(new Error("configured STT provider is unavailable"), {
          code: "provider_unavailable", retryable: false,
        });
      }
      output = await transcriber.transcribe({ audio, claim });
    } catch (error) {
      return service.fail({
        capture_block_id: captureBlockId, claim_id: claim.id,
        code: error?.code || "transcription_failed", message: error?.message, retryable: error?.retryable !== false,
      });
    } finally {
      await closeReadable(audio?.stream);
    }
    // Terminal state conflicts are fencing failures, not provider failures.
    // Let them surface without trying to rewrite the same claim as failed.
    return service.complete({
      capture_block_id: captureBlockId, claim_id: claim.id, literal: output?.text,
      provider: output?.provider || { id: claim.provider_id },
      language_evidence: output?.language_evidence || claim.language_profile.languages,
    });
  }
  return Object.freeze({ processBlock });
}

async function appendTransition(events, block, payload, idempotencyKey) {
  return events.appendEvent({
    event_type: PROCESSING_EVENT,
    event_schema_version: 1,
    stream_id: `capture-block:${block.id}`,
    occurred_at: payload.created_at,
    actor: { kind: "gateway", id: payload.claim?.worker_id || "capture-transcription-worker" },
    authority: { boundary: "capture-block", execution: "transcription_only" },
    causation_id: payload.claim_id || payload.claim?.id || block.audio.audio_note_id,
    correlation_id: block.audio.audio_note_id,
    idempotency_key: idempotencyKey,
    payload: {
      schema_version: 1,
      id: `proc_${digest(idempotencyKey)}`,
      capture_block_id: block.id,
      phase: "transcription",
      audio_note_id: block.audio.audio_note_id,
      ...payload,
    },
  });
}

function normalizeLanguageProfile(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AudioCaptureBlockError("language_profile must be an object");
  }
  const languages = [...new Set((Array.isArray(value.languages) ? value.languages : [])
    .map((item) => cleanText(item, 40)).filter(Boolean))].slice(0, 8);
  if (!languages.length) throw new AudioCaptureBlockError("language_profile.languages is required");
  const primary = cleanText(value.primary || languages[0], 40);
  if (!languages.includes(primary)) throw new AudioCaptureBlockError("language_profile.primary must be in languages");
  const version = cleanText(value.version || "effective-v1", 120);
  const stable = { version, languages, primary };
  return { ...stable, digest: `sha256:${digest(JSON.stringify(stable))}` };
}

function normalizeProviderEvidence(value) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return { id: cleanText(input.id, 120), model: cleanText(input.model, 160), request_id: cleanText(input.request_id, 160) };
}

function normalizeLanguageEvidence(value) {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => cleanText(item, 40)).filter(Boolean))].slice(0, 8);
}

function exactLiteral(value) {
  const literal = String(value ?? "");
  if (!literal.trim()) throw new AudioCaptureBlockError("literal transcript is required");
  if (Buffer.byteLength(literal, "utf8") > MAX_LITERAL_BYTES) {
    throw new AudioCaptureBlockError(`literal transcript exceeds ${MAX_LITERAL_BYTES} UTF-8 bytes`);
  }
  return literal;
}

function conflict(message) { return new AudioCaptureBlockError(message, "conflict", 409); }
function isoNow(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("clock returned an invalid date");
  return date.toISOString();
}
function clockMs(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("clock returned an invalid date");
  return date.getTime();
}
function requireToken(value, field, max) {
  const token = cleanText(value, max);
  if (!token || !/^[A-Za-z0-9._:-]+$/.test(token)) throw new AudioCaptureBlockError(`${field} is invalid`);
  return token;
}
function cleanText(value, max) { return String(value || "").replace(/[\r\n]+/g, " ").trim().slice(0, max); }
function boundedInteger(value, field, min, max) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new AudioCaptureBlockError(`${field} must be an integer between ${min} and ${max}`);
  }
  return number;
}
function digest(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function sameJson(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
async function valueFor(resolver, id, fallback) {
  return typeof resolver === "function" ? resolver(id) : fallback;
}
function selectedSttProviderId(registry) {
  const providerId = cleanText(registry?.selected_providers?.stt, 120);
  if (!providerId) throw new AudioCaptureBlockError("configured STT provider is unavailable", "provider_unavailable", 503);
  return requireToken(providerId, "provider_id", 120);
}
async function closeReadable(stream) {
  if (!stream || typeof stream.destroy !== "function" || stream.destroyed) return;
  await new Promise((resolve) => {
    stream.once("close", resolve);
    stream.once("error", resolve);
    stream.destroy();
  });
}

module.exports = {
  DEFAULT_LEASE_MS,
  DEFAULT_MAX_ATTEMPTS,
  MAX_FAILURE_CHARS,
  createAudioCaptureTranscriptionService,
  createAudioCaptureTranscriptionWorker,
  normalizeLanguageProfile,
  selectedSttProviderId,
};
