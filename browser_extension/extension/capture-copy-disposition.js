// Copy pressed on the user line while a capture is live is a disposition, not
// just a clipboard write: it finalizes what has been said so far and does NOT
// send it. Contract: reference/design/overlay-2026-07/spec.md §4.3.
//
// That distinction is the whole point of the feature — the overlay is usable
// for dictating into another app only if grabbing the text cannot also start a
// turn. So this cancels the capture; it must never commit one, because commit
// is what hands the utterance to the model.
//
// Pure except for the callbacks it is given, so the ordering (cancel, settle,
// copy, and never copy twice) is unit-testable without a browser:
// scripts/test-capture-copy-disposition.mjs.
(function initAgeeCaptureCopyDisposition(global) {
  "use strict";

  // How long to let the cancelled capture settle before reading the line. The
  // last transcript the provider sent is already rendered; this is one frame's
  // grace, not a wait for anything in particular.
  const SETTLE_MS = 120;

  function create({
    isCapturing,
    cancelCapture,
    onIdle = () => {},
    copyTranscript,
    settleMs = SETTLE_MS,
    setTimer = (fn, ms) => setTimeout(fn, ms),
  } = {}) {
    let pending = false;

    return {
      // Returns true when the copy must wait for the capture to stop, which is
      // what defers the clipboard write. False means "nothing live, copy now".
      requestFinalize() {
        if (!isCapturing()) return false;
        pending = true;
        cancelCapture();
        onIdle();
        setTimer(() => {
          if (!pending) return;
          pending = false;
          copyTranscript();
        }, settleMs);
        return true;
      },
      isPending: () => pending,
      cancel() {
        pending = false;
      },
    };
  }

  global.AgeeCaptureCopyDisposition = Object.freeze({ create, SETTLE_MS });
})(globalThis);
