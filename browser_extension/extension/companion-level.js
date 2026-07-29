// Mic/playback amplitude maths for the companion rim.
// Contract: reference/design/overlay-2026-07-28/spec.md section 3.1.
//
// Pure. Takes numbers, returns numbers. No DOM, no timers, no audio nodes --
// the caller owns the frame loop and the CSS var write, which is what makes
// this testable without a browser. Unit-tested directly:
// scripts/test-companion-level.mjs.
(function initAgeeCompanionLevel(global) {
  "use strict";

  // Fast attack, slow release. A syllable has to reach the rim on the frame it
  // arrives; the fall back to silence is deliberately lazy so the rim does not
  // strobe between words.
  const ATTACK = 0.6;
  const RELEASE = 0.12;
  // Speech that is quiet but present sits near -50 dBFS. Anchoring the floor at
  // -55 and spanning 40 dB means a whisper still visibly moves the rim and a
  // shout does not clip the top of the range for the whole utterance.
  const DB_FLOOR = -55;
  const DB_RANGE = 40;
  // Playback fallback when no AnalyserNode is available on the TTS path. A fake
  // level beats a dead companion, and nobody can tell on a 2px rim.
  const SPEAKING_BASE = 0.35;
  const SPEAKING_SWING = 0.25;
  const SPEAKING_HZ = 2.4;

  function clamp01(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    if (number <= 0) return 0;
    return number >= 1 ? 1 : number;
  }

  // RMS in linear amplitude -> 0..1 display level. Silence and garbage both
  // land on 0 rather than on -Infinity.
  function levelFromRms(rms) {
    const value = Number(rms);
    if (!Number.isFinite(value) || value <= 0) return 0;
    const db = 20 * Math.log10(value);
    return clamp01((db - DB_FLOOR) / DB_RANGE);
  }

  // One envelope step toward `target`. Rising uses ATTACK, falling uses RELEASE.
  function envelopeStep(previous, target, { attack = ATTACK, release = RELEASE } = {}) {
    const from = clamp01(previous);
    const to = clamp01(target);
    return clamp01(from + (to - from) * (to > from ? attack : release));
  }

  // Synthetic playback level for the speaking state, spec section 3.1.
  function speakingLevel(elapsedMs) {
    const seconds = Number(elapsedMs) / 1000;
    if (!Number.isFinite(seconds)) return SPEAKING_BASE;
    return clamp01(SPEAKING_BASE + SPEAKING_SWING * Math.sin(2 * Math.PI * SPEAKING_HZ * seconds));
  }

  // The value that goes into the CSS var. Three decimals is finer than a 2px
  // rim can show and keeps the string short, so the per-frame write stays cheap.
  function formatLevel(level) {
    return clamp01(level).toFixed(3);
  }

  // Stateful only in the sense of holding the last envelope value. Still pure
  // in the way that matters: same inputs in the same order give the same
  // outputs, and nothing outside it is touched.
  function createLevelEnvelope(options = {}) {
    let value = 0;
    return {
      get value() {
        return value;
      },
      // A new RMS sample from the worklet.
      push(rms) {
        value = envelopeStep(value, levelFromRms(rms), options);
        return value;
      },
      // No sample this frame: keep releasing toward silence.
      decay() {
        value = envelopeStep(value, 0, options);
        return value;
      },
      // Playback drives the level directly; it is already 0..1.
      set(level) {
        value = clamp01(level);
        return value;
      },
      reset() {
        value = 0;
        return value;
      },
    };
  }

  global.AgeeCompanionLevel = Object.freeze({
    ATTACK,
    RELEASE,
    DB_FLOOR,
    DB_RANGE,
    SPEAKING_BASE,
    SPEAKING_SWING,
    SPEAKING_HZ,
    clamp01,
    createLevelEnvelope,
    envelopeStep,
    formatLevel,
    levelFromRms,
    speakingLevel,
  });
})(globalThis);
