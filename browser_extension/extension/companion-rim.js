// The companion rim's runtime half: it owns --agee-level and nothing else.
// Contract: reference/design/overlay-2026-07-28/spec.md sections 3 and 3.1.
//
// The rim itself is pure CSS on the launcher's .agee-ring (overlay.css). This
// file only decides what number the CSS reads, once per frame:
//   listening -> the mic RMS the worklet sends, through the envelope
//   speaking  -> synthetic playback level (no AnalyserNode on the TTS path)
//   anything else -> 0, and the frame loop stops
// The maths lives in companion-level.js so it can be tested without a browser.
(function initAgeeCompanionRim(global) {
  "use strict";

  const LEVEL_VAR = "--agee-level";
  // A sample older than this means the microphone went quiet or the socket
  // stalled; release toward 0 rather than freezing the rim at the last value.
  const SAMPLE_STALE_MS = 120;

  function createCompanionRim(root, options = {}) {
    const maths = options.maths || global.AgeeCompanionLevel;
    const raf = options.requestAnimationFrame
      || ((callback) => global.requestAnimationFrame(callback));
    const cancelRaf = options.cancelAnimationFrame
      || ((handle) => global.cancelAnimationFrame(handle));
    const now = options.now || (() => (global.performance?.now?.() ?? Date.now()));
    const envelope = maths.createLevelEnvelope();

    let state = "idle";
    let frame = 0;
    let lastSampleAt = 0;
    let speakingStartedAt = 0;
    let written = "";

    function write(level) {
      const next = maths.formatLevel(level);
      if (next === written) return;
      written = next;
      root?.style?.setProperty(LEVEL_VAR, next);
    }

    function tick() {
      frame = 0;
      if (state === "listening") {
        if (now() - lastSampleAt > SAMPLE_STALE_MS) envelope.decay();
        write(envelope.value);
        schedule();
        return;
      }
      if (state === "speaking") {
        write(envelope.set(maths.speakingLevel(now() - speakingStartedAt)));
        schedule();
        return;
      }
      write(envelope.reset());
    }

    function schedule() {
      if (frame) return;
      frame = raf(tick);
    }

    function stop() {
      if (frame) cancelRaf(frame);
      frame = 0;
      write(envelope.reset());
    }

    return {
      // Every setAgentState() transition lands here.
      setState(next) {
        state = String(next || "idle");
        if (state === "listening") {
          lastSampleAt = now();
          schedule();
          return;
        }
        if (state === "speaking") {
          speakingStartedAt = now();
          schedule();
          return;
        }
        stop();
      },
      // One mic_level voice event, ~24 per second while the mic is open.
      pushMicLevel(rms) {
        if (state !== "listening") return;
        lastSampleAt = now();
        envelope.push(rms);
        schedule();
      },
      stop,
      get level() {
        return envelope.value;
      },
    };
  }

  global.AgeeCompanionRim = Object.freeze({ LEVEL_VAR, SAMPLE_STALE_MS, createCompanionRim });
})(globalThis);
