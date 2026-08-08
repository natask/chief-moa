"use strict";

// Streaming STT session orchestration for Google Speech v2 streamingRecognize.
//
// This module is deliberately Google-agnostic: it knows nothing about gRPC,
// auth, or the Chirp message shape. The caller injects:
//
//   openStream()          -> a Node duplex stream (the live streamingRecognize
//                            call). It must already be primed to receive the
//                            config message first, then audio messages.
//   configMessage         -> the first message written to a freshly opened
//                            stream (streamingConfig).
//   audioMessage(chunk)   -> wrap a PCM16 Buffer into a stream message.
//   parseResults(data)    -> array of { transcript, isFinal, languageCode } for
//                            a single 'data' event payload.
//   onPartial(text)       -> async; broadcast the live (interim) transcript.
//   onFinalSegment(info)  -> async; report a provider-declared natural speech
//                            boundary with its absolute PCM byte offset.
//
// Everything Google-specific lives in the provider; everything about UNBOUNDED
// duration lives here. gRPC streamingRecognize sessions are capped by the
// server (~5 min). To make speech effectively unbounded we ROTATE: shortly
// before the cap (and on unexpected stream error) we half-close the current
// stream, drain its final results, open a fresh stream, and replay any audio
// that arrived during the transition. Final transcripts are concatenated across
// every rotation.
//
// Nothing here throws out of push()/finalize()/abort(): a streaming fault is a
// soft failure. finalize() reports ok:false so the provider falls back to the
// batch path — a broken stream must never fail the turn.

const DEFAULT_ROTATE_AFTER_MS = 240000; // 4 min, safely under the ~5-min server cap
// A live interim transcript is already useful at commit. Keep the final-result
// drain short so releasing push-to-talk does not add a multi-second silent gap
// before reasoning starts. If the stream has no usable text, the provider still
// falls back to the stored-PCM batch path.
const DEFAULT_DRAIN_TIMEOUT_MS = 800;
// A single session tolerates this many consecutive unexpected stream errors
// (each triggers a reopen). Past it, the session gives up and finalize() falls
// back to batch. A clean rotation does not count against this budget.
const MAX_CONSECUTIVE_ERRORS = 2;

function noopLogger() {}

function joinTranscript(a, b) {
  const left = String(a || "").trim();
  const right = String(b || "").trim();
  if (!left) return right;
  if (!right) return left;
  if (right.startsWith(`${left} `)) return right;

  // Providers may resend a finalized hypothesis after a retry/reconnect, or
  // start a replacement stream with a short recognition overlap. Reconcile a
  // meaningful word boundary instead of blindly appending the whole block.
  // Keep one- and two-word repeats ("yes yes", names, corrections) intact:
  // without provider identity they are valid speech, not safe duplicates.
  const leftWords = transcriptWords(left);
  const rightWords = transcriptWords(right);
  if (rightWords.length >= 3 && left.endsWith(` ${right}`)) return left;
  const maxOverlap = Math.min(leftWords.length, rightWords.length);
  for (let count = maxOverlap; count >= 3; count -= 1) {
    const leftOffset = leftWords.length - count;
    let matches = true;
    for (let index = 0; index < count; index += 1) {
      if (leftWords[leftOffset + index].value !== rightWords[index].value) {
        matches = false;
        break;
      }
    }
    if (matches) {
      if (count === rightWords.length) return left;
      return `${left} ${right.slice(rightWords[count].start)}`.trim();
    }
  }
  return `${left} ${right}`;
}

function transcriptWords(text) {
  const words = [];
  const pattern = /[\p{L}\p{N}]+/gu;
  let match;
  while ((match = pattern.exec(String(text || "")))) {
    words.push({
      value: match[0].toLocaleLowerCase("en-US"),
      start: match.index,
    });
  }
  return words;
}

function createStreamingSttSession(options) {
  const openStream = options?.openStream;
  const configMessage = options?.configMessage;
  const audioMessage = typeof options?.audioMessage === "function"
    ? options.audioMessage
    : (chunk) => ({ audio: chunk });
  const parseResults = typeof options?.parseResults === "function"
    ? options.parseResults
    : () => [];
  const onPartial = typeof options?.onPartial === "function" ? options.onPartial : null;
  const onFinalSegment = typeof options?.onFinalSegment === "function" ? options.onFinalSegment : null;
  const rotateAfterMs = Math.max(10000, Number(options?.rotateAfterMs) || DEFAULT_ROTATE_AFTER_MS);
  const drainTimeoutMs = Math.max(200, Number(options?.drainTimeoutMs) || DEFAULT_DRAIN_TIMEOUT_MS);
  const logger = typeof options?.logger === "function" ? options.logger : noopLogger;

  if (typeof openStream !== "function") {
    throw new Error("createStreamingSttSession requires an openStream() factory");
  }

  const state = {
    committedText: "", // all finalized segments across all streams
    interim: "", // latest interim from the current stream
    rotations: 0,
    consecutiveErrors: 0,
    aborted: false,
    finalized: false,
    fatal: false,
    fatalReason: "",
    stream: null,
    rotateTimer: null,
    // Audio buffered while a rotation is mid-flight (old stream draining, new
    // stream not yet open). Replayed into the new stream so no speech is lost.
    pendingChunks: [],
    // Serializes rotations so overlapping timer/error triggers don't race.
    rotating: false,
    rotationPromise: null,
    finalizing: false,
    finalizePromise: null,
    streamedAudioBytes: 0,
    coverageIncomplete: false,
    languageCode: "",
    streamGeneration: 0,
    // Google may redeliver the same finalized result during gRPC retry. A
    // provider result identity is scoped to one stream generation; rotations
    // get a new namespace so identical words spoken later remain legitimate.
    finalSegmentIds: new Set(),
    finalSegments: [],
    lastFinalAudioByteOffset: 0,
    totalAudioBytes: 0,
  };

  function currentDisplayText() {
    return joinTranscript(state.committedText, state.interim);
  }

  function emitPartial() {
    if (!onPartial) return;
    const text = currentDisplayText();
    if (!text) return;
    // Fire-and-forget: a partial broadcast failure must never break capture.
    Promise.resolve()
      .then(() => onPartial(text))
      .catch((error) => logger("stt_stream_partial_error", { error: String(error?.message || error) }));
  }

  function handleData(data, streamContext) {
    let results;
    try {
      results = parseResults(data) || [];
    } catch (error) {
      logger("stt_stream_parse_error", { error: String(error?.message || error) });
      return;
    }
    let changed = false;
    for (const result of results) {
      const transcript = String(result?.transcript || "").trim();
      if (result?.languageCode) {
        state.languageCode = String(result.languageCode);
      }
      if (!transcript) continue;
      if (result?.isFinal) {
        const providerIdentity = String(result?.segmentId || result?.resultEndOffset || "").trim();
        const segmentId = providerIdentity
          ? `${streamContext.generation}:${providerIdentity}`
          : "";
        if (segmentId && state.finalSegmentIds.has(segmentId)) {
          continue;
        }
        if (segmentId) state.finalSegmentIds.add(segmentId);
        const priorCommittedText = state.committedText;
        const cumulative = priorCommittedText && transcript.startsWith(`${priorCommittedText} `);
        state.committedText = cumulative ? transcript : joinTranscript(priorCommittedText, transcript);
        const segmentTranscript = cumulative ? transcript.slice(priorCommittedText.length).trim() : transcript;
        state.interim = "";
        const relativeEndBytes = resultEndOffsetBytes(
          result?.resultEndOffset, options?.bytesPerSecond, options?.frameBytes);
        const candidateEndBytes = relativeEndBytes == null ? null : streamContext.baseAudioByteOffset + relativeEndBytes;
        const absoluteEndBytes = candidateEndBytes != null && candidateEndBytes <= state.totalAudioBytes
          && candidateEndBytes > state.lastFinalAudioByteOffset
          ? candidateEndBytes : null;
        if (absoluteEndBytes != null) {
          state.lastFinalAudioByteOffset = absoluteEndBytes;
          state.finalSegments.push({
            transcript: segmentTranscript,
            endAudioByteOffset: absoluteEndBytes,
            streamGeneration: streamContext.generation,
          });
          if (onFinalSegment) {
            Promise.resolve().then(() => onFinalSegment({
              transcript: segmentTranscript,
              stream_generation: streamContext.generation,
              result_end_offset_ms: Math.round(relativeEndBytes * 1000 / normalizedBytesPerSecond(options?.bytesPerSecond)),
              absolute_audio_byte_offset: absoluteEndBytes,
            })).catch((error) => logger("stt_stream_final_segment_error", { error: String(error?.message || error) }));
          }
        }
        changed = true;
      } else {
        state.interim = transcript;
        changed = true;
      }
    }
    if (changed) {
      // A healthy data event proves the stream is alive; clear the error budget.
      state.consecutiveErrors = 0;
      emitPartial();
    }
  }

  function detachStream(stream) {
    if (!stream) return;
    try {
      stream.removeAllListeners("data");
      stream.removeAllListeners("error");
      stream.removeAllListeners("end");
      // google-gax's StreamProxy can emit a second, delayed `error` after its
      // readable side already emitted `end` (notably the five-minute ABORTED
      // deadline). This stream is retired, so the error cannot affect capture,
      // but EventEmitter treats an unobserved `error` as process-fatal. Keep a
      // terminal listener on every detached stream instead of letting an old
      // provider call crash the gateway and drop unrelated mobile sessions.
      stream.on("error", (error) => {
        try {
          logger("stt_retired_stream_error", { error: String(error?.message || error) });
        } catch {
          // Diagnostics must not restore the process-fatal path being contained.
        }
      });
    } catch {
      // best effort
    }
  }

  function writeToStream(stream, message) {
    if (!stream) return false;
    try {
      stream.write(message);
      return true;
    } catch (error) {
      logger("stt_stream_write_error", { error: String(error?.message || error) });
      return false;
    }
  }

  function openNewStream(baseAudioByteOffset = state.totalAudioBytes) {
    let stream;
    try {
      stream = openStream();
    } catch (error) {
      state.fatal = true;
      state.fatalReason = `open failed: ${String(error?.message || error)}`;
      logger("stt_stream_open_error", { error: state.fatalReason });
      return null;
    }
    if (!stream || typeof stream.write !== "function") {
      state.fatal = true;
      state.fatalReason = "openStream() did not return a writable stream";
      return null;
    }
    const streamContext = { generation: state.streamGeneration, baseAudioByteOffset };
    stream.on("data", (data) => handleData(data, streamContext));
    stream.on("error", (error) => onStreamError(stream, error));
    stream.on("end", () => onStreamEnd(stream));
    if (configMessage !== undefined && configMessage !== null) {
      if (!writeToStream(stream, configMessage)) {
        state.fatal = true;
        state.fatalReason = "failed to write streaming config";
        return null;
      }
    }
    return stream;
  }

  function onStreamError(stream, error) {
    if (stream !== state.stream) {
      // Error from a stream we already rotated away from — expected during a
      // half-close race. Ignore.
      return;
    }
    logger("stt_stream_error", { error: String(error?.message || error) });
    if (state.aborted || state.finalized || state.finalizing) {
      return;
    }
    state.consecutiveErrors += 1;
    if (state.consecutiveErrors > MAX_CONSECUTIVE_ERRORS) {
      state.fatal = true;
      state.fatalReason = `stream errored ${state.consecutiveErrors}x: ${String(error?.message || error)}`;
      return;
    }
    // Treat an unexpected error as a rotation: reopen and keep going.
    void rotate("error");
  }

  function onStreamEnd(stream) {
    if (stream !== state.stream) return;
    // The server closed the stream on us (e.g. hit its own time limit) while we
    // are still capturing. Rotate to a fresh stream unless we are already
    // tearing down or rotating.
    if (state.aborted || state.finalized || state.finalizing || state.rotating || state.fatal) {
      return;
    }
    void rotate("server_end");
  }

  // Half-close a stream and wait (bounded) for it to flush its final results.
  function drainStream(stream) {
    return new Promise((resolve) => {
      if (!stream) {
        resolve();
        return;
      }
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, drainTimeoutMs);
      timer.unref?.();
      stream.once("end", finish);
      stream.once("error", finish);
      stream.once("close", finish);
      try {
        // half-close: signal end-of-audio so the server emits trailing finals.
        stream.end();
      } catch {
        finish();
      }
    });
  }

  function rotate(reason) {
    if (state.rotationPromise) return state.rotationPromise;
    if (state.aborted || state.finalized || state.finalizing || state.fatal) {
      return Promise.resolve();
    }
    const operation = rotateOnce(reason).catch((error) => {
      state.fatal = true;
      state.fatalReason = `rotation failed: ${String(error?.message || error)}`;
      logger("stt_stream_rotate_error", { error: state.fatalReason });
    });
    state.rotationPromise = operation;
    operation.finally(() => {
      if (state.rotationPromise === operation) state.rotationPromise = null;
    });
    return operation;
  }

  async function rotateOnce(reason) {
    state.rotating = true;
    if (state.rotateTimer) {
      clearTimeout(state.rotateTimer);
      state.rotateTimer = null;
    }
    const old = state.stream;
    state.stream = null;
    // Any final tail still in the old stream is captured while it drains; but
    // its 'data' listener is live, so committedText keeps accumulating.
    logger("stt_stream_rotate", { reason, rotations: state.rotations + 1 });
    await drainStream(old);
    detachStream(old);
    // Fold the last interim of the drained stream into committed text so a
    // rotation never drops the in-flight word.
    if (state.interim) {
      state.committedText = joinTranscript(state.committedText, state.interim);
      state.interim = "";
    }
    if (state.aborted || state.finalized) {
      state.rotating = false;
      return;
    }
    state.streamGeneration += 1;
    const nextBase = state.pendingChunks.length > 0
      ? state.pendingChunks[0].startAudioByteOffset
      : state.totalAudioBytes;
    const next = openNewStream(nextBase);
    if (!next) {
      state.rotating = false;
      return;
    }
    state.stream = next;
    state.rotations += 1;
    // Replay any audio buffered during the transition.
    const pending = state.pendingChunks;
    state.pendingChunks = [];
    for (const entry of pending) {
      if (writeToStream(next, audioMessage(entry.chunk))) {
        state.streamedAudioBytes += entry.chunk.length;
      } else {
        state.coverageIncomplete = true;
      }
    }
    if (!state.finalizing) armRotateTimer();
    state.rotating = false;
  }

  function armRotateTimer() {
    if (state.rotateTimer) {
      clearTimeout(state.rotateTimer);
    }
    state.rotateTimer = setTimeout(() => {
      state.rotateTimer = null;
      void rotate("time_limit");
    }, rotateAfterMs);
    state.rotateTimer.unref?.();
  }

  // Open the first stream eagerly so partials start flowing on the first frame.
  state.stream = openNewStream();
  if (state.stream) {
    armRotateTimer();
  }

  return {
    // Feed one PCM16 frame. Buffered during a rotation; dropped after fatal/abort.
    push(chunk) {
      if (state.aborted || state.finalized || state.finalizing || state.fatal) return;
      if (!chunk || chunk.length === 0) return;
      const startAudioByteOffset = state.totalAudioBytes;
      state.totalAudioBytes += chunk.length;
      if (state.rotating || !state.stream) {
        state.pendingChunks.push({ chunk, startAudioByteOffset });
        return;
      }
      if (writeToStream(state.stream, audioMessage(chunk))) {
        state.streamedAudioBytes += chunk.length;
      } else {
        state.coverageIncomplete = true;
      }
    },

    // Close the session and return the accumulated transcript.
    // { text, ok, error, rotations, languageCode }. ok:false => the provider
    // should fall back to the stored-PCM batch path for this turn.
    async finalize() {
      if (state.finalizePromise) return state.finalizePromise;
      state.finalizePromise = (async () => {
        state.finalizing = true;
        if (state.rotateTimer) {
          clearTimeout(state.rotateTimer);
          state.rotateTimer = null;
        }

        // A commit may race an error/time-limit rotation while that rotation has
        // detached the old stream and is buffering new PCM. Wait only for the
        // rotation's already-bounded drain; if it still cannot finish, force the
        // retained-audio batch path rather than accepting a partial hypothesis.
        const rotation = state.rotationPromise;
        if (rotation) {
          const completed = await waitBounded(rotation, drainTimeoutMs + 200);
          if (!completed || state.rotating) {
            state.coverageIncomplete = true;
            state.fatal = true;
            state.fatalReason = "stream rotation did not finish before finalize";
          }
        }

        const stream = state.stream;
        if (stream) {
          const pending = state.pendingChunks;
          state.pendingChunks = [];
          for (const entry of pending) {
            if (writeToStream(stream, audioMessage(entry.chunk))) {
              state.streamedAudioBytes += entry.chunk.length;
            } else {
              state.coverageIncomplete = true;
            }
          }
          await drainStream(stream);
          detachStream(stream);
        }
        if (state.pendingChunks.length > 0 || state.streamedAudioBytes !== state.totalAudioBytes) {
          state.coverageIncomplete = true;
        }
        if (state.coverageIncomplete && !state.fatal) {
          state.fatal = true;
          state.fatalReason = "streamed audio coverage incomplete";
        }
        if (state.interim) {
          state.committedText = joinTranscript(state.committedText, state.interim);
          state.interim = "";
        }
        state.stream = null;
        state.finalizing = false;
        state.finalized = true;
        return this._result();
      })();
      return state.finalizePromise;
    },

    abort() {
      if (state.aborted) return;
      state.aborted = true;
      if (state.rotateTimer) {
        clearTimeout(state.rotateTimer);
        state.rotateTimer = null;
      }
      const stream = state.stream;
      state.stream = null;
      detachStream(stream);
      try {
        stream?.destroy?.();
      } catch {
        // best effort
      }
    },

    _result() {
      const text = String(state.committedText || "").trim();
      const ok = !state.fatal && !state.aborted;
      return {
        text,
        ok,
        error: state.fatal ? state.fatalReason : (state.aborted ? "aborted" : ""),
        rotations: state.rotations,
        languageCode: state.languageCode || "",
      };
    },

    snapshot() {
      return {
        text: currentDisplayText(),
        committedText: state.committedText,
        interim: state.interim,
        totalAudioBytes: state.totalAudioBytes,
        finalSegments: state.finalSegments.map((segment) => ({ ...segment })),
      };
    },

    // Test/diagnostic surface.
    _state: state,
  };
}

function normalizedBytesPerSecond(value) {
  const bytes = Number(value);
  return Number.isFinite(bytes) && bytes > 0 ? bytes : 32000;
}

function waitBounded(promise, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (completed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(completed);
    };
    const timer = setTimeout(() => finish(false), Math.max(1, Number(timeoutMs) || 1));
    timer.unref?.();
    Promise.resolve(promise).then(() => finish(true), () => finish(true));
  });
}

function resultEndOffsetBytes(value, bytesPerSecond, frameBytesValue) {
  const match = /^(\d+):(\d+)$/.exec(String(value || "").trim());
  if (!match) return null;
  const seconds = Number(match[1]);
  const nanos = Number(match[2]);
  if (!Number.isSafeInteger(seconds) || seconds < 0 || !Number.isSafeInteger(nanos) || nanos < 0 || nanos >= 1e9) {
    return null;
  }
  const exact = (seconds + nanos / 1e9) * normalizedBytesPerSecond(bytesPerSecond);
  const frameBytes = normalizedFrameBytes(frameBytesValue);
  return Math.max(0, Math.floor(exact / frameBytes) * frameBytes);
}
function normalizedFrameBytes(value) { const bytes = Number(value); return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : 2; }

module.exports = {
  createStreamingSttSession,
  DEFAULT_ROTATE_AFTER_MS,
};
