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
  global.AgeeSteeringUi = Object.freeze({
    formatPageIdentity,
    formatSteeredAssistantText,
    observePageIdentity,
    roleForInstruction,
    selectResolvedCueIds: (cards) => (Array.isArray(cards) ? cards : [])
      .filter((card) => card?.id && card.active !== true && card.protected !== true).map((card) => card.id),
    toggleHistorySnapshot,
  });
})(globalThis);
