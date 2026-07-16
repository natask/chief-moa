"use strict";

const { transcribeCaptureBlock } = require("./capture-blocks");

function createCaptureBlockHandlers(options = {}) {
  const { store, audioNotes, authorized, sendJson, readJsonBody, createStt } = options;
  const pending = new Set();

  function schedule(block) {
    if (!block || block.transcription?.state !== "queued") return;
    const task = Promise.resolve().then(async () => {
      let stt;
      try {
        stt = await createStt();
      } catch (error) {
        stt = {
          id: "unavailable-stt",
          transcribe: async () => { throw error; },
        };
      }
      await transcribeCaptureBlock(store, block.id, {
        stt,
        claim_id: `stt-${block.transcription.attempt + 1}`,
      });
    }).catch(() => {
      // transcribeCaptureBlock stores the bounded failure on the capture block.
    }).finally(() => pending.delete(task));
    pending.add(task);
  }

  async function route(request, response, url) {
    const match = matchRoute(request.method, url.pathname);
    if (!match) return false;
    if (!authorized(request)) {
      sendJson(response, 401, { error: "missing or invalid gateway token" });
      return true;
    }
    try {
      if (match.operation === "create") {
        const body = await readJsonBody(request);
        const noteId = cleanId(body.audio_note_id || body.audio_note?.id);
        const note = noteId ? audioNotes.get(noteId) : null;
        if (!note || !audioNotes.audioPath(noteId)) {
          sendJson(response, 404, { error: "stored audio note not found" });
          return true;
        }
        const block = store.create({
          idempotency_key: body.idempotency_key,
          owner_id: body.owner_id,
          session_id: body.session_id || note.session_id,
          source_surface: body.source_surface || note.surface,
          input_languages: body.input_languages,
          audio_note: {
            id: note.id,
            href: note.audio?.href,
            content_type: note.content_type,
            bytes: note.bytes,
          },
        });
        schedule(block);
        sendJson(response, 202, { capture_block: block });
        return true;
      }

      if (match.operation === "detail") {
        const block = store.detail(match.id);
        sendJson(response, block ? 200 : 404, block ? { capture_block: block } : { error: "capture block not found" });
        return true;
      }

      const body = await readJsonBody(request);
      if (match.operation === "retry") {
        const block = store.retry(match.id, body);
        schedule(block);
        sendJson(response, 202, { capture_block: block });
      } else if (match.operation === "revision") {
        sendJson(response, 201, { revision: store.addRevision(match.id, body) });
      } else {
        sendJson(response, 200, { capture_block: store.tombstone(match.id, body) });
      }
      return true;
    } catch (error) {
      sendJson(response, Number(error?.statusCode) || 400, { error: cleanError(error) });
      return true;
    }
  }

  async function drain() {
    await Promise.all([...pending]);
  }

  return { route, drain };
}

function matchRoute(method, pathname) {
  if (method === "POST" && pathname === "/v1/capture-blocks") return { operation: "create" };
  const parts = String(pathname || "").split("/").filter(Boolean);
  if (parts[0] !== "v1" || parts[1] !== "capture-blocks" || !parts[2]) return null;
  const id = cleanId(decode(parts[2]));
  if (!id) return null;
  if (method === "GET" && parts.length === 3) return { operation: "detail", id };
  if (method === "POST" && parts.length === 4 && parts[3] === "retry") return { operation: "retry", id };
  if (method === "POST" && parts.length === 4 && parts[3] === "revisions") return { operation: "revision", id };
  if (method === "DELETE" && parts.length === 3) return { operation: "tombstone", id };
  return null;
}

function cleanId(value) {
  return typeof value === "string" ? value.trim().replace(/[^a-zA-Z0-9_.:-]/g, "").slice(0, 160) : "";
}

function decode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}

function cleanError(error) {
  return String(error?.message || error || "capture block request failed").replace(/[\r\n]+/g, " ").slice(0, 500);
}

module.exports = { createCaptureBlockHandlers, matchRoute };
