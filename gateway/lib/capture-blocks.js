"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const REVISION_KINDS = new Set(["user_edit", "writing_skill", "summary", "coach_feedback"]);

function createCaptureBlockStore(options = {}) {
  const blocksDir = path.join(path.resolve(options.dataDir || "./data"), "capture-blocks");
  const now = typeof options.now === "function" ? options.now : () => new Date().toISOString();
  const createId = typeof options.createId === "function"
    ? options.createId
    : (prefix) => `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(6).toString("hex")}`;
  fs.mkdirSync(blocksDir, { recursive: true });

  function create(input = {}) {
    const idempotencyKey = requiredToken(input.idempotency_key, "idempotency_key", 160);
    const existing = readAll().find((block) => block.create_idempotency_key === idempotencyKey);
    if (existing) {
      assertSameCreate(existing, input);
      return clone(existing);
    }
    const audioNote = normalizeAudioNote(input.audio_note);
    const timestamp = now();
    const block = {
      version: "moa.capture-block.v1",
      id: requiredToken(createId("capture"), "generated capture id", 160),
      create_idempotency_key: idempotencyKey,
      owner_id: cleanToken(input.owner_id, 160),
      session_id: cleanToken(input.session_id, 160),
      source_surface: cleanToken(input.source_surface, 80),
      created_at: timestamp,
      updated_at: timestamp,
      audio_note: audioNote,
      input_languages: normalizeLanguages(input.input_languages),
      transcription: {
        state: "queued",
        attempt: 0,
        retry_count: 0,
        claim_id: null,
        provider: null,
        literal_transcript: null,
        language_evidence: null,
        failure: null,
      },
      revisions: [],
      tombstone: null,
      operations: {},
      events: [{ type: "capture.created", at: timestamp }],
    };
    write(block);
    return clone(block);
  }

  function detail(id) {
    const block = read(id);
    return block ? clone(block) : null;
  }

  function claim(id, input = {}) {
    const block = requiredBlock(id);
    const claimId = requiredToken(input.claim_id, "claim_id", 160);
    if (block.transcription.state === "transcribed" && block.transcription.claim_id === claimId) {
      return clone(block);
    }
    assertActive(block);
    if (block.transcription.state === "transcribing" && block.transcription.claim_id === claimId) {
      return clone(block);
    }
    if (block.transcription.state !== "queued") {
      throw conflict(`capture cannot be claimed from ${block.transcription.state}`);
    }
    block.transcription.state = "transcribing";
    block.transcription.attempt += 1;
    block.transcription.claim_id = claimId;
    block.transcription.provider = cleanToken(input.provider, 120) || null;
    block.transcription.failure = null;
    appendEvent(block, now(), "transcription.claimed", { claim_id: claimId });
    write(block);
    return clone(block);
  }

  function recordResult(id, input = {}) {
    const block = requiredBlock(id);
    const claimId = requiredToken(input.claim_id, "claim_id", 160);
    const transcript = cleanTranscript(input.literal_transcript);
    if (block.transcription.state === "transcribed") {
      if (block.transcription.claim_id === claimId && block.transcription.literal_transcript === transcript) {
        return clone(block);
      }
      throw conflict("literal transcript is immutable");
    }
    assertMatchingClaim(block, claimId);
    block.transcription.state = "transcribed";
    block.transcription.literal_transcript = transcript;
    block.transcription.provider = cleanToken(input.provider, 120) || block.transcription.provider;
    block.transcription.language_evidence = normalizeLanguageEvidence(input.language_evidence);
    block.transcription.failure = null;
    appendEvent(block, now(), "transcription.succeeded", { claim_id: claimId });
    write(block);
    return clone(block);
  }

  function recordFailure(id, input = {}) {
    const block = requiredBlock(id);
    const claimId = requiredToken(input.claim_id, "claim_id", 160);
    const failure = normalizeFailure(input.error);
    if (block.transcription.state === "failed" && block.transcription.claim_id === claimId) {
      return clone(block);
    }
    assertMatchingClaim(block, claimId);
    block.transcription.state = "failed";
    block.transcription.failure = failure;
    appendEvent(block, now(), "transcription.failed", { claim_id: claimId, code: failure.code });
    write(block);
    return clone(block);
  }

  function retry(id, input = {}) {
    const block = requiredBlock(id);
    assertActive(block);
    const key = requiredToken(input.idempotency_key, "idempotency_key", 160);
    if (block.operations[key] === "transcription.retry") return clone(block);
    if (block.transcription.state !== "failed") {
      throw conflict(`capture cannot be retried from ${block.transcription.state}`);
    }
    block.operations[key] = "transcription.retry";
    block.transcription.state = "queued";
    block.transcription.retry_count += 1;
    block.transcription.claim_id = null;
    block.transcription.provider = null;
    block.transcription.failure = null;
    appendEvent(block, now(), "transcription.retried", {});
    write(block);
    return clone(block);
  }

  function addRevision(id, input = {}) {
    const block = requiredBlock(id);
    assertActive(block);
    if (block.transcription.state !== "transcribed") {
      throw conflict("a revision requires a literal transcript");
    }
    const key = requiredToken(input.idempotency_key, "idempotency_key", 160);
    const priorId = block.operations[key];
    if (priorId) return clone(block.revisions.find((revision) => revision.id === priorId));
    const kind = cleanToken(input.kind, 40);
    if (!REVISION_KINDS.has(kind)) throw invalid("unsupported revision kind");
    const parentRevisionId = input.parent_revision_id == null
      ? "literal"
      : requiredToken(input.parent_revision_id, "parent_revision_id", 160);
    if (parentRevisionId !== "literal" && !block.revisions.some((revision) => revision.id === parentRevisionId)) {
      throw invalid("parent revision not found");
    }
    const revision = {
      id: requiredToken(createId("revision"), "generated revision id", 160),
      kind,
      parent_revision_id: parentRevisionId,
      text: cleanTranscript(input.text),
      created_at: now(),
      provenance: normalizeProvenance(input.provenance),
    };
    block.revisions.push(revision);
    block.operations[key] = revision.id;
    appendEvent(block, revision.created_at, "revision.created", { revision_id: revision.id, kind });
    write(block);
    return clone(revision);
  }

  function tombstone(id, input = {}) {
    const block = requiredBlock(id);
    const key = requiredToken(input.idempotency_key, "idempotency_key", 160);
    if (block.tombstone) {
      if (block.operations[key] === "capture.tombstoned") return clone(block);
      throw conflict("capture is already tombstoned");
    }
    const timestamp = now();
    block.tombstone = { at: timestamp, reason: cleanText(input.reason, 240) || "user_requested" };
    block.operations[key] = "capture.tombstoned";
    block.transcription.state = "tombstoned";
    appendEvent(block, timestamp, "capture.tombstoned", {});
    write(block);
    return clone(block);
  }

  function read(id) {
    const safeId = cleanToken(id, 160);
    if (!safeId) return null;
    return readFile(path.join(blocksDir, `${safeId}.json`));
  }

  function readAll() {
    return fs.readdirSync(blocksDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => readFile(path.join(blocksDir, name)))
      .filter(Boolean);
  }

  function requiredBlock(id) {
    const block = read(id);
    if (!block) {
      const error = new Error("capture block not found");
      error.statusCode = 404;
      throw error;
    }
    return block;
  }

  function write(block) {
    const filePath = path.join(blocksDir, `${block.id}.json`);
    const temporary = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(block, null, 2));
    fs.renameSync(temporary, filePath);
  }

  return { blocksDir, create, detail, claim, recordResult, recordFailure, retry, addRevision, tombstone };
}

async function transcribeCaptureBlock(store, id, options = {}) {
  if (!options.stt || typeof options.stt.transcribe !== "function") {
    throw invalid("an STT stage with transcribe() is required");
  }
  const claimId = requiredToken(options.claim_id, "claim_id", 160);
  const claimed = store.claim(id, { claim_id: claimId, provider: options.stt.id });
  if (claimed.transcription.state === "transcribed") return claimed;
  try {
    const result = await options.stt.transcribe({
      audioNote: clone(claimed.audio_note),
      languageCodes: claimed.input_languages.slice(),
      signal: options.signal,
    });
    return store.recordResult(id, {
      claim_id: claimId,
      provider: options.stt.id,
      literal_transcript: result?.text,
      language_evidence: result?.language_evidence,
    });
  } catch (error) {
    store.recordFailure(id, { claim_id: claimId, error });
    throw error;
  }
}

function appendEvent(block, timestamp, type, detail) {
  block.updated_at = timestamp;
  block.events.push({ type, at: timestamp, ...detail });
}

function assertMatchingClaim(block, claimId) {
  if (block.transcription.state !== "transcribing" || block.transcription.claim_id !== claimId) {
    throw conflict("transcription claim does not match");
  }
}

function assertActive(block) {
  if (block.tombstone) {
    throw conflict("capture block is not mutable");
  }
}

function assertSameCreate(block, input) {
  const audioNote = normalizeAudioNote(input.audio_note);
  if (block.audio_note.id !== audioNote.id) throw conflict("idempotency key was reused for different audio");
}

function normalizeAudioNote(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("audio_note is required");
  return {
    id: requiredToken(value.id, "audio_note.id", 160),
    href: cleanText(value.href, 500) || null,
    content_type: cleanText(value.content_type, 160) || null,
    bytes: normalizeNonNegativeInteger(value.bytes),
  };
}

function normalizeLanguages(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) {
    throw invalid("input_languages must contain one or two explicit language codes");
  }
  const languages = value.map((item) => cleanText(item, 35));
  if (languages.some((item) => !/^[a-z]{2,3}(?:-[A-Z][A-Za-z0-9]{1,7})+$/.test(item))) {
    throw invalid("input_languages contains an invalid language code");
  }
  return [...new Set(languages)];
}

function normalizeLanguageEvidence(value) {
  if (value == null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("language evidence must be an object");
  return {
    code: cleanText(value.code, 35) || null,
    restricted_to: Array.isArray(value.restricted_to) ? value.restricted_to.map((item) => cleanText(item, 35)).slice(0, 2) : [],
  };
}

function normalizeProvenance(value) {
  if (value == null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("provenance must be an object");
  return {
    actor: cleanToken(value.actor, 120) || null,
    skill_version: cleanText(value.skill_version, 120) || null,
    model: cleanText(value.model, 120) || null,
  };
}

function normalizeFailure(error) {
  return {
    code: cleanToken(error?.code, 80) || "stt_failed",
    message: cleanText(error?.message || error, 500) || "transcription failed",
  };
}

function normalizeNonNegativeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function cleanTranscript(value) {
  if (typeof value !== "string" || !value.trim()) throw invalid("transcript text is required");
  if (Buffer.byteLength(value, "utf8") > 1024 * 1024) throw invalid("transcript text is too large");
  return value;
}

function requiredToken(value, field, max) {
  const token = cleanToken(value, max);
  if (!token) throw invalid(`${field} is required`);
  return token;
}

function cleanToken(value, max) {
  return typeof value === "string" ? value.trim().replace(/[^a-zA-Z0-9_.:-]/g, "").slice(0, max) : "";
}

function cleanText(value, max) {
  return typeof value === "string" ? value.trim().replace(/[\r\n]+/g, " ").slice(0, max) : "";
}

function readFile(filePath) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return value && typeof value === "object" && cleanToken(value.id, 160) ? value : null;
  } catch {
    return null;
  }
}

function invalid(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function conflict(message) {
  const error = new Error(message);
  error.statusCode = 409;
  return error;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

module.exports = { createCaptureBlockStore, transcribeCaptureBlock, REVISION_KINDS };
