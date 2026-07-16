const AGENT_LOOP_MAX_STEPS_CAP = 40;
const AGENT_LOOP_DEFAULT_MAX_STEPS = 24;
const AGENT_LOOP_MAX_TYPE_TEXT = 2000;
const AGENT_LOOP_MAX_SELECT_TEXT = 200;
const AGENT_LOOP_MAX_KEY_TEXT = 32;
const AGENT_LOOP_MAX_SUMMARY = 2000;
const AGENT_LOOP_MAX_PAGE_TEXT = 6000;
const AGENT_LOOP_MAX_ACTION_RESULT = 500;
const MAX_ELEMENTS = 100;
const MAX_SCREENSHOT_BASE64_CHARS = 420 * 1024;

function clampAgentLoopMaxSteps(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return AGENT_LOOP_DEFAULT_MAX_STEPS;
  return Math.min(AGENT_LOOP_MAX_STEPS_CAP, Math.max(1, Math.floor(n)));
}

function agentLoopScreenshotObservation(base64) {
  const data = String(base64 || "");
  if (!data) return { encoding: "omitted", reason: "screenshot capture failed" };
  if (data.length > MAX_SCREENSHOT_BASE64_CHARS) {
    return { encoding: "omitted", reason: "screenshot too large for gateway observation payload" };
  }
  return { encoding: "base64_jpeg", data };
}

function buildAgentLoopObservationPayload(snapshot, step, {
  withScreenshot,
  screenshot,
  lastAction,
  lastActionResult,
} = {}) {
  const source = snapshot && typeof snapshot === "object" ? snapshot : {};
  const elements = (Array.isArray(source.elements) ? source.elements : []).slice(0, MAX_ELEMENTS).map((element) => ({
    i: element.i,
    tag: String(element.tag || ""),
    type: String(element.type || ""),
    label: String(element.label || "").slice(0, 80),
  }));
  const observation = {
    url: String(source.url || ""),
    title: String(source.title || ""),
    elements,
    step,
  };
  const pageText = String(source.pageText || "").trim();
  if (pageText) observation.page_text = pageText.slice(0, AGENT_LOOP_MAX_PAGE_TEXT);
  if (withScreenshot) observation.screenshot = agentLoopScreenshotObservation(screenshot);
  if (lastAction) observation.last_action = lastAction;
  if (lastActionResult) {
    observation.last_action_result = String(lastActionResult).slice(0, AGENT_LOOP_MAX_ACTION_RESULT);
  }
  return observation;
}

function validateAgentLoopAction(action, normalizeNavigationUrl) {
  if (!action || typeof action !== "object") return { ok: false, kind: "(none)" };
  const kind = String(action.kind || "");
  const isIndex = (value) => Number.isInteger(value) && value >= 0;
  switch (kind) {
    case "click":
    case "clear":
      if (!isIndex(action.index)) return { ok: false, kind };
      return { ok: true, kind, action: { kind, index: action.index } };
    case "type":
      if (!isIndex(action.index) || typeof action.text !== "string" || action.text.length > AGENT_LOOP_MAX_TYPE_TEXT) {
        return { ok: false, kind };
      }
      return { ok: true, kind, action: { kind, index: action.index, text: action.text } };
    case "select":
      if (!isIndex(action.index) || typeof action.text !== "string" || action.text.length > AGENT_LOOP_MAX_SELECT_TEXT) {
        return { ok: false, kind };
      }
      return { ok: true, kind, action: { kind, index: action.index, text: action.text } };
    case "scroll": {
      const direction = action.direction === "up" ? "up" : action.direction === "down" ? "down" : null;
      if (!direction) return { ok: false, kind };
      return { ok: true, kind, action: { kind, direction } };
    }
    case "navigate": {
      const url = typeof normalizeNavigationUrl === "function" ? normalizeNavigationUrl(action.url) : "";
      if (!url) return { ok: false, kind };
      return { ok: true, kind, action: { kind, url } };
    }
    case "key":
      if (typeof action.text !== "string" || !action.text || action.text.length > AGENT_LOOP_MAX_KEY_TEXT) {
        return { ok: false, kind };
      }
      return { ok: true, kind, action: { kind, text: action.text } };
    case "wait":
    case "screenshot":
      return { ok: true, kind, action: { kind } };
    case "finish": {
      const status = action.status === "blocked" ? "blocked" : action.status === "done" ? "done" : null;
      if (!status) return { ok: false, kind };
      const summary = typeof action.summary === "string" ? action.summary.slice(0, AGENT_LOOP_MAX_SUMMARY) : "";
      return { ok: true, kind, action: { kind, status, summary } };
    }
    default:
      return { ok: false, kind: kind || "(unknown)" };
  }
}

export {
  AGENT_LOOP_MAX_SUMMARY,
  MAX_SCREENSHOT_BASE64_CHARS,
  agentLoopScreenshotObservation,
  buildAgentLoopObservationPayload,
  clampAgentLoopMaxSteps,
  validateAgentLoopAction,
};
