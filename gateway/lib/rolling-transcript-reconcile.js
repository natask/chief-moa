"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_MAX_ACTIVE = 2;
const DEFAULT_MAX_ACTIVE_PER_OWNER = 1;
const DEFAULT_MAX_READY = 8;
const DEFAULT_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_TURN_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_SPANS_PER_TURN = 64;
const DEFAULT_MIN_SPAN_MS = 20000;

function createRollingTranscriptReconcileRuntime(options = {}) {
  const dataRoot = path.resolve(options.dataDir || "./data");
  const root = path.join(dataRoot, "voice-transcript-reconcile");
  const maxActive = positiveInt(options.maxActive, DEFAULT_MAX_ACTIVE);
  const maxActivePerOwner = positiveInt(options.maxActivePerOwner, DEFAULT_MAX_ACTIVE_PER_OWNER);
  const maxReady = positiveInt(options.maxReady, DEFAULT_MAX_READY);
  const maxBufferBytes = positiveInt(options.maxBufferBytes, DEFAULT_MAX_BUFFER_BYTES);
  const maxTurnBytes = positiveInt(options.maxTurnBytes, DEFAULT_MAX_TURN_BYTES);
  const maxSpansPerTurn = positiveInt(options.maxSpansPerTurn, DEFAULT_MAX_SPANS_PER_TURN);
  const minSpanMs = positiveInt(options.minSpanMs, DEFAULT_MIN_SPAN_MS);
  const providerForJob = options.providerForJob;
  const onFinalRevision = options.onFinalRevision;
  const ready = [];
  const queued = new Set();
  const turns = new Map();
  const activeOwners = new Map();
  const enqueueEnabled = options.enqueueEnabled !== false;
  const metrics = { paid_calls: 0, paid_audio_bytes: 0, retries: 0, completed: 0, failed: 0,
    invalid_audio: 0, deferred: 0, skipped_turn_limit: 0, last_span_latency_ms: 0,
    skipped_backpressure: 0, last_correction_latency_ms: 0 };
  let active = 0;
  fs.mkdirSync(root, { recursive: true });
  const recoveryFiles = walkStateFiles(root, 4);
  setImmediate(recoverPending);

  function createTurn(input) {
    if (!enqueueEnabled) return null;
    const identity = safeIdentity(input);
    const statePath = turnStatePath(root, identity);
    const persisted = readJson(statePath) || {};
    const state = {
      identity,
      statePath,
      authorized: true,
      startedAt: String(persisted.created_at || new Date().toISOString()),
      provider: input.provider,
      languageCodes: boundedCodes(input.languageCodes),
      format: normalizeFormat(input.format),
      emitPrefix: input.emitPrefix,
      snapshotTail: input.snapshotTail,
      chunks: [],
      bufferedBytes: 0,
      receivedBytes: Number(persisted.received_bytes || 0),
      sealedBytes: Number(persisted.sealed_bytes || 0),
      correctedText: String(persisted.corrected_text || ""),
      revision: Number(persisted.revision || 0),
      transcriptSequence: Number(persisted.transcript_sequence || 0),
      terminal: persisted.terminal === true,
      disabled: Boolean(persisted.reconcile_stopped),
      reconcileStopped: String(persisted.reconcile_stopped || ""),
      spans: Array.isArray(persisted.spans) ? persisted.spans : [],
      processing: false,
      canonicalReady: false,
    };
    turns.set(identityKey(identity), state);
    persistState(state);
    return {
      push(chunk) {
        if (state.terminal || !Buffer.isBuffer(chunk) || chunk.length === 0) return;
        if (state.disabled) { state.receivedBytes += chunk.length; return; }
        if (state.fileBackedTail) { state.receivedBytes += chunk.length; return; }
        state.chunks.push({ start: state.receivedBytes, chunk: Buffer.from(chunk) });
        state.receivedBytes += chunk.length;
        state.bufferedBytes += chunk.length;
        if (!state.reconcileStopped && (state.receivedBytes > maxTurnBytes || state.spans.length >= maxSpansPerTurn)) {
          state.disabled = true; state.reconcileStopped = "turn_limit";
          metrics.skipped_turn_limit += 1;
        }
        else if (state.bufferedBytes > maxBufferBytes) state.fileBackedTail = true;
      },
      seal(boundary) {
        if (state.terminal || state.disabled || state.fileBackedTail) return false;
        return sealSpan(state, frameOffset(boundary?.absolute_audio_byte_offset, state.format.frameBytes), false);
      },
      finish(input = {}) {
        if (state.terminal) return;
        const finalEnd = frameOffset(state.receivedBytes, state.format.frameBytes);
        if (!state.disabled && !state.fileBackedTail && outstandingCount() < maxReady) sealSpan(state, finalEnd, true);
        else if (!state.disabled && outstandingCount() < maxReady) materializeFileTail(state, input.pcmPath);
        else if (!state.disabled && finalEnd > state.sealedBytes) {
          state.disabled = true; state.reconcileStopped = "backpressure";
          metrics.skipped_backpressure += 1;
        }
        state.terminal = true;
        state.chunks = [];
        state.bufferedBytes = 0;
        persistState(state);
        schedule(state);
      },
      abandon() {
        deleteTurn(identity);
      },
    };
  }

  function sealSpan(state, requestedEnd, terminal) {
    const end = Math.min(state.receivedBytes, requestedEnd);
    if (!Number.isSafeInteger(end) || end <= state.sealedBytes) return false;
    const minimumBytes = Math.ceil(state.format.bytesPerSecond * minSpanMs / 1000 / state.format.frameBytes)
      * state.format.frameBytes;
    if (!terminal && end - state.sealedBytes < minimumBytes) return false;
    if (!terminal && outstandingCount() >= maxReady) { metrics.skipped_backpressure += 1; return false; }
    const pcm = sliceChunks(state.chunks, state.sealedBytes, end);
    if (pcm.length !== end - state.sealedBytes) return false;
    const span = {
      id: spanId(state.identity, state.sealedBytes, end),
      start_audio_byte: state.sealedBytes,
      end_audio_byte: end,
      status: "pending",
      terminal,
      language_codes: state.languageCodes,
      audio_sha256: sha256Buffer(pcm),
      created_at: new Date().toISOString(),
    };
    const pcmPath = spanPcmPath(root, state.identity, span.id);
    fs.mkdirSync(path.dirname(pcmPath), { recursive: true });
    writeExclusive(pcmPath, pcm);
    state.spans.push(span);
    state.sealedBytes = end;
    state.chunks = state.chunks.filter((entry) => entry.start + entry.chunk.length > end);
    state.bufferedBytes = state.chunks.reduce((sum, entry) => sum + entry.chunk.length, 0);
    persistState(state);
    schedule(state);
    return true;
  }

  function materializeFileTail(state, pcmPath, requestedEnd = state.receivedBytes) {
    const end = Math.min(state.receivedBytes, frameOffset(requestedEnd, state.format.frameBytes));
    if (!isSafeLocalPcmPath(dataRoot, pcmPath) || end <= state.sealedBytes) return;
    const span = {
      id: spanId(state.identity, state.sealedBytes, end), start_audio_byte: state.sealedBytes,
      end_audio_byte: end, status: "materializing", terminal: true,
      language_codes: state.languageCodes, source_pcm_path: String(pcmPath),
      source_generation: fileGeneration(pcmPath), created_at: new Date().toISOString(),
    };
    state.spans.push(span);
    state.sealedBytes = end;
    persistState(state);
    void materializeSpan(state, span);
  }

  function outstandingCount() {
    let count = 0;
    for (const state of turns.values()) {
      count += state.spans.filter((span) => ["pending", "claimed", "materializing"].includes(span.status)).length;
      if (state.deferredTail) count += 1;
    }
    return count;
  }

  function activateDeferredTails() {
    for (const state of turns.values()) {
      if (outstandingCount() >= maxReady) return;
      if (!state.deleted && state.deferredTail?.pcmPath) {
        const tail = state.deferredTail;
        state.deferredTail = null;
        materializeFileTail(state, tail.pcmPath, tail.end);
      }
    }
  }

  async function materializeSpan(state, span) {
    try {
      if (!jobAuthorized(state, "source_read", span) || !isSafeLocalPcmPath(dataRoot, span.source_pcm_path)
          || !sameGeneration(span.source_generation, fileGeneration(span.source_pcm_path))) {
        throw new Error("source_pcm_unavailable");
      }
      const target = spanPcmPath(root, state.identity, span.id);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      await copyRange(span.source_pcm_path, target, span.start_audio_byte, span.end_audio_byte);
      if (state.deleted) { try { fs.unlinkSync(target); } catch {} return; }
      span.status = "pending";
      span.audio_sha256 = await sha256File(target);
      delete span.source_pcm_path;
    } catch (error) {
      span.status = "failed";
      span.error = cleanError(error);
    }
    persistState(state);
    schedule(state);
  }

  function schedule(state) {
    if (state.deleted || !state.authorized) return;
    if (state.processing || queued.has(state.statePath)) return;
    if (!state.spans.some((span) => span.status === "pending")) {
      void maybeFinalize(state).finally(() => cleanupTerminalSpanAudio(state));
      return;
    }
    queued.add(state.statePath);
    ready.push(state);
    pump();
  }

  function pump() {
    while (active < maxActive && ready.length > 0) {
      const index = ready.findIndex((candidate) => (activeOwners.get(candidate.identity.ownerId) || 0) < maxActivePerOwner);
      if (index < 0) return;
      const [state] = ready.splice(index, 1);
      queued.delete(state.statePath);
      if (state.processing || state.deleted) continue;
      state.processing = true;
      active += 1;
      activeOwners.set(state.identity.ownerId, (activeOwners.get(state.identity.ownerId) || 0) + 1);
      void processNext(state).finally(() => {
        state.processing = false;
        active -= 1;
        const ownerActive = (activeOwners.get(state.identity.ownerId) || 1) - 1;
        if (ownerActive > 0) activeOwners.set(state.identity.ownerId, ownerActive);
        else activeOwners.delete(state.identity.ownerId);
        schedule(state);
        activateDeferredTails();
        pump();
      });
    }
  }

  async function processNext(state) {
    const span = state.spans.find((value) => value.status === "pending");
    if (!span) return;
    if (!jobAuthorized(state, "span_read", span)) return revokeState(state);
    const pcmPath = spanPcmPath(root, state.identity, span.id);
    if (!await verifySpanPcm(pcmPath, span)) {
      if (state.deleted) return;
      span.status = "invalid_audio"; span.error = "span_size_or_digest_mismatch";
      metrics.invalid_audio += 1;
      span.finished_at = new Date().toISOString();
      metrics.last_span_latency_ms = elapsedMs(span.created_at, span.finished_at);
      persistState(state); return;
    }
    if (!jobAuthorized(state, "provider_submit", span)) return revokeState(state);
    const now = new Date().toISOString();
    span.status = "claimed";
    span.claim_id = crypto.randomUUID();
    span.claimed_at = now;
    span.paid_attempts = 1;
    persistState(state); // durable before the paid provider call
    const provider = state.provider || (typeof providerForJob === "function" ? providerForJob() : null);
    if (!provider || typeof provider.transcribePcmWindowed !== "function") {
      span.status = "failed";
      metrics.failed += 1;
      span.error = "batch_stt_unavailable";
      span.finished_at = new Date().toISOString();
      metrics.last_span_latency_ms = elapsedMs(span.created_at, span.finished_at);
      persistState(state);
      return;
    }
    try {
      metrics.paid_calls += 1;
      metrics.paid_audio_bytes += span.end_audio_byte - span.start_audio_byte;
      const result = await provider.transcribePcmWindowed({
        turnId: state.identity.turnId,
        reconciliationRequestId: span.id,
        pcmPath,
        audioBytes: span.end_audio_byte - span.start_audio_byte,
        format: { encoding: "pcm16", sample_rate: state.format.sample_rate, channels: state.format.channels },
      }, span.language_codes);
      if (state.deleted) return;
      const transcript = String(result?.text || "").trim();
      span.status = transcript ? "completed" : "empty";
      if (transcript) metrics.completed += 1;
      span.transcript = transcript;
      span.windowed = result?.windowed === true;
      span.finished_at = new Date().toISOString();
      metrics.last_span_latency_ms = elapsedMs(span.created_at, span.finished_at);
      if (transcript) {
        state.correctedText = joinText(state.correctedText, transcript);
        state.revision += 1;
        if (typeof state.emitPrefix === "function") {
          const sequence = await state.emitPrefix({
            revision: state.revision,
            ownerId: state.identity.ownerId,
            finalizedText: state.correctedText,
            sealedThroughAudioByte: span.end_audio_byte,
          });
          state.transcriptSequence = Math.max(state.transcriptSequence, Number(sequence) || 0);
        }
      }
    } catch (error) {
      span.status = "failed";
      metrics.failed += 1;
      span.error = cleanError(error);
      span.finished_at = new Date().toISOString();
      metrics.last_span_latency_ms = elapsedMs(span.created_at, span.finished_at);
    }
    persistState(state);
  }

  async function maybeFinalize(state) {
    if (state.deleted) return;
    if (!state.terminal || !state.canonicalReady || state.sealedBytes !== state.receivedBytes) return;
    if (state.spans.some((span) => span.status !== "completed")) return;
    if (!state.correctedText.trim() || state.finalized_at) return;
    if (typeof onFinalRevision === "function") {
      const updatedAt = new Date().toISOString();
      const accepted = await onFinalRevision({
        ...state.identity,
        transcript: state.correctedText,
        reconciliationId: finalReconciliationId(state),
        expectedCurrentRevision: state.executionRevision || 0,
        transcriptSequence: state.transcriptSequence + 1,
        source: "automatic_reconcile",
        transcriptSource: "stt-auto-reconcile",
        updatedAt,
      });
      if (accepted === false) return;
      state.finalized_at = updatedAt;
      metrics.last_correction_latency_ms = elapsedMs(state.startedAt, updatedAt);
      persistState(state);
    }
  }

  function recoverPending() {
    let processed = 0, next;
    while (processed < 64 && !(next = recoveryFiles.next()).done) {
      const statePath = next.value;
      processed += 1;
      const persisted = readJson(statePath);
      if (!persisted?.session_id || !persisted?.turn_id || persisted.finalized_at) continue;
      const identity = safeIdentity({ ownerId: persisted.owner_id, sessionId: persisted.session_id,
        branchId: persisted.branch_id, turnId: persisted.turn_id });
      if (turns.has(identityKey(identity))) continue;
      const state = {
        identity, statePath, authorized: persisted.privacy_scope === "retained",
        startedAt: String(persisted.created_at || persisted.updated_at || new Date().toISOString()), provider: null,
        languageCodes: [], emitPrefix: null,
        format: normalizeFormat(persisted.format), deferredTail: persisted.deferred_tail || null,
        executionRevision: Number(persisted.execution_revision || 0),
        chunks: [], bufferedBytes: 0, receivedBytes: Number(persisted.received_bytes || 0),
        sealedBytes: Number(persisted.sealed_bytes || 0), correctedText: String(persisted.corrected_text || ""),
        revision: Number(persisted.revision || 0), terminal: persisted.terminal === true,
        disabled: Boolean(persisted.reconcile_stopped),
        transcriptSequence: Number(persisted.transcript_sequence || 0),
        spans: Array.isArray(persisted.spans) ? persisted.spans : [], processing: false,
        reconcileStopped: String(persisted.reconcile_stopped || ""),
        canonicalReady: typeof options.canonicalReadyForJob === "function"
          ? options.canonicalReadyForJob(identity) === true : false,
      };
      const projected = state.spans.filter((span) => ["pending", "claimed", "materializing"].includes(span.status)).length
        + (state.deferredTail ? 1 : 0);
      if (outstandingCount() + projected > maxReady) {
        state.reconcileStopped = "recovery_backpressure"; state.disabled = true; state.deferredTail = null;
        for (const span of state.spans) {
          if (["pending", "claimed", "materializing"].includes(span.status)) span.status = "backpressure_skipped";
        }
        metrics.skipped_backpressure += projected;
      }
      for (const span of state.spans) {
        if (!state.authorized && ["pending", "claimed", "materializing"].includes(span.status)) {
          span.status = "privacy_ineligible";
          span.error = "missing_retained_audio_authority";
          span.finished_at = new Date().toISOString();
        } else if (span.status === "claimed") {
          span.status = "abandoned_ambiguous";
          span.error = "process_restarted_after_paid_claim";
          span.finished_at = new Date().toISOString();
        }
      }
      turns.set(identityKey(identity), state);
      persistState(state);
      for (const span of state.spans.filter((value) => value.status === "materializing")) void materializeSpan(state, span);
      schedule(state);
    }
    activateDeferredTails();
    if (!next?.done) setImmediate(recoverPending);
  }

  function notifyCanonicalCommitted(identity) {
    const state = turns.get(identityKey(safeIdentity(identity)));
    if (!state) return;
    state.canonicalReady = true;
    state.executionRevision = typeof options.currentRevisionForJob === "function"
      ? Number(options.currentRevisionForJob(state.identity) || 0) : 0;
    state.transcriptSequence = Math.max(state.transcriptSequence,
      typeof options.currentSequenceForJob === "function" ? Number(options.currentSequenceForJob(state.identity) || 0) : 0);
    persistState(state);
    void maybeFinalize(state).finally(() => cleanupTerminalSpanAudio(state));
  }

  function deleteTurn(identityInput) {
    const identity = safeIdentity(identityInput);
    const state = turns.get(identityKey(identity));
    if (state) { state.deleted = true; state.terminal = true; state.disabled = true; }
    turns.delete(identityKey(identity));
    const dir = identityDir(root, identity);
    let entries;
    try { entries = fs.readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (name === `${identity.turnId}.json` || (name.startsWith(`${identity.turnId}.`) && name.endsWith(".pcm"))) {
        try { fs.unlinkSync(path.join(dir, name)); } catch { /* exact best-effort privacy cleanup */ }
      }
    }
  }

  function cleanupTerminalSpanAudio(state) {
    if (!state.terminal || state.deferredTail
        || state.spans.some((span) => ["pending", "claimed", "materializing"].includes(span.status))) return;
    for (const span of state.spans) {
      try { fs.unlinkSync(spanPcmPath(root, state.identity, span.id)); } catch { /* canonical retained audio owns recovery */ }
    }
    const cannotFinalize = state.reconcileStopped || state.sealedBytes !== state.receivedBytes
      || state.spans.some((span) => span.status !== "completed");
    if (state.deleted || state.finalized_at || cannotFinalize) turns.delete(identityKey(state.identity));
  }

  function jobAuthorized(state, phase, span) {
    if (state.deleted || !state.authorized) return false;
    return typeof options.authorizeJob !== "function"
      || options.authorizeJob(state.identity, { phase, canonicalReady: state.canonicalReady,
        sourceGeneration: span?.source_generation || null }) === true;
  }

  function revokeState(state) {
    state.authorized = false; state.disabled = true; state.reconcileStopped = "privacy_revoked";
    for (const span of state.spans) {
      if (["pending", "claimed", "materializing"].includes(span.status)) span.status = "privacy_ineligible";
    }
    persistState(state);
  }

  return {
    createTurn,
    deleteTurn,
    notifyCanonicalCommitted,
    status: () => ({ active, queued: ready.length, outstanding: outstandingCount(),
      enqueue_enabled: enqueueEnabled, max_active: maxActive, max_active_per_owner: maxActivePerOwner,
      max_ready: maxReady, max_turn_bytes: maxTurnBytes,
      max_spans_per_turn: maxSpansPerTurn, min_span_ms: minSpanMs, metrics: { ...metrics } }),
  };
}

function persistState(state) {
  const durable = {
    version: 1,
    owner_id: state.identity.ownerId,
    privacy_scope: "retained",
    created_at: state.startedAt,
    session_id: state.identity.sessionId,
    branch_id: state.identity.branchId,
    turn_id: state.identity.turnId,
    received_bytes: state.receivedBytes,
    sealed_bytes: state.sealedBytes,
    corrected_text: state.correctedText,
    revision: state.revision,
    transcript_sequence: state.transcriptSequence,
    format: state.format,
    deferred_tail: state.deferredTail || null,
    execution_revision: state.executionRevision || 0,
    reconcile_stopped: state.reconcileStopped || "",
    terminal: state.terminal,
    finalized_at: state.finalized_at || "",
    spans: state.spans,
    updated_at: new Date().toISOString(),
  };
  atomicJson(state.statePath, durable);
}

function sliceChunks(chunks, start, end) {
  const parts = [];
  for (const entry of chunks) {
    const entryEnd = entry.start + entry.chunk.length;
    if (entryEnd <= start || entry.start >= end) continue;
    parts.push(entry.chunk.subarray(Math.max(0, start - entry.start), Math.min(entry.chunk.length, end - entry.start)));
  }
  return Buffer.concat(parts);
}

function safeIdentity(input) {
  return {
    ownerId: safePart(input.ownerId || "legacy_owner"), sessionId: safePart(input.sessionId),
    branchId: safePart(input.branchId || "default"), turnId: safePart(input.turnId),
  };
}
function identityKey(identity) { return `${identity.ownerId}:${identity.sessionId}:${identity.branchId}:${identity.turnId}`; }
function safePart(value) { const raw = String(value || ""); if (!/^[a-zA-Z0-9_-]{1,160}$/.test(raw)) throw new Error("invalid reconcile identity"); return raw; }
function identityDir(root, identity) { return path.join(root, identity.ownerId, identity.sessionId, identity.branchId); }
function turnStatePath(root, identity) { return path.join(identityDir(root, identity), `${identity.turnId}.json`); }
function spanPcmPath(root, identity, id) { return path.join(identityDir(root, identity), `${identity.turnId}.${id}.pcm`); }
function spanId(identity, start, end) { return crypto.createHash("sha256").update(`${identityKey(identity)}:${start}:${end}`).digest("hex").slice(0, 24); }
function finalReconciliationId(state) {
  const digest = crypto.createHash("sha256").update(state.spans.map((span) => span.id).join(":")).digest("hex");
  return `rolling_${digest.slice(0, 24)}`;
}
function frameOffset(value, frameBytes) { const number = Number(value); return Number.isSafeInteger(number) && number >= 0 ? number - (number % frameBytes) : -1; }
function positiveInt(value, fallback) { const number = Number(value); return Number.isSafeInteger(number) && number > 0 ? number : fallback; }
function normalizeFormat(value = {}) {
  const sampleRate = positiveInt(value.sample_rate, 16000), channels = positiveInt(value.channels, 1);
  return { encoding: "pcm16", sample_rate: sampleRate, channels, frameBytes: channels * 2,
    bytesPerSecond: sampleRate * channels * 2 };
}
function boundedCodes(value) { return Array.from(new Set((Array.isArray(value) ? value : []).map(String).filter(Boolean))).slice(0, 2); }
function joinText(left, right) { return [String(left || "").trim(), String(right || "").trim()].filter(Boolean).join(" "); }
function cleanError(error) { return String(error?.message || error || "unknown").replace(/\s+/g, " ").slice(0, 240); }
function elapsedMs(start, end) { return Math.max(0, Date.parse(end) - Date.parse(start)) || 0; }
function isSafeLocalPcmPath(dataRoot, value) {
  try {
    const target = path.resolve(String(value || ""));
    const stat = fs.lstatSync(target);
    return target.startsWith(`${dataRoot}${path.sep}`) && stat.isFile() && !stat.isSymbolicLink();
  } catch { return false; }
}
function fileGeneration(value) {
  try {
    const stat = fs.lstatSync(String(value || ""));
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    return { dev: String(stat.dev), ino: String(stat.ino), size: stat.size, mtime_ms: stat.mtimeMs };
  } catch { return null; }
}
function sameGeneration(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino
    && left.size === right.size && left.mtime_ms === right.mtime_ms);
}
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }
function atomicJson(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(value, null, 2)); fs.renameSync(tmp, file); }
function writeExclusive(file, bytes) {
  try { fs.writeFileSync(file, bytes, { flag: "wx" }); }
  catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = fs.readFileSync(file);
    if (existing.length !== bytes.length || sha256Buffer(existing) !== sha256Buffer(bytes)) throw new Error("span collision");
  }
}
function sha256Buffer(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256"), stream = fs.createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk)); stream.once("error", reject);
    stream.once("end", () => resolve(hash.digest("hex")));
  });
}
async function verifySpanPcm(file, span) {
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() && !stat.isSymbolicLink() && stat.size === span.end_audio_byte - span.start_audio_byte
      && /^[a-f0-9]{64}$/.test(String(span.audio_sha256 || ""))
      && await sha256File(file) === span.audio_sha256;
  } catch { return false; }
}
function copyRange(source, target, start, end) {
  try {
    fs.lstatSync(target);
    fs.unlinkSync(target);
  } catch (error) {
    if (error?.code !== "ENOENT") return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    const input = fs.createReadStream(source, { start, end: end - 1 });
    const output = fs.createWriteStream(target, { flags: "wx" });
    const fail = (error) => { input.destroy(); output.destroy(); reject(error); };
    input.once("error", fail); output.once("error", fail); output.once("finish", resolve); input.pipe(output);
  });
}
function* walkStateFiles(root, depth) {
  let dir;
  try { dir = fs.opendirSync(root); } catch { return; }
  try {
    for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
      const target = path.join(root, entry.name);
      if (entry.isDirectory() && depth > 0) yield* walkStateFiles(target, depth - 1);
      else if (entry.isFile() && entry.name.endsWith(".json")) yield target;
    }
  } finally { dir.closeSync(); }
}

module.exports = { createRollingTranscriptReconcileRuntime };
