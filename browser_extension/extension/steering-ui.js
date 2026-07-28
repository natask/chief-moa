(function initAgeeSteeringUi(global) {
  "use strict";
  const marker = "— steered here; prior response stopped —";
  const compact = (value, max) => {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
  };
  function formatPageIdentity({ title = "", hostname = "", pathname = "" } = {}) {
    const safeTitle = compact(title, 72);
    const safeHost = compact(hostname, 48);
    const locationPart = [safeHost, compact(pathname === "/" ? "" : pathname, 48)].filter(Boolean).join("");
    return safeTitle && locationPart && safeTitle.toLowerCase() !== safeHost.toLowerCase()
      ? `${safeTitle} · ${locationPart}` : safeTitle || locationPart || "Current page";
  }
  function observePageIdentity({ element, document, location, window }) {
    const render = () => {
      if (!element) return;
      const identity = formatPageIdentity({ title: document.title, hostname: location.hostname, pathname: location.pathname });
      element.textContent = identity;
      element.title = identity;
    };
    render();
    window.addEventListener("popstate", render, { capture: true });
    window.addEventListener("hashchange", render, { capture: true });
    if (document.head && typeof global.MutationObserver !== "undefined") {
      new global.MutationObserver(render).observe(document.head, { subtree: true, childList: true, characterData: true });
    }
  }
  const textFor = (turn, fields) => {
    for (const field of fields) {
      const value = String(turn?.[field] || "").trim();
      if (value) return value;
    }
    return "";
  };
  function renderHistory(view, turns, document) {
    view.replaceChildren();
    const recent = Array.isArray(turns) ? turns.slice(-20) : [];
    if (!recent.length) {
      const empty = document.createElement("p");
      empty.className = "agee-history-empty";
      empty.textContent = "No saved conversation history.";
      view.appendChild(empty);
      return;
    }
    for (const turn of recent) {
      const item = document.createElement("article");
      item.className = "agee-history-turn";
      for (const [className, value] of [
        ["agee-history-you", textFor(turn, ["transcript", "user_text", "instruction"])],
        ["agee-history-assistant", textFor(turn, ["reply", "assistant_text", "display", "text"])],
      ]) {
        if (!value) continue;
        const line = document.createElement("p");
        line.className = className;
        line.textContent = value;
        item.appendChild(line);
      }
      if (item.childElementCount) view.appendChild(item);
    }
  }
  async function toggleHistorySnapshot({ view, button, sendMessage, positionPanel, document }) {
    if (!view || !button) return;
    if (!view.hidden) {
      view.hidden = true;
      button.setAttribute("aria-expanded", "false");
      return;
    }
    button.disabled = true;
    try {
      const response = await sendMessage({ cmd: "history" });
      renderHistory(view, response?.ok ? response.turns : [], document);
      view.hidden = false;
      button.setAttribute("aria-expanded", "true");
    } finally {
      button.disabled = false;
      positionPanel();
    }
  }
  async function copyTranscriptAndOpenHistory({
    transcript,
    view,
    button,
    status,
    copyText,
    sendMessage,
    positionPanel,
    document,
  }) {
    if (!view || !button || !status) return { copied: false, historyOpened: false };
    const value = String(transcript || "").trim();
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    status.textContent = value ? "Copying transcript and opening history…" : "Opening history…";
    try {
      const [copyResult, historyResult] = await Promise.allSettled([
        value ? copyText(value) : Promise.resolve(false),
        sendMessage({ cmd: "history" }),
      ]);
      const copied = copyResult.status === "fulfilled" && copyResult.value === true;
      const historyResponse = historyResult.status === "fulfilled" ? historyResult.value : null;
      const historyOpened = historyResponse?.ok === true;
      if (historyOpened) {
        renderHistory(view, historyResponse.turns, document);
        view.hidden = false;
        button.setAttribute("aria-expanded", "true");
      }
      if (copied && historyOpened) status.textContent = "Transcript copied. History opened.";
      else if (copied) status.textContent = "Transcript copied, but saved history could not be opened.";
      else if (historyOpened) status.textContent = value
        ? "History opened, but the transcript could not be copied."
        : "History opened. There is no transcript to copy yet.";
      else status.textContent = value
        ? "The transcript could not be copied and saved history could not be opened."
        : "Saved history could not be opened.";
      return { copied, historyOpened };
    } finally {
      button.disabled = false;
      button.removeAttribute("aria-busy");
      positionPanel();
    }
  }
  function formatSteeredAssistantText(latestText, boundaryText = "") {
    const latest = String(latestText || "").trim();
    const boundary = String(boundaryText || "").trim();
    if (!boundary) return [marker, latest].filter(Boolean).join("\n\n");
    if (!latest || latest === boundary) return `${boundary}\n\n${marker}`;
    const rest = latest.startsWith(boundary) ? latest.slice(boundary.length).trimStart() : latest;
    return [boundary, marker, rest].filter(Boolean).join("\n\n");
  }
  function roleForInstruction(text) {
    const value = String(text || "").trim().toLowerCase();
    if (/^(explain|describe|tell me (?:about|how|why))\b/.test(value)) return "explain";
    if (/^(help me|guide me|show me how)\b/.test(value)) return "help";
    if (/^(collaborate|work with me|pair with me)\b/.test(value)) return "collaborate";
    return "delegate";
  }
  const isCurrentLiveVoiceState = (state, current, isActive) => !!state && state === current && isActive(state);
  global.AgeeSteeringUi = Object.freeze({
    formatPageIdentity,
    formatSteeredAssistantText,
    observePageIdentity,
    roleForInstruction,
    isCurrentLiveVoiceState,
    selectResolvedCueIds: (cards) => (Array.isArray(cards) ? cards : [])
      .filter((card) => card?.id && card.active !== true && card.protected !== true).map((card) => card.id),
    copyTranscriptAndOpenHistory,
    toggleHistorySnapshot,
  });
})(globalThis);
