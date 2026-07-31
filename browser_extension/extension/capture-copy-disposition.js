// Copy pressed on the user line while a capture is live is a disposition, not
// just a clipboard write: it requests a provider-final transcript and does NOT
// hand the utterance to reasoning. A session can do that only when it started
// as transcription-only dictation. An ordinary Ask session must fail closed:
// changing its policy at commit time is not part of the gateway protocol.
//
// Pure except for the callbacks it is given, so the ordering (finalize, await
// the terminal transcript, copy once) is unit-testable without a browser:
// scripts/test-capture-copy-disposition.mjs.
(function initAgeeCaptureCopyDisposition(global) {
  "use strict";

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
    canFinalizeWithoutSend,
    finalizeCapture,
    onBlocked = () => {},
    copyTranscript,
    cancelPendingCopy = () => {},
  } = {}) {
    let pending = false;

    return {
      // True defers the ribbon's immediate clipboard read. The final transcript
      // completes the request through complete(); a blocked Ask capture also
      // returns true so its current interim hypothesis is never copied.
      requestFinalize() {
        if (!isCapturing()) return false;
        if (!canFinalizeWithoutSend()) {
          onBlocked();
          return true;
        }
        if (pending) return true;
        pending = true;
        finalizeCapture();
        return true;
      },
      isPending: () => pending,
      async complete({ clipboardCopied = false } = {}) {
        if (!pending) return clipboardCopied === true;
        pending = false;
        if (clipboardCopied) {
          cancelPendingCopy();
          return true;
        }
        return copyTranscript();
      },
      cancel() {
        pending = false;
        cancelPendingCopy();
      },
    };
  }

  global.AgeeCaptureCopyDisposition = Object.freeze({ copyTextToClipboard, create });
})(globalThis);
