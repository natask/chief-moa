(function initAgeeSteeringUi(global) {
  "use strict";
  const marker = "— steered here; prior response stopped —";
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
    formatSteeredAssistantText,
    roleForInstruction,
    isCurrentLiveVoiceState,
    selectResolvedCueIds: (cards) => (Array.isArray(cards) ? cards : [])
      .filter((card) => card?.id && card.active !== true && card.protected !== true).map((card) => card.id),
  });
})(globalThis);
