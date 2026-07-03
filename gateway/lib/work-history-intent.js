"use strict";

// Deterministic parser for voice work-history control-plane intents.
//
// This is the spoken-operations half of
// reference/openspec/changes/remote-hosted-gateway/voice-work-history-control-plane.md.
// It turns one transcript into ONE of the contract's spoken operations:
//
//   create_work        "create a task to ...", "queue a run to ..."
//   status_query       "what is still running", "what changed", "what failed",
//                      "which runs are waiting on me"
//   feedback           "attach this feedback to wr_x: ...", "tell the active run to ..."
//   feedback (cancel)  "cancel the work run wr_x" -> run_control_request proposal
//   deployment_link    "what is the latest preview link", "what link do I use"
//   deployment_request "create a deploy request for this branch"
//   ui_open            "open the run page on my phone", "have chrome open the diff"
//
// The parser is intentionally narrow. Anything it does not confidently match
// returns null so the turn falls through to the existing voice routing
// (chat / profile control / legacy agent dispatch). It never executes anything:
// callers create durable proposals and answer from projections.

const INTENT_KINDS = Object.freeze([
  "create_work",
  "status_query",
  "feedback",
  "deployment_link",
  "deployment_request",
  "ui_open",
]);

const STATUS_SCOPES = Object.freeze(["running", "changed", "failed", "waiting", "overview"]);

const UI_ROUTE_KINDS = Object.freeze(["task", "run", "diff", "verification", "deployment", "feedback"]);

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[.,!?;]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Ids the control plane understands: its own record ids (wt_, wr_, snap_,
// diff_, ver_, fb_, ctl_, dreq_, dep_), legacy run ids (run_...), work-graph
// nodes (wg_...), and spoken ticket handles like "VPS-05".
function extractTargetRef(rawText) {
  const raw = String(rawText || "");
  const idMatch = raw.match(/\b(?:wt|wr|run|wg|snap|diff|ver|fb|ctl|dreq|dep)_[a-z0-9][a-z0-9_-]*\b/i);
  if (idMatch) return idMatch[0];
  const ticketMatch = raw.match(/\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b/);
  if (ticketMatch) return ticketMatch[0];
  return "";
}

function parseCreateWork(lower, raw) {
  // "have the <lane> agent <objective>"
  const delegate = lower.match(/^(?:please\s+)?have\s+(?:the\s+)?([a-z0-9 _-]{2,40}?)\s+agent\s+(.{3,})$/);
  if (delegate) {
    return {
      kind: "create_work",
      objective: delegate[2].trim(),
      owner_hint: delegate[1].trim(),
      wants_run: true,
    };
  }

  // "create/add a (work) task (to|for|:) <objective>"
  const task = lower.match(/\b(?:create|add|make|open)\s+(?:a\s+|another\s+|new\s+)?(?:work\s+)?task\b(?:\s+(?:to|for|that|about|called)\s+|\s*:\s*)?(.*)$/);
  if (task) {
    const objective = task[1].trim();
    return {
      kind: "create_work",
      objective,
      owner_hint: "",
      // "... and queue/start a run" inside the same utterance asks for a run too.
      wants_run: /\b(?:queue|start|kick\s*off|launch)\b.*\brun\b/.test(lower),
    };
  }

  // "queue/start a run to <objective>"
  const run = lower.match(/\b(?:queue|start|kick\s*off|launch)\s+(?:a\s+|another\s+|new\s+)?(?:agent\s+)?run\b(?:\s+(?:to|for|that|on|against)\s+|\s*:\s*)?(.*)$/);
  if (run) {
    return {
      kind: "create_work",
      objective: run[1].trim(),
      owner_hint: "",
      wants_run: true,
    };
  }

  return null;
}

function parseStatusQuery(lower, raw) {
  if (/\bwhat(?:'s| is)?\s+(?:still\s+)?running\b/.test(lower)
    || /\bwhich\s+(?:runs?|tasks?|agents?)\s+(?:are|is)\s+(?:still\s+)?(?:running|active|going)\b/.test(lower)
    || /\bwhat\s+work\s+is\s+(?:queued|active|running|open)\b/.test(lower)
    || /\bwhat(?:'s| is)?\s+(?:queued|in\s+the\s+queue)\b/.test(lower)) {
    return { kind: "status_query", scope: "running", target: extractTargetRef(raw) };
  }
  if (/\bwhat\s+(?:did|has)\s+(?:.{1,60}?)\s*change(?:d)?\b/.test(lower) || /\bwhat\s+changed\b/.test(lower)) {
    return { kind: "status_query", scope: "changed", target: extractTargetRef(raw) };
  }
  if (/\bwhat\s+failed\b/.test(lower)
    || /\b(?:show|tell)\s+me\s+the\s+(?:last|latest)\s+(?:verification\s+)?failure\b/.test(lower)
    || /\bwhich\s+(?:runs?|tasks?)\s+(?:have\s+)?failed\b/.test(lower)) {
    return { kind: "status_query", scope: "failed", target: extractTargetRef(raw) };
  }
  if (/\bwaiting\s+on\s+me\b/.test(lower) || /\bwaiting\s+for\s+me\b/.test(lower)) {
    return { kind: "status_query", scope: "waiting", target: extractTargetRef(raw) };
  }
  if (/\bwork\s+history\s+status\b/.test(lower) || /\bstatus\s+of\s+my\s+(?:tasks?|runs?|work)\b/.test(lower)) {
    return { kind: "status_query", scope: "overview", target: extractTargetRef(raw) };
  }
  return null;
}

function parseDeployment(lower, raw) {
  if (/\bcreate\s+a\s+deploy(?:ment)?\s+request\b/.test(lower)
    || /\brequest\s+a\s+(?:new\s+)?deploy(?:ment)?\b/.test(lower)
    || /\bqueue\s+a\s+deploy(?:ment)?\b/.test(lower)) {
    return {
      kind: "deployment_request",
      target: extractTargetRef(raw),
      // The contract forbids implicit promotion; a spoken request is always a
      // preview/artifact proposal unless a later explicit promotion turn applies it.
      apply: false,
    };
  }
  if (/\b(?:latest|newest|current)\s+preview\s+(?:link|url)\b/.test(lower)
    || /\bpreview\s+(?:link|url)\b/.test(lower)
    || /\bactive\s+(?:gateway\s+|deployment\s+)?url\b/.test(lower)
    || /\bwhat\s+link\s+do\s+i\s+use\b/.test(lower)
    || /\bdeployment\s+links?\b/.test(lower)
    || /\bgive\s+me\s+the\s+(?:deploy|deployment|preview|active)\s+(?:link|url)\b/.test(lower)) {
    return { kind: "deployment_link", target: extractTargetRef(raw) };
  }
  return null;
}

function parseFeedback(lower, raw) {
  // Explicit cancellation/pause of a work-history run or task creates a
  // run_control_request proposal; the owning worker must claim and receipt it.
  const control = lower.match(/\b(cancel|pause)\s+(?:the\s+)?(?:work\s+)?(?:run|task)\b(.*)$/);
  if (control) {
    return {
      kind: "feedback",
      intent: "cancellation",
      control_action: control[1] === "pause" ? "pause" : "cancel",
      target: extractTargetRef(raw),
      text: String(raw || "").trim(),
    };
  }

  const attach = lower.match(/\battach\s+(?:this\s+)?feedback\s+to\s+(\S+)\s*:?\s*(.*)$/);
  if (attach) {
    return {
      kind: "feedback",
      intent: "note",
      target: extractTargetRef(raw) || attach[1],
      text: (attach[2] || String(raw || "")).trim(),
    };
  }

  const tell = lower.match(/\btell\s+the\s+(?:active\s+)?(?:\S+\s+)?(?:run|task)\s+(?:to\s+)?(.{3,})$/);
  if (tell) {
    return {
      kind: "feedback",
      intent: "correction",
      target: extractTargetRef(raw),
      text: tell[1].trim(),
    };
  }

  if (/\bthat\s+(?:result|answer|output)\s+is\s+wrong\b/.test(lower)) {
    return {
      kind: "feedback",
      intent: "correction",
      target: extractTargetRef(raw),
      text: String(raw || "").trim(),
    };
  }

  return null;
}

function parseUiOpen(lower, raw) {
  const surface = /\bon\s+my\s+phone\b/.test(lower) || /\bon\s+(?:the\s+)?android\b/.test(lower)
    ? "android"
    : (/\bchrome\b/.test(lower) || /\bin\s+(?:the\s+|my\s+)?browser\b/.test(lower) || /\bon\s+my\s+(?:computer|desktop|laptop)\b/.test(lower))
      ? "browser_extension"
      : "";

  // "have chrome open the diff for wr_x" / "have the browser open ..."
  const delegate = lower.match(/\bhave\s+(?:chrome|the\s+browser|my\s+phone|the\s+phone|android)\s+open\s+(?:the\s+)?(task|run|diff|verification|deployment|feedback)\b/);
  if (delegate) {
    return {
      kind: "ui_open",
      route_kind: delegate[1],
      target: extractTargetRef(raw),
      surface: /\bphone|android\b/.test(delegate[0]) ? "android" : "browser_extension",
    };
  }

  // "open the run page on my phone" / "open that run" / "open the deployment preview"
  const open = lower.match(/\b(?:open|show|bring)\s+(?:up\s+)?(?:me\s+)?(?:the\s+|that\s+|this\s+|the\s+last\s+|the\s+latest\s+)?(task|run|diff|verification|deployment|feedback)\b/);
  if (open && (surface || /\bpage\b/.test(lower) || /\bpreview\b/.test(lower) || /\bui\b/.test(lower))) {
    return {
      kind: "ui_open",
      route_kind: open[1],
      target: extractTargetRef(raw),
      surface,
    };
  }

  return null;
}

// One transcript -> one control-plane intent, or null when this turn is not a
// work-history operation. Order matters: UI-open and feedback phrasing can
// contain the words "run"/"task", so the more specific matchers go first.
function parseWorkHistoryIntent(transcript) {
  const raw = String(transcript || "").trim();
  if (!raw) return null;
  const lower = normalize(raw);
  if (!lower) return null;

  return parseUiOpen(lower, raw)
    || parseDeployment(lower, raw)
    || parseStatusQuery(lower, raw)
    || parseFeedback(lower, raw)
    || parseCreateWork(lower, raw)
    || null;
}

module.exports = {
  parseWorkHistoryIntent,
  extractTargetRef,
  INTENT_KINDS,
  STATUS_SCOPES,
  UI_ROUTE_KINDS,
};
