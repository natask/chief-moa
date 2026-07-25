"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MAX_LIMIT = 200;
const UNKNOWN = "unknown";
const MEDIA_STATUSES = new Set(["available", "missing", "deleted", "incognito", "tombstone"]);

function createAudioHistory(options = {}) {
  const dataDir = path.resolve(options.dataDir || "./data");
  const voiceTurnsDir = path.join(dataDir, "voice-turns");
  const audioNotes = options.audioNotes;
  const voiceTurnAudioRefs = options.voiceTurnAudioRefs || (() => ({}));
  const ownerSubject = cleanSubject(options.ownerSubject);
  if (!ownerSubject) throw new Error("audio history requires one configured owner subject");

  function subjectAllowed(subject) {
    return cleanSubject(subject) === ownerSubject;
  }

  function list({ limit = 50, cursor = "", subject = "" } = {}) {
    if (!subjectAllowed(subject)) return null;
    const boundedLimit = Math.max(1, Math.min(Number(limit) || 50, MAX_LIMIT));
    const records = allRecords().sort((left, right) => {
      const byTime = String(right.captured_at).localeCompare(String(left.captured_at));
      return byTime || right.audio_record_id.localeCompare(left.audio_record_id);
    });
    const offset = decodeCursor(cursor);
    const page = records.slice(offset, offset + boundedLimit);
    return {
      contract: "audio_record.v1",
      records: page,
      next_cursor: offset + page.length < records.length ? encodeCursor(offset + page.length) : null,
      generated_at: new Date().toISOString(),
    };
  }

  function get(id, { subject = "" } = {}) {
    if (!subjectAllowed(subject)) return null;
    const safeId = cleanId(id);
    if (!safeId) return null;
    return allRecords().find((record) => record.audio_record_id === safeId) || null;
  }

  function allRecords() {
    return [...voiceRecords(), ...noteRecords()];
  }

  function voiceRecords() {
    if (!fs.existsSync(voiceTurnsDir)) return [];
    const records = [];
    for (const sessionName of fs.readdirSync(voiceTurnsDir)) {
      const sessionDir = path.join(voiceTurnsDir, sessionName);
      let stat;
      try { stat = fs.statSync(sessionDir); } catch { continue; }
      if (!stat.isDirectory()) continue;
      for (const name of fs.readdirSync(sessionDir)) {
        if (!name.endsWith(".json")) continue;
        const source = readJson(path.join(sessionDir, name));
        if (!source || typeof source !== "object") continue;
        const sessionId = cleanId(source.session_id || source.conversation_id || sessionName);
        const turnId = cleanId(source.id || source.turn_id || name.slice(0, -5));
        if (!sessionId || !turnId) continue;
        const audio = voiceTurnAudioRefs(source)?.user || null;
        records.push(projectVoiceRecord(source, sessionId, turnId, audio));
      }
    }
    return records;
  }

  function noteRecords() {
    if (!audioNotes || typeof audioNotes.list !== "function") return [];
    return audioNotes.list({ limit: MAX_LIMIT }).map(projectAudioNote);
  }

  function projectVoiceRecord(source, sessionId, turnId, audio) {
    const mediaStatus = lifecycleStatus(source, audio);
    const durationMs = audio ? durationFromPcm(audio.bytes) : finiteOrNull(
      source.references?.voice_session?.audio?.duration_ms,
    );
    const revisions = normalizeVoiceRevisions(source, { durationMs });
    const selected = revisions.at(-1) || null;
    const id = recordId("voice_turn", `${sessionId}:${turnId}`);
    return {
      contract: "audio_record.v1",
      audio_record_id: id,
      source_kind: "voice_turn",
      source_id: turnId,
      session_id: sessionId,
      surface: cleanText(source.source || source.surface || source.references?.voice_session?.surface, 80),
      device_id: cleanText(source.device_id, 120),
      captured_at: iso(source.created_at || source.updated_at),
      duration_ms: durationMs,
      media_status: mediaStatus,
      lifecycle: lifecycleDetail(source, mediaStatus),
      audio: {
        content_type: String(audio?.content_type || "audio/L16; rate=16000; channels=1"),
        encoding: String(audio?.encoding || "pcm16"),
        bytes: Math.max(0, Number(audio?.bytes) || 0),
        playback_href: mediaStatus === "available" ? `/v1/audio-history/${id}/audio` : null,
      },
      transcript: {
        status: selected ? "available" : "not_transcribed",
        original_revision_id: revisions[0]?.revision_id || null,
        selected_revision_id: selected?.revision_id || null,
        revisions,
      },
    };
  }

  function projectAudioNote(note) {
    const id = cleanId(note.id);
    const noteAudio = Number(note.bytes || note.audio?.bytes) > 0
      ? { ...note.audio, bytes: note.bytes || note.audio?.bytes }
      : null;
    const mediaStatus = lifecycleStatus(note, noteAudio);
    const record = recordId("audio_note", id);
    return {
      contract: "audio_record.v1",
      audio_record_id: record,
      source_kind: "audio_note",
      source_id: id,
      session_id: cleanId(note.session_id),
      surface: cleanText(note.surface, 80),
      device_id: cleanText(note.device_id, 120),
      captured_at: iso(note.created_at),
      duration_ms: finiteOrNull(note.duration_ms),
      media_status: mediaStatus,
      lifecycle: lifecycleDetail(note, mediaStatus),
      audio: {
        content_type: String(note.content_type || note.audio?.content_type || "application/octet-stream"),
        encoding: String(note.audio?.encoding || ""),
        bytes: Math.max(0, Number(note.bytes || note.audio?.bytes) || 0),
        playback_href: mediaStatus === "available" ? `/v1/audio-history/${record}/audio` : null,
      },
      transcript: {
        status: "not_transcribed",
        original_revision_id: null,
        selected_revision_id: null,
        revisions: [],
      },
    };
  }

  return { list, get, subjectAllowed };
}

function createAudioHistoryHandlers(options = {}) {
  const { history, authorized, principal, sendJson, sendVoiceAudio, sendAudioNote } = options;

  async function routeAudioHistory(request, response, url) {
    if (!url.pathname.startsWith("/v1/audio-history")) return false;
    response.setHeader("cache-control", "private, no-store");
    if (!authorized(request)) {
      sendJson(response, 401, { error: "missing or invalid gateway token" });
      return true;
    }
    const subject = cleanSubject(principal(request));
    if (!history.subjectAllowed(subject)) {
      sendJson(response, 404, { error: "audio record not found" });
      return true;
    }
    if (request.method !== "GET") {
      sendJson(response, 405, { error: "method not allowed" });
      return true;
    }
    if (url.pathname === "/v1/audio-history") {
      sendJson(response, 200, history.list({
        limit: url.searchParams.get("limit"),
        cursor: url.searchParams.get("cursor"),
        subject,
      }));
      return true;
    }
    const match = url.pathname.match(/^\/v1\/audio-history\/([^/]+)(\/audio)?$/);
    if (!match) return notFound(response, sendJson);
    let id;
    try { id = decodeURIComponent(match[1]); } catch { id = ""; }
    const record = history.get(id, { subject });
    if (!record) return notFound(response, sendJson);
    if (!match[2]) {
      sendJson(response, 200, record);
      return true;
    }
    if (record.media_status !== "available" || !record.audio.playback_href) {
      return notFound(response, sendJson);
    }
    if (record.source_kind === "voice_turn") {
      const target = new URL(
        `/v1/voice/audio/${encodeURIComponent(record.session_id)}/${encodeURIComponent(record.source_id)}?kind=user`,
        url,
      );
      await sendVoiceAudio(request, response, target);
    } else {
      const target = new URL(`/v1/audio-notes/${encodeURIComponent(record.source_id)}/audio`, url);
      await sendAudioNote(response, target);
    }
    return true;
  }

  return { routeAudioHistory };
}

function notFound(response, sendJson) {
  sendJson(response, 404, { error: "audio record not found" });
  return true;
}

function normalizeVoiceRevisions(source, audio = {}) {
  const stored = Array.isArray(source.transcript_revisions) ? source.transcript_revisions : [];
  const rows = stored.length ? stored : String(source.transcript || "") ? [{
    revision: 0,
    transcript: source.transcript,
    transcript_source: source.transcript_source,
    source: "original",
    created_at: source.updated_at || source.created_at,
  }] : [];
  return rows.map((row, index) => ({
    revision_id: `rev_${Number.isFinite(Number(row.revision)) ? Number(row.revision) : index}`,
    ordinal: Number.isFinite(Number(row.revision)) ? Number(row.revision) : index,
    transcript: String(row.transcript || ""),
    source: known(row.source || row.transcript_source),
    created_at: iso(row.created_at || source.created_at),
    provenance: revisionProvenance(row, source, audio),
  }));
}

function revisionProvenance(row, source, audio) {
  const session = source.references?.voice_session || {};
  const cost = row.cost || row.billing?.cost || {};
  const error = row.error || {};
  return {
    provider: known(row.provider),
    api_version: known(row.api_version),
    model: known(row.model),
    method: known(row.method || (row.windowed === true ? "windowed_sync_legacy" : "")),
    recognizer: known(row.recognizer),
    location: known(row.location),
    language_codes: Array.isArray(row.language_codes) ? row.language_codes.map(String) : [],
    prompt_digest: known(row.prompt_digest),
    audio_sha256: known(row.audio_sha256 || session.audio?.sha256),
    audio_duration_ms: finiteOrUnknown(row.audio_duration_ms ?? audio.durationMs),
    chunk_strategy: known(row.strategy || (row.windowed === true ? "windowed_sync_legacy" : "")),
    operation_id: known(row.operation_id || row.request_id),
    billed_duration_ms: finiteOrUnknown(row.billed_duration_ms || row.billing?.duration_ms),
    cost: {
      amount: finiteOrUnknown(cost.amount),
      currency: known(cost.currency),
      rate: finiteOrUnknown(cost.rate),
      as_of: known(cost.as_of),
      status: known(cost.status),
    },
    error: {
      code: known(error.code),
      message: known(error.message),
      retryable: typeof error.retryable === "boolean" ? error.retryable : UNKNOWN,
    },
  };
}

function lifecycleStatus(source, audio) {
  const explicit = cleanText(source.media_status || source.lifecycle?.status, 40).toLowerCase();
  if (MEDIA_STATUSES.has(explicit)) return explicit;
  if (source.incognito === true) return "incognito";
  if (source.tombstone === true || source.deleted_tombstone === true) return "tombstone";
  if (source.deleted === true || source.deleted_at) return "deleted";
  return audio && Number(audio.bytes) > 0 ? "available" : "missing";
}

function lifecycleDetail(source, status) {
  return {
    status,
    reason: known(source.lifecycle?.reason || source.media_status_reason),
    deleted_at: source.deleted_at ? iso(source.deleted_at) : UNKNOWN,
  };
}

function recordId(kind, sourceId) {
  const digest = crypto.createHash("sha256").update(`${kind}\0${sourceId}`).digest("hex").slice(0, 24);
  return `aud_${digest}`;
}

function durationFromPcm(bytes) {
  const number = Number(bytes);
  return Number.isFinite(number) && number > 0 ? Math.round((number / 32000) * 1000) : null;
}

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
}

function finiteOrUnknown(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : UNKNOWN;
}

function known(value) {
  const clean = cleanText(value, 240);
  return clean || UNKNOWN;
}

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return null; }
}

function cleanId(value) {
  return String(value || "").trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 160);
}

function cleanSubject(value) {
  return String(value || "").trim().slice(0, 240);
}

function cleanText(value, max) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, max);
}

function iso(value) {
  const date = new Date(value || 0);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function encodeCursor(offset) {
  return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url");
}

function decodeCursor(value) {
  if (!value) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
    return Math.max(0, Math.floor(Number(parsed.offset) || 0));
  } catch {
    return 0;
  }
}

module.exports = {
  createAudioHistory,
  createAudioHistoryHandlers,
  audioHistoryTestInternals: { recordId, normalizeVoiceRevisions, encodeCursor, decodeCursor },
};
