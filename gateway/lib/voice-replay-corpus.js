"use strict";

const fs = require("node:fs");
const path = require("node:path");

function buildVoiceReplayCorpus(options) {
  const dataDir = path.resolve(options?.dataDir || "");
  const turnsDir = path.join(dataDir, "voice-turns");
  if (!fs.statSync(turnsDir).isDirectory()) {
    throw new Error(`voice-turns directory not found under ${dataDir}`);
  }
  const records = readJsonTree(turnsDir)
    .map(normalizeRecord)
    .filter(Boolean)
    .filter(isUserTurn)
    .sort(compareTurns);
  const bySession = new Map();
  for (const record of records) {
    const values = bySession.get(record.sessionId) || [];
    values.push(record);
    bySession.set(record.sessionId, values);
  }
  const samples = records.map((record) => replaySample(record, nextTurn(record, bySession), dataDir));
  const requireLocalAudio = options?.requireLocalAudio !== false;
  const eligible = samples.filter((sample) => sample.input_audio.bytes > 0
    && sample.original.transcript
    && (!requireLocalAudio || sample.input_audio.local_path));
  const maxSamples = positiveInteger(options?.maxSamples, eligible.length);
  return {
    schema_version: "moa-voice-replay/v1",
    generated_at: new Date().toISOString(),
    private_corpus: true,
    source: path.basename(dataDir),
    selection: {
      eligible_turns: eligible.length,
      selected_turns: Math.min(maxSamples, eligible.length),
      strategy: "chronological-even-spacing",
      require_local_audio: requireLocalAudio,
    },
    samples: evenlySpaced(eligible, maxSamples),
  };
}

function normalizeRecord(record) {
  if (!record || typeof record !== "object") return null;
  const sessionId = clean(record.session_id || record.conversation_id);
  const turnId = clean(record.id || record.turn_id);
  if (!sessionId || !turnId) return null;
  const voice = record.references?.voice_session || {};
  return {
    raw: record,
    sessionId,
    turnId,
    createdAt: clean(record.created_at || record.updated_at),
    transcript: clean(record.transcript || record.response?.transcript),
    responseText: clean(record.response?.speak || record.response?.display || record.response?.text),
    voice,
    source: clean(record.source),
  };
}

function isUserTurn(record) {
  if (!new Set(["android-overlay", "agee-extension"]).has(record.source)) return false;
  return !/(^|[-_])(smoke|probe|e2e|doctor)([-_]|$)/i.test(record.sessionId);
}

function replaySample(record, following, dataDir) {
  const audio = record.voice.audio || {};
  const assistantAudio = record.voice.assistant_audio || {};
  const events = Array.isArray(record.voice.provider_events) ? record.voice.provider_events : [];
  const firstAudio = events.find((event) => event?.type === "assistant_audio_start");
  const inputPath = path.join(dataDir, "voice-sessions", record.sessionId, `${record.turnId}.pcm`);
  const assistantPath = path.join(dataDir, "voice-sessions", record.sessionId, `${record.turnId}.assistant.pcm`);
  return {
    id: `${record.sessionId}/${record.turnId}`,
    session_id: record.sessionId,
    turn_id: record.turnId,
    created_at: record.createdAt,
    input_audio: audioDescriptor(inputPath, audio.bytes, record.sessionId, record.turnId, "user"),
    original: {
      provider: clean(record.voice.provider),
      model: clean(record.voice.model),
      status: clean(record.voice.status),
      transcript: record.transcript,
      response_text: record.responseText,
      first_audio_ms: elapsedMs(record.createdAt, firstAudio?.ts),
      assistant_audio: audioDescriptor(assistantPath, assistantAudio.bytes, record.sessionId, record.turnId, "assistant"),
    },
    follow_up: following ? {
      turn_id: following.turnId,
      created_at: following.createdAt,
      transcript: following.transcript,
      delay_ms: elapsedMs(record.createdAt, following.createdAt),
    } : null,
  };
}

function audioDescriptor(filePath, storedBytes, sessionId, turnId, kind) {
  const localBytes = fileSize(filePath);
  const suffix = kind === "assistant" ? ".assistant.pcm" : ".pcm";
  return {
    encoding: "pcm16",
    sample_rate: 16000,
    channels: 1,
    bytes: localBytes || Math.max(0, Number(storedBytes) || 0),
    duration_ms: Math.round(((localBytes || Number(storedBytes) || 0) / 32000) * 1000),
    local_path: localBytes > 0 ? filePath : null,
    storage_key: `voice-sessions/${sessionId}/${turnId}${suffix}`,
  };
}

function nextTurn(record, bySession) {
  const turns = bySession.get(record.sessionId) || [];
  const index = turns.indexOf(record);
  return index >= 0 ? turns[index + 1] || null : null;
}

function evenlySpaced(values, maxSamples) {
  if (maxSamples >= values.length) return values;
  if (maxSamples === 1) return [values[values.length - 1]];
  const chosen = [];
  for (let index = 0; index < maxSamples; index += 1) {
    chosen.push(values[Math.round(index * (values.length - 1) / (maxSamples - 1))]);
  }
  return chosen;
}

function readJsonTree(root) {
  const records = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name.endsWith(".json")) records.push(JSON.parse(fs.readFileSync(full, "utf8")));
    }
  }
  return records;
}

function compareTurns(left, right) {
  return left.sessionId.localeCompare(right.sessionId)
    || left.createdAt.localeCompare(right.createdAt)
    || left.turnId.localeCompare(right.turnId);
}

function elapsedMs(start, end) {
  const value = Date.parse(end) - Date.parse(start);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function fileSize(filePath) {
  try { return fs.statSync(filePath).isFile() ? fs.statSync(filePath).size : 0; } catch { return 0; }
}

function positiveInteger(value, fallback) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function clean(value) {
  return String(value || "").trim();
}

module.exports = { buildVoiceReplayCorpus };
