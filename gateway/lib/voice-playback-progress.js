"use strict";

// Pure playback-progress math for streamed assistant audio, extracted from
// lib/voice-session-server.js: segment normalization, endpoint playback
// checkpoints, and the played-text estimate used by interruption "continue".

function normalizeAssistantAudioSegment(segment, existingSegments, { format, maxTextChars }) {
  if (!segment || typeof segment !== "object" || Array.isArray(segment)) {
    return null;
  }
  const fallbackIndex = Array.isArray(existingSegments) ? existingSegments.length : 0;
  const segmentIndex = Number(segment.segment_index);
  const textStart = Math.max(0, Math.round(Number(segment.text_start) || 0));
  const textEnd = Math.max(textStart, Math.round(Number(segment.text_end) || textStart));
  const audioBytes = Math.max(0, Math.round(Number(segment.audio_bytes) || 0));
  const pcmMs = Math.max(0, Math.round(Number(segment.pcm_ms) || estimatePcmMs(audioBytes, format)));
  const text = String(segment.text || "").replace(/\s+/g, " ").trim().slice(0, maxTextChars);
  return {
    segment_index: Number.isFinite(segmentIndex) && segmentIndex >= 0 ? Math.round(segmentIndex) : fallbackIndex,
    text_start: textStart,
    text_end: textEnd,
    ...(text ? { text } : {}),
    audio_bytes: audioBytes,
    pcm_ms: pcmMs,
  };
}

function normalizePlaybackProgress(event, turn, { format, maxTextChars }) {
  const segments = Array.isArray(turn?.assistantAudioSegments) ? turn.assistantAudioSegments : [];
  const describedBytes = segments.length > 0
    ? segments.reduce((sum, segment) => sum + Math.max(0, Number(segment.audio_bytes) || 0), 0)
    : Math.max(0, Number(turn?.assistantAudioBytes) || 0);
  // Segment metadata is deliberately sent immediately before its binary PCM
  // frame. During that small window it describes queued audio, not emitted
  // audio, so never let a client checkpoint exceed bytes actually written.
  const maxBytes = Math.min(describedBytes, Math.max(0, Number(turn?.assistantAudioBytes) || 0));
  const describedPcmMs = segments.length > 0
    ? segments.reduce((sum, segment) => sum + Math.max(0, Number(segment.pcm_ms) || 0), 0)
    : estimatePcmMs(maxBytes, format);
  const maxPcmMs = Math.min(describedPcmMs, estimatePcmMs(maxBytes, format));
  const rawPlayedBytes = Number(event.played_audio_bytes ?? event.played_bytes);
  const rawPlayedPcmMs = Number(event.played_pcm_ms);
  if (maxBytes <= 0 || ((!Number.isFinite(rawPlayedBytes) || rawPlayedBytes < 0)
      && (!Number.isFinite(rawPlayedPcmMs) || rawPlayedPcmMs < 0))) {
    return null;
  }
  const segmentIndex = Number(event.segment_index);
  const maxIndex = segments.length > 0 ? segments.length - 1 : -1;
  const boundedIndex = Number.isFinite(segmentIndex) && segmentIndex >= 0
    ? Math.min(maxIndex >= 0 ? maxIndex : Math.round(segmentIndex), Math.round(segmentIndex))
    : maxIndex;
  const segmentCeiling = boundedIndex >= 0
    ? cumulativeSegmentProgress(segments, boundedIndex)
    : { audioBytes: maxBytes, pcmMs: maxPcmMs };
  const emittedBytes = Math.max(0, Math.min(maxBytes, segmentCeiling.audioBytes));
  const emittedPcmMs = Math.max(0, Math.min(maxPcmMs, segmentCeiling.pcmMs));
  const bytesFromMs = Number.isFinite(rawPlayedPcmMs) && rawPlayedPcmMs >= 0
    ? estimatePcmBytes(rawPlayedPcmMs, format)
    : null;
  const playedAudioBytes = Math.max(0, Math.min(
    emittedBytes,
    Number.isFinite(rawPlayedBytes) && rawPlayedBytes >= 0
      ? Math.round(rawPlayedBytes)
      : (Number.isFinite(bytesFromMs) ? bytesFromMs : emittedBytes)
  ));
  const playedPcmMs = Math.max(0, Math.min(
    emittedPcmMs,
    Number.isFinite(rawPlayedPcmMs) && rawPlayedPcmMs >= 0
      ? Math.round(rawPlayedPcmMs)
      : estimatePcmMs(playedAudioBytes, format)
  ));
  const textEstimate = estimatePlayedTextFromSegments(segments, playedAudioBytes, playedPcmMs, { maxTextChars });
  return {
    endpoint_observed: true,
    updated_at: new Date().toISOString(),
    ...(boundedIndex >= 0 ? { segment_index: boundedIndex } : {}),
    played_audio_bytes: playedAudioBytes,
    played_pcm_ms: playedPcmMs,
    emitted_audio_bytes: emittedBytes,
    emitted_pcm_ms: emittedPcmMs,
    estimated_text_chars: textEstimate.textChars,
    estimated_text: textEstimate.text,
  };
}

function hasPartialEndpointPlayback(turn) {
  const progress = turn?.playbackProgress;
  if (!progress?.endpoint_observed) {
    return false;
  }
  const emitted = Math.max(0, Number(progress.emitted_audio_bytes) || 0);
  const played = Math.max(0, Number(progress.played_audio_bytes) || 0);
  return emitted > 0 && played < emitted;
}

function cumulativeSegmentProgress(segments, uptoIndex) {
  let audioBytes = 0;
  let pcmMs = 0;
  for (const segment of segments) {
    const index = Math.max(0, Number(segment?.segment_index) || 0);
    if (index > uptoIndex) {
      break;
    }
    audioBytes += Math.max(0, Number(segment?.audio_bytes) || 0);
    pcmMs += Math.max(0, Number(segment?.pcm_ms) || 0);
  }
  return { audioBytes, pcmMs };
}

function estimatePlayedTextFromSegments(segments, playedAudioBytes, playedPcmMs, { maxTextChars }) {
  let textChars = 0;
  const textParts = [];
  let remainingBytes = Math.max(0, Number(playedAudioBytes) || 0);
  let remainingMs = Math.max(0, Number(playedPcmMs) || 0);
  for (const segment of segments) {
    const segmentBytes = Math.max(0, Number(segment?.audio_bytes) || 0);
    const segmentMs = Math.max(0, Number(segment?.pcm_ms) || 0);
    const textStart = Math.max(0, Number(segment?.text_start) || 0);
    const textEnd = Math.max(textStart, Number(segment?.text_end) || textStart);
    const segmentText = String(segment?.text || "");
    const segmentTextChars = Math.max(0, textEnd - textStart);
    if (remainingBytes <= 0 && remainingMs <= 0) {
      break;
    }
    const ratioByBytes = segmentBytes > 0 ? Math.min(1, remainingBytes / segmentBytes) : 0;
    const ratioByMs = segmentMs > 0 ? Math.min(1, remainingMs / segmentMs) : 0;
    const ratio = Math.max(ratioByBytes, ratioByMs, (segmentBytes === 0 && segmentMs === 0 && segmentTextChars > 0) ? 1 : 0);
    if (ratio <= 0) {
      break;
    }
    const takeChars = ratio >= 1
      ? segmentTextChars
      : Math.max(0, Math.min(segmentTextChars, Math.floor(segmentTextChars * ratio)));
    textChars = Math.max(textChars, textStart + takeChars);
    if (segmentText) {
      const relativeChars = Math.min(segmentText.length, Math.max(0, textChars - textStart));
      if (ratio >= 1) {
        textParts.push(segmentText);
      } else if (relativeChars > 0) {
        textParts.push(segmentText.slice(0, relativeChars));
      }
    }
    remainingBytes = Math.max(0, remainingBytes - segmentBytes);
    remainingMs = Math.max(0, remainingMs - segmentMs);
  }
  return {
    textChars,
    text: textParts.join(" ").replace(/\s+/g, " ").trim().slice(0, maxTextChars),
  };
}

function estimatePcmMs(audioBytes, format) {
  const bytes = Math.max(0, Number(audioBytes) || 0);
  const sampleRate = Math.max(1, Number(format?.sample_rate) || 16000);
  const channels = Math.max(1, Number(format?.channels) || 1);
  return Math.round((bytes / (sampleRate * channels * 2)) * 1000);
}

function estimatePcmBytes(pcmMs, format) {
  const ms = Math.max(0, Number(pcmMs) || 0);
  const sampleRate = Math.max(1, Number(format?.sample_rate) || 16000);
  const channels = Math.max(1, Number(format?.channels) || 1);
  return Math.round((ms / 1000) * sampleRate * channels * 2);
}

// Only the two turn_progress stages the clients understand are accepted; an
// unknown stage is ignored so the running stage is left unchanged.
function normalizeProgressStage(stage) {
  const value = String(stage || "").trim().toLowerCase();
  return value === "reasoning" || value === "tts" ? value : "";
}

module.exports = {
  cumulativeSegmentProgress,
  estimatePcmBytes,
  estimatePcmMs,
  estimatePlayedTextFromSegments,
  hasPartialEndpointPlayback,
  normalizeAssistantAudioSegment,
  normalizePlaybackProgress,
  normalizeProgressStage,
};
