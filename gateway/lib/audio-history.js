"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MAX_LIMIT = 200;

function createAudioHistory(options = {}) {
  const dataDir = path.resolve(options.dataDir || "./data");
  const voiceTurnsDir = path.join(dataDir, "voice-turns");
  const audioNotes = options.audioNotes;
  const voiceTurnAudioRefs = options.voiceTurnAudioRefs || (() => ({}));

  function list({ limit = 50, cursor = "" } = {}) {
    const boundedLimit = Math.max(1, Math.min(Number(limit) || 50, MAX_LIMIT));
    const records = [...voiceRecords(), ...noteRecords()]
      .sort((left, right) => {
        const byTime = String(right.captured_at).localeCompare(String(left.captured_at));
        return byTime || right.audio_record_id.localeCompare(left.audio_record_id);
      });
    const offset = decodeCursor(cursor);
    const page = records.slice(offset, offset + boundedLimit);
    return {
      records: page,
      next_cursor: offset + page.length < records.length
        ? encodeCursor(offset + page.length)
        : null,
      generated_at: new Date().toISOString(),
    };
  }

  function get(id) {
    const safeId = cleanId(id);
    if (!safeId) return null;
    return [...voiceRecords(), ...noteRecords()]
      .find((record) => record.audio_record_id === safeId) || null;
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
        const audio = voiceTurnAudioRefs(source)?.user;
        if (!audio) continue;
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
    const revisions = normalizeVoiceRevisions(source);
    const selected = revisions.at(-1) || null;
    return {
      audio_record_id: recordId("voice_turn", `${sessionId}:${turnId}`),
      source_kind: "voice_turn",
      source_id: turnId,
      session_id: sessionId,
      surface: cleanText(source.source || source.surface || source.references?.voice_session?.surface, 80),
      device_id: cleanText(source.device_id, 120),
      captured_at: iso(source.created_at || source.updated_at),
      duration_ms: durationFromPcm(audio.bytes),
      audio: {
        content_type: String(audio.content_type || "audio/L16; rate=16000; channels=1"),
        encoding: String(audio.encoding || "pcm16"),
        bytes: Math.max(0, Number(audio.bytes) || 0),
        playback_href: `/v1/audio-history/${recordId("voice_turn", `${sessionId}:${turnId}`)}/audio`,
      },
      transcript: {
        status: selected ? "available" : "not_transcribed",
        original_revision_id: revisions[0]?.revision_id || null,
        selected_revision_id: selected?.revision_id || null,
        revisions,
      },
      provenance: {
        transcript_source: cleanText(source.transcript_source, 120),
        profile_version: cleanText(source.profile_version, 120),
        classification: cleanText(source.classification, 80),
        provider: cleanText(source.references?.voice_session?.provider, 80),
        model: cleanText(source.references?.voice_session?.model, 120),
      },
      retranscribe_href: `/v1/voice/turns/${encodeURIComponent(sessionId)}/${encodeURIComponent(turnId)}/retranscribe`,
    };
  }

  function projectAudioNote(note) {
    const id = cleanId(note.id);
    return {
      audio_record_id: recordId("audio_note", id),
      source_kind: "audio_note",
      source_id: id,
      session_id: cleanId(note.session_id),
      surface: cleanText(note.surface, 80),
      device_id: "",
      captured_at: iso(note.created_at),
      duration_ms: finiteOrNull(note.duration_ms),
      audio: {
        content_type: String(note.content_type || note.audio?.content_type || "application/octet-stream"),
        encoding: String(note.audio?.encoding || ""),
        bytes: Math.max(0, Number(note.bytes || note.audio?.bytes) || 0),
        playback_href: `/v1/audio-history/${recordId("audio_note", id)}/audio`,
      },
      transcript: {
        status: "not_transcribed",
        original_revision_id: null,
        selected_revision_id: null,
        revisions: [],
      },
      provenance: { label: cleanText(note.label, 200) },
      retranscribe_href: null,
    };
  }

  return { list, get };
}

function createAudioHistoryHandlers(options = {}) {
  const { history, authorized, sendJson, sendVoiceAudio, sendAudioNote } = options;

  async function routeAudioHistory(request, response, url) {
    if (!url.pathname.startsWith("/v1/audio-history")) return false;
    if (!authorized(request)) {
      sendJson(response, 401, { error: "missing or invalid gateway token" });
      return true;
    }
    response.setHeader("cache-control", "private, no-store");
    if (request.method !== "GET") {
      sendJson(response, 405, { error: "method not allowed" });
      return true;
    }
    if (url.pathname === "/v1/audio-history") {
      sendJson(response, 200, history.list({
        limit: url.searchParams.get("limit"),
        cursor: url.searchParams.get("cursor"),
      }));
      return true;
    }
    const match = url.pathname.match(/^\/v1\/audio-history\/([^/]+)(\/audio)?$/);
    if (!match) {
      sendJson(response, 404, { error: "audio record not found" });
      return true;
    }
    let id;
    try { id = decodeURIComponent(match[1]); } catch { id = ""; }
    const record = history.get(id);
    if (!record) {
      sendJson(response, 404, { error: "audio record not found" });
      return true;
    }
    if (!match[2]) {
      sendJson(response, 200, record);
      return true;
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

function normalizeVoiceRevisions(source) {
  const stored = Array.isArray(source.transcript_revisions) ? source.transcript_revisions : [];
  const rows = stored.length
    ? stored
    : String(source.transcript || "")
      ? [{
          revision: 0,
          transcript: source.transcript,
          transcript_source: source.transcript_source,
          source: "original",
          created_at: source.updated_at || source.created_at,
        }]
      : [];
  return rows.map((row, index) => ({
    revision_id: `rev_${Number.isFinite(Number(row.revision)) ? Number(row.revision) : index}`,
    ordinal: Number.isFinite(Number(row.revision)) ? Number(row.revision) : index,
    transcript: String(row.transcript || ""),
    source: cleanText(row.source || row.transcript_source, 120),
    transcript_source: cleanText(row.transcript_source, 120),
    language_codes: Array.isArray(row.language_codes) ? row.language_codes.map(String) : [],
    strategy: row.windowed === true ? "windowed_sync_legacy" : cleanText(row.strategy, 80),
    created_at: iso(row.created_at || source.created_at),
  }));
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

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return null; }
}

function cleanId(value) {
  return String(value || "").trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 160);
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
