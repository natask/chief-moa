(function installContentVoicePolicyRuntime(global) {
  "use strict";

  const PROFILE_LANGUAGE_NAMES = ["english", "amharic", "a m h a r i c"];
  const PROFILE_VOICE_NAMES = ["puck", "charon", "kore", "fenrir", "aoede", "leda", "orus", "zephyr"];

  function finiteNumber(...values) {
    for (const value of values) {
      const number = Number(value);
      if (Number.isFinite(number)) return number;
    }
    return null;
  }

  function normalizeAssistantAudioSegment(message) {
    if (!message || typeof message !== "object") return null;
    const sourceDurationMs = finiteNumber(
      message.pcm_ms,
      message.source_duration_ms,
      message.sourceDurationMs,
      message.duration_ms,
      message.durationMs,
    );
    if (!(sourceDurationMs > 0)) return null;
    const playbackRate = finiteNumber(message.playback_rate, message.playbackRate, message.rate);
    const textStartChar = finiteNumber(message.text_char_start, message.textStartChar, message.text_start, message.textStart);
    const textEndChar = finiteNumber(message.text_char_end, message.textEndChar, message.text_end, message.textEnd);
    const segmentIndex = finiteNumber(message.segment_index, message.segmentIndex, message.index);
    return {
      segmentIndex: segmentIndex != null ? Math.max(0, Math.round(segmentIndex)) : null,
      sourceDurationMs,
      playbackRate: playbackRate && playbackRate > 0 ? playbackRate : null,
      textStartChar: textStartChar != null ? Math.max(0, Math.round(textStartChar)) : null,
      textEndChar: textEndChar != null ? Math.max(0, Math.round(textEndChar)) : null,
    };
  }

  function recordAssistantPlaybackSegment(state, source, audioBuffer, startAt, fallbackRate) {
    const metadata = state?.pendingAssistantAudioSegments?.shift();
    if (!metadata || !source || !audioBuffer) return;
    const playbackRate = metadata.playbackRate || (fallbackRate > 0 ? fallbackRate : 1);
    state.playedAssistantAudioSegments ||= [];
    const previous = state.playedAssistantAudioSegments.at(-1);
    const sourceStartMs = previous ? previous.sourceStartMs + previous.sourceDurationMs : 0;
    state.playedAssistantAudioSegments.push({
      segmentIndex: metadata.segmentIndex,
      sourceStartMs,
      sourceDurationMs: metadata.sourceDurationMs,
      playbackRate,
      textStartChar: metadata.textStartChar,
      textEndChar: metadata.textEndChar,
      scheduledAt: startAt,
      wallDurationMs: (audioBuffer.duration / playbackRate) * 1000,
    });
  }

  function computePlaybackProgress(state, currentTime) {
    if (!state?.playedAssistantAudioSegments?.length || !Number.isFinite(currentTime)) return null;
    let best = null;
    for (const segment of state.playedAssistantAudioSegments) {
      if (!(segment?.sourceDurationMs > 0) || !(segment?.sourceStartMs >= 0) || !Number.isFinite(segment?.scheduledAt)) continue;
      const elapsedWallMs = Math.max(0, (currentTime - segment.scheduledAt) * 1000);
      const playbackRate = segment.playbackRate > 0 ? segment.playbackRate : 1;
      const playedMs = Math.max(0, Math.min(segment.sourceDurationMs, elapsedWallMs * playbackRate));
      if (!(playedMs > 0)) continue;
      const playedToMs = segment.sourceStartMs + playedMs;
      if (!best || playedToMs > best.played_pcm_ms) {
        best = {
          type: "playback_progress",
          turn_id: state.turnId,
          segment_index: segment.segmentIndex,
          playback_rate: playbackRate,
          played_pcm_ms: Math.round(playedToMs),
        };
        if (segment.textStartChar != null && segment.textEndChar != null && segment.textEndChar >= segment.textStartChar) {
          const span = segment.textEndChar - segment.textStartChar;
          const playedTextChars = Math.round(span * Math.min(1, playedMs / segment.sourceDurationMs));
          best.text_char_start = segment.textStartChar;
          best.text_char_end = segment.textEndChar;
          best.played_text_char_end = Math.min(segment.textEndChar, segment.textStartChar + playedTextChars);
        }
      }
    }
    return best;
  }

  function mergeLiveVoiceTranscript(previous, incoming) {
    const prior = String(previous || "").trim();
    const next = String(incoming || "").trim();
    if (!prior) return next;
    if (!next) return prior;
    if (next.startsWith(prior)) return next;
    if (prior.endsWith(next)) return prior;
    const priorWords = prior.split(/\s+/);
    const nextWords = next.split(/\s+/);
    const maxOverlap = Math.min(priorWords.length, nextWords.length, 8);
    for (let count = maxOverlap; count > 0; count -= 1) {
      const priorTail = priorWords.slice(priorWords.length - count).join(" ").toLowerCase();
      const nextHead = nextWords.slice(0, count).join(" ").toLowerCase();
      if (priorTail === nextHead) return priorWords.concat(nextWords.slice(count)).join(" ");
    }
    return `${prior} ${next}`;
  }

  function normalizeSpokenCommand(value) {
    return String(value || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  }

  function isPageContextTranscript(text) {
    const raw = String(text || "").trim();
    if (!raw || raw.length > 260 || raw.split(/\r?\n/).length > 3) return false;
    const lower = raw.toLowerCase();
    if (/\bwhat\s+(?:am i|are we)\s+(?:looking at|seeing|viewing)\b|\bwhat(?:'s| is)\s+on\s+(?:my|this|the)\s+screen\b/i.test(raw)) return true;
    if (!/\b(?:this|current|visible|open|active)\s+(?:web\s*)?(?:page|site|tab|screen|view|button|form|field|link)\b/i.test(raw)) return false;
    return /\b(?:summari[sz]e|read|describe|check|inspect|analy[sz]e|explain|review|scan)\b/i.test(raw) ||
      /\b(?:what|where|which|who|why|how|can|does|is|are|should)\b/i.test(lower) || /\?$/.test(raw);
  }

  function parseAssistantSpeechOverlapIntent(text) {
    const lower = normalizeSpokenCommand(text);
    if (!lower) return null;
    const disable = [
      "turn barge in back on", "barge in back on", "stop talking when i talk", "stop speaking when i speak",
      "interrupt yourself when i talk", "interrupt yourself when i speak", "do not talk over me", "dont talk over me",
    ].some((phrase) => lower.includes(phrase));
    if (disable) return { enabled: false };
    const enable = [
      "continue talking even though i", "keep talking even though i", "continue talking while i", "keep talking while i",
      "keep speaking while i", "continue speaking while i", "talk in the background", "speak in the background",
      "keep talking in the background", "do not interrupt yourself", "don t interrupt yourself", "dont interrupt yourself",
    ].some((phrase) => lower.includes(phrase));
    return enable ? { enabled: true } : null;
  }

  function containsProfileWord(lower, values) {
    return values.some((value) => lower.includes(value));
  }

  function isPromptProfileControl(lower) {
    return lower.includes("what prompt") || lower.includes("which prompt") || lower.includes("current prompt") ||
      /\b(set|change|update)\b.*\b(system )?prompt\b/.test(lower);
  }

  function isIdentityProfileControl(lower) {
    return lower.includes("what is your name") || lower.includes("what s your name") || lower.includes("who are you") ||
      /\byour name\b\s*(is|should be|will be)\b/.test(lower) || /\b(call|name) yourself\b/.test(lower) ||
      /\b(you are|youre)\b\s+(now\s+)?(called\s+|named\s+)?/.test(lower);
  }

  function isLanguageProfileControl(lower) {
    if (lower.includes("what language") || lower.includes("which language") || lower.includes("language is active") ||
      /\b(set|change|update|switch)\b.*\blanguage\b/.test(lower)) return true;
    if (!containsProfileWord(lower, PROFILE_LANGUAGE_NAMES)) return false;
    return /\b(speak|talk|reply|respond|answer|say)\b/.test(lower) || lower.includes(" only ") || lower.startsWith("only ") ||
      lower.includes("do not switch") || lower.includes("don t switch") || lower.includes("dont switch") ||
      lower.includes("these languages") || lower.includes("these two languages");
  }

  function isVoiceProfileControl(lower) {
    if (lower.includes("what voice") || lower.includes("which voice") || /\b(set|change|switch|use|make)\b.*\bvoice\b/.test(lower)) return true;
    if (lower.includes("sound like") || lower.includes("speak like")) {
      return /\b(female|woman|girl|feminine|lady|male|man|guy|masculine|boy)\b/.test(lower) || containsProfileWord(lower, PROFILE_VOICE_NAMES);
    }
    return containsProfileWord(lower, PROFILE_VOICE_NAMES) && /\b(use|switch|set|change)\b/.test(lower);
  }

  function isProfileControlTranscript(text) {
    const lower = normalizeSpokenCommand(text);
    return !!lower && (isPromptProfileControl(lower) || isIdentityProfileControl(lower) || isLanguageProfileControl(lower) || isVoiceProfileControl(lower));
  }

  function shouldRouteLiveTranscriptThroughGateway(text) {
    return isProfileControlTranscript(text) || isPageContextTranscript(text);
  }

  const root = global || globalThis;
  root.AgeeContentVoicePolicyRuntime = Object.freeze({
    computePlaybackProgress,
    finiteNumber,
    isPageContextTranscript,
    isProfileControlTranscript,
    mergeLiveVoiceTranscript,
    normalizeAssistantAudioSegment,
    normalizeSpokenCommand,
    parseAssistantSpeechOverlapIntent,
    recordAssistantPlaybackSegment,
    shouldRouteLiveTranscriptThroughGateway,
  });
})(typeof globalThis !== "undefined" ? globalThis : this);
