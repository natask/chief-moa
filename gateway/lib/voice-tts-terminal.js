"use strict";

function summarizeTtsTerminal(providerResult, providerEvents, turn, assistantText, confirmationTts) {
  const error = providerResult?.tts_error || confirmationTts?.tts_error || "";
  const spoke = confirmationTts?.spoke === true
    ? true
    : (typeof providerResult?.tts_spoke === "boolean"
      ? providerResult.tts_spoke
      : (providerEvents.assistantAudioStarted ? true : undefined));
  const delivery = sanitizeTtsDelivery(providerResult?.tts_delivery)
    || (error ? (spoke ? "partial" : "failed") : (spoke ? "complete" : "not_requested"));
  const complete = delivery === "complete";
  const segments = Number.isFinite(providerResult?.tts_segments)
    ? Math.max(0, Math.round(providerResult.tts_segments))
    : turn.assistantAudioSegments.length;
  const spokenTextEnd = Number.isFinite(providerResult?.tts_spoken_text_end)
    ? Math.max(0, Math.round(providerResult.tts_spoken_text_end))
    : (complete ? assistantText.length : 0);
  const replyTextChars = Number.isFinite(providerResult?.tts_reply_text_chars)
    ? Math.max(0, Math.round(providerResult.tts_reply_text_chars))
    : assistantText.length;
  return { complete, delivery, error, replyTextChars, segments, spokenTextEnd, spoke };
}

function sanitizeTtsDelivery(value) {
  const delivery = String(value || "").trim().toLowerCase();
  return ["complete", "partial", "failed", "not_requested"].includes(delivery) ? delivery : "";
}

module.exports = { sanitizeTtsDelivery, summarizeTtsTerminal };
