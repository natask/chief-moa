(function initAgeeQuietCompanionControls(global) {
  "use strict";

  const COPY_GLYPH = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>';
  const SOUND_GLYPH = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 9v6h4l5 4V5L9 9H5z"/><path class="agee-quiet-sound-wave" d="M17 9a4 4 0 0 1 0 6"/></svg>';

  function template() {
    return `<div id="agee-quiet-controls" aria-label="Ag quick controls">
      <button id="agee-quiet-copy" type="button" data-agee-tip="Copy what you said" aria-label="Copy what you said">${COPY_GLYPH}</button>
      <button id="agee-quiet-voice" type="button" data-agee-tip="Turn voice replies off" aria-label="Turn voice replies off" aria-pressed="true">${SOUND_GLYPH}</button>
      <span id="agee-quiet-status" role="status" aria-live="polite" aria-atomic="true"></span>
    </div>`;
  }

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

  function create({ root, launcher, copyLatest, setVoiceRepliesEnabled, doc = global.document, win = global } = {}) {
    const controls = root?.querySelector("#agee-quiet-controls");
    const copyButton = root?.querySelector("#agee-quiet-copy");
    const voiceButton = root?.querySelector("#agee-quiet-voice");
    const status = root?.querySelector("#agee-quiet-status");
    if (!controls || !copyButton || !voiceButton || !launcher) return null;
    let voiceEnabled = true;
    let statusTimer = null;

    function announce(text) {
      clearTimeout(statusTimer);
      status.textContent = text;
      controls.dataset.ageeStatus = text;
      statusTimer = win.setTimeout(() => {
        status.textContent = "";
        delete controls.dataset.ageeStatus;
      }, 1400);
    }

    function setVoiceEnabled(next, { announceChange = false } = {}) {
      voiceEnabled = next !== false;
      voiceButton.setAttribute("aria-pressed", String(voiceEnabled));
      voiceButton.setAttribute("aria-label", voiceEnabled ? "Turn voice replies off" : "Turn voice replies on");
      voiceButton.dataset.ageeTip = voiceEnabled ? "Turn voice replies off" : "Turn voice replies on";
      controls.classList.toggle("agee-quiet-muted", !voiceEnabled);
      setVoiceRepliesEnabled?.(voiceEnabled);
      if (announceChange) announce(voiceEnabled ? "Voice on" : "Voice off");
    }

    function position() {
      const rect = launcher.getBoundingClientRect();
      const width = controls.offsetWidth || 70;
      const gap = 6;
      const fitsRight = rect.right + gap + width <= win.innerWidth - 8;
      controls.style.left = `${fitsRight ? rect.right + gap : Math.max(8, rect.left - width - gap)}px`;
      controls.style.top = `${Math.max(8, rect.top + (rect.height - (controls.offsetHeight || 32)) / 2)}px`;
    }

    copyButton.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      announce(await copyLatest?.() ? "Copied" : "Nothing to copy");
    });
    voiceButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      setVoiceEnabled(!voiceEnabled, { announceChange: true });
    });
    win.addEventListener("resize", position);
    doc.addEventListener("visibilitychange", () => {
      if (!doc.hidden) position();
    });
    position();

    return { position, setVoiceEnabled, copyButton, voiceButton };
  }

  global.AgeeQuietCompanionControls = Object.freeze({ copyTextToClipboard, create, template });
})(globalThis);
