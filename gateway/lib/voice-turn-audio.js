"use strict";

// Stored voice-turn audio (user + assistant PCM archives), extracted from
// server.js and rehomed on the blob store: refs for turn listings, the
// /v1/voice/audio serve path, incognito deletion, and the storage diagnosis
// probe. Keys live under voice-sessions/<sessionId>/<turnId>[.assistant].pcm.

const fs = require("node:fs");
const path = require("node:path");

const PCM_CONTENT_TYPE = "audio/L16; rate=16000; channels=1";

function createVoiceTurnAudio({ dataDir, blobStore, sanitizeOptionalId, sendJson, cleanError }) {
  function voiceTurnAudioRefs(record) {
    if (!record || typeof record !== "object") {
      return {};
    }
    const user = voiceTurnAudioRef(record, "user");
    const assistant = voiceTurnAudioRef(record, "assistant");
    return {
      ...(user ? { user } : {}),
      ...(assistant ? { assistant } : {}),
    };
  }

  function voiceTurnAudioRef(record, kind) {
    const sessionId = sanitizeOptionalId(record.session_id || record.conversation_id, "");
    const turnId = sanitizeOptionalId(record.id || record.turn_id, "");
    if (!sessionId || !turnId) {
      return null;
    }
    const filePath = voiceTurnAudioPath(sessionId, turnId, kind);
    if (!filePath) {
      return null;
    }
    let bytes = 0;
    try {
      const stat = fs.statSync(filePath);
      if (stat.isFile()) bytes = stat.size;
    } catch {}
    if (bytes <= 0 && blobStore.mode === "gcs") {
      // Spool already pruned: this listing stays synchronous, so trust the
      // byte count the turn recorded at capture time instead of a per-row GCS
      // stat. The GET handler re-checks the bucket authoritatively. Incognito
      // turns have no stored record, so nothing deleted can resurface here.
      const stored = kind === "assistant"
        ? record.references?.voice_session?.assistant_audio
        : record.references?.voice_session?.audio;
      bytes = Math.max(0, Number(stored?.bytes) || 0);
    }
    if (bytes <= 0) {
      return null;
    }
    return {
      kind,
      encoding: "pcm16",
      content_type: PCM_CONTENT_TYPE,
      bytes,
      href: `/v1/voice/audio/${encodeURIComponent(sessionId)}/${encodeURIComponent(turnId)}?kind=${kind}`,
    };
  }

  function voiceTurnAudioKey(sessionId, turnId, kind) {
    const safeSessionId = sanitizeOptionalId(sessionId, "default");
    const safeTurnId = sanitizeOptionalId(turnId, "");
    if (!safeTurnId) {
      return "";
    }
    const suffix = kind === "assistant" ? ".assistant.pcm" : ".pcm";
    return `voice-sessions/${safeSessionId}/${safeTurnId}${suffix}`;
  }

  function voiceTurnAudioPath(sessionId, turnId, kind) {
    const key = voiceTurnAudioKey(sessionId, turnId, kind);
    return key ? path.join(dataDir, key) : "";
  }

  // Delete both PCM archives for a turn — spool and bucket. Used for incognito
  // streaming turns, whose buffered audio must not survive anywhere.
  // Best-effort: a missing file is not an error.
  async function deleteVoiceTurnPcm(sessionId, turnId) {
    for (const kind of ["user", "assistant"]) {
      const key = voiceTurnAudioKey(sessionId, turnId, kind);
      if (!key) continue;
      try {
        await blobStore.delete(key);
      } catch {
        // Best-effort; the write guards already keep the turn record out of storage.
      }
    }
  }

  async function sendVoiceAudio(request, response, url) {
    const rest = url.pathname.slice("/v1/voice/audio/".length).split("/");
    if (rest.length !== 2) {
      sendJson(response, 404, { error: "voice audio not found" });
      return;
    }
    let sessionId;
    let turnId;
    try {
      sessionId = sanitizeOptionalId(decodeURIComponent(rest[0]), "default");
      turnId = sanitizeOptionalId(decodeURIComponent(rest[1]), "");
    } catch {
      sendJson(response, 404, { error: "voice audio not found" });
      return;
    }
    const kind = url.searchParams.get("kind") === "assistant" ? "assistant" : "user";
    const key = voiceTurnAudioKey(sessionId, turnId, kind);
    let found = null;
    try {
      found = key ? await blobStore.getReadStream(key) : null;
    } catch (error) {
      sendJson(response, 502, { error: `voice audio read failed: ${cleanError(error)}` });
      return;
    }
    if (!found) {
      sendJson(response, 404, { error: "voice audio not found" });
      return;
    }
    response.writeHead(200, {
      "content-type": PCM_CONTENT_TYPE,
      "content-length": found.size,
      "cache-control": "private, no-store",
      "x-moa-session-id": sessionId,
      "x-moa-turn-id": turnId,
      "x-moa-audio-kind": kind,
    });
    found.stream.pipe(response);
  }

  function voiceStorageFileProblem(sessionId, turnId, kind, expectedBytes) {
    const filePath = voiceTurnAudioPath(sessionId, turnId, kind);
    if (!filePath || !fs.existsSync(filePath)) {
      // In gcs mode a missing spool file usually means the janitor already
      // pruned a confirmed upload. This diagnosis stays synchronous, so defer
      // to the GET endpoint (which reads through to the bucket) instead of
      // reporting a fault for archived audio.
      if (blobStore.mode === "gcs") {
        return "";
      }
      return `${kind} audio archive missing`;
    }
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      return `${kind} audio archive is not a file`;
    }
    if (stat.size !== expectedBytes) {
      return `${kind} audio archive size mismatch (${stat.size} != ${expectedBytes})`;
    }
    return "";
  }

  return {
    voiceTurnAudioRefs,
    voiceTurnAudioRef,
    voiceTurnAudioKey,
    voiceTurnAudioPath,
    deleteVoiceTurnPcm,
    sendVoiceAudio,
    voiceStorageFileProblem,
  };
}

module.exports = { createVoiceTurnAudio };
