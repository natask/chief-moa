"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_MAX_ACTIVE = 2;
const DEFAULT_MAX_READY = 8;
const DEFAULT_MAX_BUFFER_BYTES = 8 * 1024 * 1024;

function createRollingTranscriptReconcileRuntime(options = {}) {
  const root = path.join(path.resolve(options.dataDir || "./data"), "voice-transcript-reconcile");
  const maxActive = positiveInt(options.maxActive, DEFAULT_MAX_ACTIVE);
  const maxReady = positiveInt(options.maxReady, DEFAULT_MAX_READY);
  const maxBufferBytes = positiveInt(options.maxBufferBytes, DEFAULT_MAX_BUFFER_BYTES);
  const providerForJob = options.providerForJob;
  const onFinalRevision = options.onFinalRevision;
  const ready = [];
  const queued = new Set();
  const turns = new Map();
  let active = 0;
  fs.mkdirSync(root, { recursive: true });
  setImmediate(recoverPending);

  function createTurn(input) {
    const identity = safeIdentity(input);
    const statePath = turnStatePath(root, identity);
    const persisted = readJson(statePath) || {};
    const state = {
      identity,
      statePath,
      provider: input.provider,
      languageCodes: boundedCodes(input.languageCodes),
      emitPrefix: input.emitPrefix,
      snapshotTail: input.snapshotTail,
      chunks: [],
      bufferedBytes: 0,
      receivedBytes: Number(persisted.received_bytes || 0),
      sealedBytes: Number(persisted.sealed_bytes || 0),
      correctedText: String(persisted.corrected_text || ""),
      revision: Number(persisted.revision || 0),
      terminal: persisted.terminal === true,
      disabled: false,
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
        state.chunks.push({ start: state.receivedBytes, chunk: Buffer.from(chunk) });
        state.receivedBytes += chunk.length;
        state.bufferedBytes += chunk.length;
        if (state.bufferedBytes > maxBufferBytes) state.disabled = true;
      },
      seal(boundary) {
        if (state.terminal || state.disabled) return false;
        return sealSpan(state, evenOffset(boundary?.absolute_audio_byte_offset), false);
      },
      finish(input = {}) {
        if (state.terminal) return;
        if (!state.disabled) sealSpan(state, state.receivedBytes, true);
        else materializeFileTail(state, input.pcmPath);
        state.terminal = true;
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
    if (ready.length >= maxReady && !terminal) return false;
    const pcm = sliceChunks(state.chunks, state.sealedBytes, end);
    if (pcm.length !== end - state.sealedBytes) return false;
    const span = {
      id: spanId(state.identity, state.sealedBytes, end),
      start_audio_byte: state.sealedBytes,
      end_audio_byte: end,
      status: "pending",
      terminal,
      language_codes: state.languageCodes,
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

  function materializeFileTail(state, pcmPath) {
    const end = state.receivedBytes;
    if (!pcmPath || end <= state.sealedBytes) return;
    const span = {
      id: spanId(state.identity, state.sealedBytes, end), start_audio_byte: state.sealedBytes,
      end_audio_byte: end, status: "materializing", terminal: true,
      language_codes: state.languageCodes, source_pcm_path: String(pcmPath), created_at: new Date().toISOString(),
    };
    state.spans.push(span);
    state.sealedBytes = end;
    persistState(state);
    void materializeSpan(state, span);
  }

  async function materializeSpan(state, span) {
    try {
      const target = spanPcmPath(root, state.identity, span.id);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      await copyRange(span.source_pcm_path, target, span.start_audio_byte, span.end_audio_byte);
      if (state.deleted) { try { fs.unlinkSync(target); } catch {} return; }
      span.status = "pending";
      delete span.source_pcm_path;
    } catch (error) {
      span.status = "failed";
      span.error = cleanError(error);
    }
    persistState(state);
    schedule(state);
  }

  function schedule(state) {
    if (state.deleted) return;
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
      const state = ready.shift();
      queued.delete(state.statePath);
      if (state.processing) continue;
      state.processing = true;
      active += 1;
      void processNext(state).finally(() => {
        state.processing = false;
        active -= 1;
        schedule(state);
        pump();
      });
    }
  }

  async function processNext(state) {
    const span = state.spans.find((value) => value.status === "pending");
    if (!span) return;
    const now = new Date().toISOString();
    span.status = "claimed";
    span.claim_id = crypto.randomUUID();
    span.claimed_at = now;
    span.paid_attempts = 1;
    persistState(state); // durable before the paid provider call
    const provider = state.provider || (typeof providerForJob === "function" ? providerForJob() : null);
    if (!provider || typeof provider.transcribePcmWindowed !== "function") {
      span.status = "failed";
      span.error = "batch_stt_unavailable";
      span.finished_at = new Date().toISOString();
      persistState(state);
      return;
    }
    try {
      const pcmPath = spanPcmPath(root, state.identity, span.id);
      const result = await provider.transcribePcmWindowed({
        turnId: state.identity.turnId,
        pcmPath,
        audioBytes: span.end_audio_byte - span.start_audio_byte,
        format: { encoding: "pcm16", sample_rate: 16000, channels: 1 },
      }, span.language_codes);
      if (state.deleted) return;
      const transcript = String(result?.text || "").trim();
      span.status = transcript ? "completed" : "empty";
      span.transcript = transcript;
      span.windowed = result?.windowed === true;
      span.finished_at = new Date().toISOString();
      if (transcript) {
        state.correctedText = joinText(state.correctedText, transcript);
        state.revision += 1;
        if (typeof state.emitPrefix === "function") {
          await state.emitPrefix({
            revision: state.revision,
            finalizedText: state.correctedText,
            sealedThroughAudioByte: span.end_audio_byte,
          });
        }
      }
    } catch (error) {
      span.status = "failed";
      span.error = cleanError(error);
      span.finished_at = new Date().toISOString();
    }
    persistState(state);
  }

  async function maybeFinalize(state) {
    if (state.deleted) return;
    if (!state.terminal || !state.canonicalReady || state.sealedBytes !== state.receivedBytes) return;
    if (state.spans.some((span) => span.status !== "completed" && span.status !== "empty")) return;
    if (!state.correctedText.trim() || state.finalized_at) return;
    if (typeof onFinalRevision === "function") {
      const updatedAt = new Date().toISOString();
      const accepted = await onFinalRevision({
        ...state.identity,
        transcript: state.correctedText,
        reconciliationId: finalReconciliationId(state),
        source: "automatic_reconcile",
        transcriptSource: "stt-auto-reconcile",
        updatedAt,
      });
      if (accepted === false) return;
      state.finalized_at = updatedAt;
      persistState(state);
    }
  }

  function recoverPending() {
    for (const statePath of boundedStateFiles(root, 64)) {
      const persisted = readJson(statePath);
      if (!persisted?.session_id || !persisted?.turn_id || persisted.finalized_at) continue;
      const identity = safeIdentity({ sessionId: persisted.session_id, branchId: persisted.branch_id, turnId: persisted.turn_id });
      if (turns.has(identityKey(identity))) continue;
      const state = {
        identity, statePath, provider: null, languageCodes: [], emitPrefix: null,
        chunks: [], bufferedBytes: 0, receivedBytes: Number(persisted.received_bytes || 0),
        sealedBytes: Number(persisted.sealed_bytes || 0), correctedText: String(persisted.corrected_text || ""),
        revision: Number(persisted.revision || 0), terminal: persisted.terminal === true, disabled: false,
        spans: Array.isArray(persisted.spans) ? persisted.spans : [], processing: false,
        canonicalReady: typeof options.canonicalReadyForJob === "function"
          ? options.canonicalReadyForJob(identity) === true : false,
      };
      for (const span of state.spans) {
        if (span.status === "claimed") {
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
  }

  function notifyCanonicalCommitted(identity) {
    const state = turns.get(identityKey(safeIdentity(identity)));
    if (!state) return;
    state.canonicalReady = true;
    void maybeFinalize(state);
  }

  function deleteTurn(identityInput) {
    const identity = safeIdentity(identityInput);
    const state = turns.get(identityKey(identity));
    if (state) { state.deleted = true; state.terminal = true; state.disabled = true; }
    const dir = path.join(root, identity.sessionId);
    let entries;
    try { entries = fs.readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (name === `${identity.turnId}.json` || (name.startsWith(`${identity.turnId}.`) && name.endsWith(".pcm"))) {
        try { fs.unlinkSync(path.join(dir, name)); } catch { /* exact best-effort privacy cleanup */ }
      }
    }
  }

  function cleanupTerminalSpanAudio(state) {
    if (!state.terminal || state.spans.some((span) => ["pending", "claimed", "materializing"].includes(span.status))) return;
    for (const span of state.spans) {
      try { fs.unlinkSync(spanPcmPath(root, state.identity, span.id)); } catch { /* canonical retained audio owns recovery */ }
    }
  }

  return {
    createTurn,
    deleteTurn,
    notifyCanonicalCommitted,
    status: () => ({ active, queued: ready.length, max_active: maxActive, max_ready: maxReady }),
  };
}

function persistState(state) {
  const durable = {
    version: 1,
    session_id: state.identity.sessionId,
    branch_id: state.identity.branchId,
    turn_id: state.identity.turnId,
    received_bytes: state.receivedBytes,
    sealed_bytes: state.sealedBytes,
    corrected_text: state.correctedText,
    revision: state.revision,
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
    sessionId: safePart(input.sessionId), branchId: safePart(input.branchId || "default"), turnId: safePart(input.turnId),
  };
}
function identityKey(identity) { return `${identity.sessionId}:${identity.turnId}`; }
function safePart(value) { const safe = String(value || "").replace(/[^a-zA-Z0-9_-]/g, ""); if (!safe) throw new Error("invalid reconcile identity"); return safe; }
function turnStatePath(root, identity) { return path.join(root, identity.sessionId, `${identity.turnId}.json`); }
function spanPcmPath(root, identity, id) { return path.join(root, identity.sessionId, `${identity.turnId}.${id}.pcm`); }
function spanId(identity, start, end) { return crypto.createHash("sha256").update(`${identity.sessionId}:${identity.turnId}:${start}:${end}`).digest("hex").slice(0, 24); }
function finalReconciliationId(state) {
  const digest = crypto.createHash("sha256").update(state.spans.map((span) => span.id).join(":")).digest("hex");
  return `rolling_${digest.slice(0, 24)}`;
}
function evenOffset(value) { const number = Number(value); return Number.isSafeInteger(number) && number >= 0 ? number - (number % 2) : -1; }
function positiveInt(value, fallback) { const number = Number(value); return Number.isSafeInteger(number) && number > 0 ? number : fallback; }
function boundedCodes(value) { return Array.from(new Set((Array.isArray(value) ? value : []).map(String).filter(Boolean))).slice(0, 2); }
function joinText(left, right) { return [String(left || "").trim(), String(right || "").trim()].filter(Boolean).join(" "); }
function cleanError(error) { return String(error?.message || error || "unknown").replace(/\s+/g, " ").slice(0, 240); }
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }
function atomicJson(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(value, null, 2)); fs.renameSync(tmp, file); }
function writeExclusive(file, bytes) { try { fs.writeFileSync(file, bytes, { flag: "wx" }); } catch (error) { if (error?.code !== "EEXIST") throw error; } }
function copyRange(source, target, start, end) {
  try {
    if (fs.statSync(target).size === end - start) return Promise.resolve();
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
function boundedStateFiles(root, limit) {
  const files = [];
  let dirs;
  try { dirs = fs.opendirSync(root); } catch { return files; }
  for (let entry = dirs.readSync(); entry && files.length < limit; entry = dirs.readSync()) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    let children;
    try { children = fs.opendirSync(dir); } catch { continue; }
    for (let child = children.readSync(); child && files.length < limit; child = children.readSync()) {
      if (child.isFile() && child.name.endsWith(".json")) files.push(path.join(dir, child.name));
    }
    children.closeSync();
  }
  dirs.closeSync();
  return files;
}

module.exports = { createRollingTranscriptReconcileRuntime };
