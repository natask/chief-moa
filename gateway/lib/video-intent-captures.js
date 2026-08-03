"use strict";

const crypto = require("node:crypto");

const PROMPT_VERSION = "video-intent-transcript-v1";
const PLACEHOLDER = "Captured video awaiting a transcript; open the preserved recording and retry transcription.";

function stableIntentId(noteId) {
  return `intent_video_${crypto.createHash("sha256").update(String(noteId)).digest("hex").slice(0, 32)}`;
}

function parseVideoTranscriptAnalysis(raw) {
  const text = String(raw || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("video transcription returned invalid JSON");
  let parsed;
  try { parsed = JSON.parse(text.slice(start, end + 1)); } catch { throw new Error("video transcription returned invalid JSON"); }
  if (typeof parsed?.transcript !== "string" || !parsed.transcript.trim()) {
    throw new Error("video transcription returned an empty transcript");
  }
  if (Buffer.byteLength(parsed.transcript, "utf8") > 64_000) {
    throw new Error("video transcription exceeds 64000 bytes");
  }
  return { transcript: parsed.transcript };
}

function editableProjection(transcript) {
  if (transcript.length <= 2_000) return { text: transcript, truncated: false };
  return {
    text: `${transcript.slice(0, 1_900)}\n\n[Editable view is a prefix; the full provider transcript remains in source history.]`,
    truncated: true,
  };
}

function createVideoIntentCaptureService({ videoNotes, intents, analyzeVideo, now = () => new Date().toISOString() } = {}) {
  if (!videoNotes?.get || !videoNotes?.annotateTranscript || !videoNotes?.linkIntent
    || !intents?.capture || !intents?.recordSource) {
    throw new Error("video intent capture requires video-note and intent-runtime stores");
  }
  if (typeof analyzeVideo !== "function") throw new Error("video intent capture requires an analyzer");

  async function capture(noteId, input = {}) {
    if (input.user_confirmed !== true) throw new Error("user_confirmed must be true; stopping capture is the admission boundary");
    const note = videoNotes.get(noteId);
    if (!note) throw Object.assign(new Error("video note not found"), { statusCode: 404 });
    const intentId = stableIntentId(note.id);
    const current = await intents.get(intentId);
    if (note.transcript?.state === "complete" && current?.exists) return response(note, current);

    let transcript = note.transcript?.state === "complete" ? String(note.transcript.text || "") : "";
    let transcriptMeta = note.transcript?.state === "complete" ? note.transcript : null;
    if (!transcriptMeta) {
      try {
        const analyzed = await analyzeVideo(note);
        transcript = String(analyzed?.transcript || "");
        if (!transcript.trim() || Buffer.byteLength(transcript, "utf8") > 64_000) {
          throw new Error("video transcription returned an invalid transcript");
        }
        transcriptMeta = {
          state: "complete", text: transcript,
          provider: analyzed.provider, model: analyzed.model,
          prompt_version: analyzed.prompt_version || PROMPT_VERSION,
          created_at: now(),
        };
      } catch (error) {
        transcriptMeta = {
          state: "failed", text: "", created_at: now(),
          prompt_version: PROMPT_VERSION, error: cleanError(error),
        };
      }
    }
    const sourceNote = videoNotes.annotateTranscript(note.id, transcriptMeta);

    const projection = editableProjection(transcript || PLACEHOLDER);
    let intent = current;
    if (!intent?.exists) {
      intent = await intents.capture({
        intent_id: intentId,
        statement: projection.text,
        normalized_objective: projection.text,
        source: {
          session_id: note.session_id || "",
          turn_id: note.id,
          surface: note.surface || "browser",
          transcript_ref: `${note.evidence_ref}#transcript`,
        },
        evidence_refs: [note.evidence_ref],
        artifact_refs: [note.evidence_ref],
        next_step: transcript ? "Review or edit this captured intent before any dispatch." : "Retry transcription from the preserved recording.",
        user_confirmed: true,
        idempotency_key: `video-capture:${note.id}`,
        actor: { kind: "user", id: note.surface || "video-capture" },
      });
    } else if (transcript && !intent.source_revisions?.some((item) => item.source_ref === `${note.evidence_ref}#transcript`)) {
      intent = await intents.transition(intentId, {
        type: "intent.enriched",
        statement: projection.text,
        normalized_objective: projection.text,
        next_step: "Review or edit this captured intent before any dispatch.",
        source_receipt_refs: [note.evidence_ref],
        idempotency_key: `video-capture:${note.id}:transcribed`,
      });
    }
    if (transcript && !intent.source_revisions?.some((item) => item.source_ref === `${note.evidence_ref}#transcript`)) {
      intent = await intents.recordSource(intentId, {
        raw_text: transcript,
        media_type: "text/plain; source=video-audio",
        source_ref: `${note.evidence_ref}#transcript`,
        revision: 1,
        idempotency_key: `video-capture:${note.id}:source`,
        provenance: {
          kind: "provider_transcription",
          provider: transcriptMeta.provider || "",
          model: transcriptMeta.model || "",
          prompt_version: transcriptMeta.prompt_version,
          evidence_sha256: note.sha256,
          evidence_content_type: note.content_type,
          evidence_retention: note.retention,
          editable_projection_truncated: projection.truncated,
          admitted_by: "explicit_stop",
        },
      });
    }
    const annotated = videoNotes.linkIntent(sourceNote.id, {
      intent_id: intentId, status: intent.lifecycle_state,
    });
    return response(annotated, intent);
  }

  function response(note, intent) {
    return {
      intent,
      evidence: {
        id: note.id, ref: note.evidence_ref, sha256: note.sha256,
        content_type: note.content_type, bytes: note.bytes,
        duration_ms: note.duration_ms, retention: note.retention,
        href: note.video?.href || "", created_at: note.created_at,
      },
      transcript: note.transcript || null,
      dispatch: { automatic: false },
    };
  }

  return { capture };
}

function createVideoIntentCaptureHandlers({ service, authorized, readJsonBody, sendJson, cleanError } = {}) {
  async function routeVideoIntentCaptures(request, response, url) {
    const match = url.pathname.match(/^\/v1\/video-notes\/([^/]+)\/intent$/);
    if (!match || request.method !== "POST") return false;
    if (!authorized(request)) {
      sendJson(response, 401, { error: "missing or invalid gateway token" });
      return true;
    }
    try {
      const result = await service.capture(decodeURIComponent(match[1]), await readJsonBody(request));
      sendJson(response, result.transcript?.state === "complete" ? 201 : 202, result);
    } catch (error) {
      sendJson(response, Number(error?.statusCode) || 400, { error: cleanError(error) });
    }
    return true;
  }
  return { routeVideoIntentCaptures };
}

function cleanError(error) {
  return String(error?.message || error || "unknown error").replace(/[\r\n]+/g, " ").slice(0, 500);
}

module.exports = {
  PROMPT_VERSION,
  createVideoIntentCaptureHandlers,
  createVideoIntentCaptureService,
  parseVideoTranscriptAnalysis,
  stableIntentId,
};
