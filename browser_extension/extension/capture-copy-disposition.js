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

  // The clipboard write itself. It used to live in quiet-companion-controls.js,
  // which was deleted with the floating pill; it is here because every caller
  // is a copy path and this module already owns what copy means in the overlay.
  //
  // navigator.clipboard is not available on every page the overlay runs on (an
  // insecure context, or a permissions policy that denies it), so the textarea
  // + execCommand path is a real fallback and not legacy cruft.
  async function copyTextToClipboard(text, doc = global.document, nav = global.navigator) {
    const value = String(text || "").trim();
    if (!value) return false;
    try {
      await nav.clipboard.writeText(value);
      return true;
    } catch {}
    const textarea = doc.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    textarea.style.pointerEvents = "none";
    doc.documentElement.appendChild(textarea);
    textarea.select();
    let copied = false;
    try { copied = doc.execCommand("copy"); } catch {}
    textarea.remove();
    return copied;
  }

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

  global.AgeeCaptureCopyDisposition = Object.freeze({ copyTextToClipboard, create, SETTLE_MS });
})(globalThis);
