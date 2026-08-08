"use strict";

const DEFAULT_MAX_AGE_MS = 10_000;

function createEarlyAudioBuffer(options = {}) {
  const maxAgeMs = Number(options.maxAgeMs || DEFAULT_MAX_AGE_MS);
  const maxBytes = Number(options.maxBytes || 16_000 * 2 * (maxAgeMs / 1000));
  const now = typeof options.now === "function" ? options.now : Date.now;
  let entries = [], bufferedBytes = 0, failure = null;

  function reset() {
    entries = [];
    bufferedBytes = 0;
    failure = null;
  }

  return {
    append(chunk) {
      if (failure) {
        failure.rejectedBytes += chunk.length;
      } else if (bufferedBytes + chunk.length > maxBytes) {
        failure = { reason: "early_audio_overflow", bufferedBytes,
          rejectedBytes: chunk.length, maxBytes };
      } else {
        entries.push({ at: now(), chunk });
        bufferedBytes += chunk.length;
      }
    },
    reset,
    drain() {
      const chunks = entries;
      let terminalFailure = failure;
      if (!terminalFailure && chunks.some((entry) => entry.at < now() - maxAgeMs)) {
        terminalFailure = { reason: "early_audio_expired", bufferedBytes,
          rejectedBytes: 0, maxBytes };
      }
      reset();
      if (!terminalFailure) return { chunks, error: null };
      const error = new Error(`leading audio exceeded the ${maxAgeMs}ms session admission window`);
      error.code = terminalFailure.reason;
      error.details = terminalFailure;
      return { chunks: [], error };
    },
  };
}

module.exports = { createEarlyAudioBuffer };
