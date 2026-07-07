"use strict";

// Browser agent-loop store (gateway side of the background browser agent).
//
// The gateway proposes ONE bounded declarative action per step; the extension
// validates every proposed action against its own local allowlist before it
// executes anything. No CSS/JS/code strings ever cross the wire — the action
// vocabulary below is a fixed set of { kind, ...bounded params } records. This
// mirrors the page-tweak boundary and the browser-tasks CDP store idioms in
// server.js (create/claim with lease/list/get, plus sanitizers), but adds the
// per-step planner loop extracted from the agee action-loop prior art.
//
// The step planner is TEXT-ONLY in v1: the model sees the instruction, a
// bounded step history, and the latest observation's url/title/elements/
// page_text. Screenshots are stored on the task record (latest only) for audit
// and are NEVER sent to the model in v1. When no reasoning provider is
// configured (or the model/transport errors, or it proposes an invalid action)
// a deterministic keyless fallback keeps the loop moving: step 0 waits, later
// steps finish.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MAX_STEPS_CEILING = 40;
const DEFAULT_MAX_STEPS = 24;
const LEASE_MS = 120_000;
// Bounded step history sent to the model: the last N steps in full, older ones
// summarized to a single line each.
const HISTORY_FULL_STEPS = 8;
const OBS_ELEMENTS_CAP = 100;
const OBS_ELEMENT_LABEL_CAP = 80;
const OBS_PAGE_TEXT_CAP = 6000;
const OBS_LAST_ACTION_RESULT_CAP = 500;
// Reuse the existing browser-evidence screenshot cap (base64 <= 420KB).
const SCREENSHOT_BASE64_CAP = 420 * 1024;
const INSTRUCTION_CAP = 20000;

// The action vocabulary the gateway may propose. Both sides enforce it: an
// unknown kind is rejected (the gateway never emits one; the extension posts a
// finish/failed if it ever sees one). navigate is http/https only.
const ACTION_KINDS = [
  "click",
  "type",
  "clear",
  "select",
  "scroll",
  "navigate",
  "key",
  "wait",
  "screenshot",
  "finish",
];

// System prompt adapted from agee's browser action-loop SYSTEM_PROMPT. The
// screenshot line is dropped: v1 is text-only to the model.
const AGENT_SYSTEM_PROMPT = `You are a browser agent that operates a web browser on the user's behalf in the background.

Each step you receive: the task instruction, a short history of prior steps, and the current page URL/title with a numbered list of interactable elements and bounded page text.
Decide the single next action that moves toward the goal, then call a tool.

Rules:
- Refer to elements by their index from the list.
- Prefer one concrete action per step. After it runs you get a fresh observation.
- To type into a field, use action "type" which focuses the element by index first.
- When the goal is achieved, or you are blocked and need the user, call "finish" with a short summary.
- Be decisive. Do not narrate options you will not take.
- You act in a background tab the user cannot see; never claim you did something you did not propose as an action.`;

function sanitizeText(value, max) {
  const text = String(value == null ? "" : value);
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

function sanitizeId(id) {
  return String(id || "").replace(/[^a-zA-Z0-9_-]/g, "");
}

function sanitizeHttpUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return "";
    }
    return url.href;
  } catch {
    return "";
  }
}

function clampMaxSteps(value) {
  const requested = Number(value);
  if (!Number.isFinite(requested) || requested <= 0) {
    return DEFAULT_MAX_STEPS;
  }
  return Math.max(1, Math.min(Math.floor(requested), MAX_STEPS_CEILING));
}

function isTerminalStatus(status) {
  return status === "done" || status === "failed" || status === "cancelled";
}

// Validate a proposed action against the fixed vocabulary. Unknown kind or a
// param that does not fit the shape -> null (rejected). The gateway never emits
// a rejected action; it falls back to the deterministic planner instead.
function sanitizeAgentAction(action) {
  if (!action || typeof action !== "object" || Array.isArray(action)) {
    return null;
  }
  const kind = String(action.kind || action.action || "").trim().toLowerCase();
  if (!ACTION_KINDS.includes(kind)) {
    return null;
  }
  const asIndex = (value) => {
    const num = Number(value);
    return Number.isInteger(num) && num >= 0 && num <= 100000 ? num : null;
  };
  switch (kind) {
    case "click":
    case "clear": {
      const index = asIndex(action.index);
      if (index == null) return null;
      return { kind, index };
    }
    case "type": {
      const index = asIndex(action.index);
      if (index == null) return null;
      return { kind, index, text: sanitizeText(action.text || "", 2000) };
    }
    case "select": {
      const index = asIndex(action.index);
      if (index == null) return null;
      return { kind, index, text: sanitizeText(action.text || "", 200) };
    }
    case "scroll": {
      const direction = String(action.direction || "").trim().toLowerCase();
      if (direction !== "up" && direction !== "down") return null;
      return { kind, direction };
    }
    case "navigate": {
      const url = sanitizeHttpUrl(action.url);
      if (!url) return null;
      return { kind, url };
    }
    case "key": {
      const text = sanitizeText(action.text || action.key || "", 32);
      if (!text) return null;
      return { kind, text };
    }
    case "wait":
      return { kind: "wait" };
    case "screenshot":
      return { kind: "screenshot" };
    case "finish": {
      const status = String(action.status || "done").trim().toLowerCase();
      const safeStatus = status === "blocked" ? "blocked" : "done";
      return {
        kind: "finish",
        status: safeStatus,
        summary: sanitizeText(action.summary || "", 2000),
      };
    }
    default:
      return null;
  }
}

function sanitizeElements(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, OBS_ELEMENTS_CAP)
    .map((element) => {
      if (!element || typeof element !== "object" || Array.isArray(element)) return null;
      const iNum = Number(element.i ?? element.index);
      return {
        i: Number.isInteger(iNum) && iNum >= 0 ? iNum : 0,
        tag: sanitizeText(element.tag || "", 40),
        type: sanitizeText(element.type || "", 40),
        label: sanitizeText(element.label || element.text || "", OBS_ELEMENT_LABEL_CAP),
      };
    })
    .filter(Boolean);
}

function sanitizeScreenshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const encoding = String(value.encoding || "").trim();
  if (encoding === "base64_jpeg") {
    const data = String(value.data || "");
    if (!data || data.length > SCREENSHOT_BASE64_CAP) {
      return { encoding: "omitted", reason: data ? "screenshot too large for gateway audit cap" : "no screenshot data" };
    }
    return { encoding: "base64_jpeg", data };
  }
  return { encoding: "omitted", reason: sanitizeText(value.reason || "screenshot omitted", 200) };
}

// Sanitize an inbound observation to the bounded shape the model and the task
// record use. The screenshot is split out (stored latest-only on the task); the
// history copy of the observation keeps only a small marker.
function sanitizeObservation(raw) {
  const observation = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const stepNum = Number(observation.step);
  const lastAction = sanitizeAgentAction(observation.last_action);
  return {
    url: sanitizeText(observation.url || "", 1000),
    title: sanitizeText(observation.title || "", 300),
    elements: sanitizeElements(observation.elements),
    page_text: observation.page_text ? sanitizeText(observation.page_text, OBS_PAGE_TEXT_CAP) : "",
    screenshot: sanitizeScreenshot(observation.screenshot),
    last_action: lastAction || null,
    last_action_result: observation.last_action_result
      ? sanitizeText(observation.last_action_result, OBS_LAST_ACTION_RESULT_CAP)
      : "",
    step: Number.isInteger(stepNum) && stepNum >= 0 ? stepNum : null,
  };
}

// The copy of an observation stored in the step history: never carries the
// screenshot bytes (those live latest-only on the task record).
function observationForHistory(observation) {
  const { screenshot, ...rest } = observation;
  return {
    ...rest,
    screenshot: screenshot && screenshot.encoding === "base64_jpeg"
      ? { encoding: "stored_on_task" }
      : screenshot || null,
  };
}

function oneLineStep(entry) {
  const action = entry.action || {};
  const obs = entry.observation || {};
  const where = obs.title || obs.url || "";
  const actionText = action.kind === "finish"
    ? `finish(${action.status || "done"})`
    : action.kind || "unknown";
  return `step ${entry.step}: ${actionText}${where ? ` @ ${sanitizeText(where, 80)}` : ""}`;
}

// Build the TEXT-ONLY model context: instruction + bounded step history (last 8
// full, older one-line each) + the latest observation's url/title/elements/
// page_text. No screenshot ever reaches the model in v1.
function buildPlannerContext(task, observation) {
  const steps = Array.isArray(task.steps) ? task.steps : [];
  const older = steps.slice(0, Math.max(0, steps.length - HISTORY_FULL_STEPS));
  const recent = steps.slice(Math.max(0, steps.length - HISTORY_FULL_STEPS));
  const lines = [];
  lines.push(`Task: ${task.instruction}`);
  if (task.url) {
    lines.push(`Starting URL: ${task.url}`);
  }
  if (older.length) {
    lines.push("");
    lines.push("Earlier steps:");
    for (const entry of older) {
      lines.push(`- ${oneLineStep(entry)}`);
    }
  }
  if (recent.length) {
    lines.push("");
    lines.push("Recent steps:");
    for (const entry of recent) {
      lines.push(`- ${oneLineStep(entry)}`);
      if (entry.action && entry.action.kind === "finish" && entry.action.summary) {
        lines.push(`  summary: ${sanitizeText(entry.action.summary, 200)}`);
      }
    }
  }
  lines.push("");
  lines.push("Current observation:");
  lines.push(`URL: ${observation.url || "(unknown)"}`);
  lines.push(`Title: ${observation.title || "(unknown)"}`);
  if (observation.last_action) {
    lines.push(`Last action: ${observation.last_action.kind}${observation.last_action_result ? ` -> ${observation.last_action_result}` : ""}`);
  }
  if (observation.elements.length) {
    lines.push("Interactable elements:");
    for (const element of observation.elements) {
      const descriptor = [element.tag, element.type].filter(Boolean).join("/");
      lines.push(`[${element.i}] ${descriptor}${element.label ? ` "${element.label}"` : ""}`);
    }
  }
  if (observation.page_text) {
    lines.push("");
    lines.push("Page text:");
    lines.push(observation.page_text);
  }
  return { system: AGENT_SYSTEM_PROMPT, userText: lines.join("\n") };
}

// The act/finish tool defs for the model tool loop. The handlers ONLY capture
// the proposed action into `capture` — they never execute anything. First tool
// call wins for the step (single next action).
function buildAgentToolDefs(capture) {
  const record = (action) => {
    if (!capture.action) {
      capture.action = action;
    }
    return { ok: true, captured: true };
  };
  return [
    {
      name: "act",
      description: "Perform one action in the browser to move toward the goal.",
      parameters: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: ["click", "type", "clear", "select", "scroll", "navigate", "key", "wait", "screenshot"],
            description: "click/type/clear/select target an element by index; scroll the page up/down; navigate to a url; key presses a key such as Enter; wait pauses; screenshot requests a screenshot next observation.",
          },
          index: { type: "integer", description: "Element index for click/type/clear/select." },
          text: { type: "string", description: "Text to type, option label to select, or key name to press." },
          direction: { type: "string", enum: ["up", "down"], description: "Scroll direction." },
          url: { type: "string", description: "Absolute http(s) URL for navigate." },
        },
        required: ["kind"],
      },
      handler: (args) => record({
        kind: args && args.kind,
        index: args && args.index,
        text: args && args.text,
        direction: args && args.direction,
        url: args && args.url,
      }),
    },
    {
      name: "finish",
      description: "End the task: goal achieved (status done), or blocked and handing control back to the user (status blocked).",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "One or two sentences on what happened." },
          status: { type: "string", enum: ["done", "blocked"], description: "done when the goal is met; blocked when you cannot continue." },
        },
        required: ["summary"],
      },
      handler: (args) => record({
        kind: "finish",
        status: (args && args.status) || "done",
        summary: (args && args.summary) || "",
      }),
    },
  ];
}

// Keyless deterministic planner: step 0 waits (lets the page settle / first
// screenshot arrive), later steps finish naming the observed page. This keeps
// the loop working with no model key and is the safe rejection fallback.
function deterministicFallbackAction(stepIndex, observation) {
  if (stepIndex <= 0) {
    return { kind: "wait" };
  }
  const where = observation.title || observation.url || "the page";
  return {
    kind: "finish",
    status: "done",
    summary: sanitizeText(`Observed ${where}`, 2000),
  };
}

function createBrowserAgentLoopStore(options = {}) {
  const dataDir = options.dataDir;
  if (!dataDir) {
    throw new Error("createBrowserAgentLoopStore requires a dataDir");
  }
  // planNext({ task, observation, system, userText }) -> raw captured action or
  // null. Injected by server.js so the model-call machinery stays there and the
  // lib stays pure/testable. A null result (no provider, transport error, or an
  // invalid capture) drops to the deterministic fallback.
  const planNext = typeof options.planNext === "function" ? options.planNext : null;
  const dir = path.join(dataDir, "browser-agent-tasks");
  fs.mkdirSync(dir, { recursive: true });

  function taskPath(id) {
    return path.join(dir, `${sanitizeId(id)}.json`);
  }

  function writeTask(task) {
    const filePath = taskPath(task.id);
    const tmpPath = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(task, null, 2));
    fs.renameSync(tmpPath, filePath);
  }

  function readTask(id) {
    const filePath = taskPath(id);
    if (!fs.existsSync(filePath)) return null;
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      return null;
    }
  }

  function listAll() {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((name) => name.endsWith(".json") && !name.endsWith(".tmp"))
      .map((name) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  function summarize(task, opts = {}) {
    return {
      id: task.id,
      status: task.status,
      instruction: task.instruction,
      url: task.url || "",
      source: task.source || "",
      conversation_id: task.conversation_id || "",
      branch_id: task.branch_id || "default",
      agent_run_id: task.agent_run_id || "",
      max_steps: task.max_steps,
      step_count: task.step_count || 0,
      steps: opts.includeSteps ? (task.steps || []) : undefined,
      claimed_by: task.claimed_by || "",
      claimed_at: task.claimed_at || "",
      lease_expires_at: task.lease_expires_at || "",
      summary: task.summary || "",
      error: task.error || "",
      has_screenshot: Boolean(task.latest_screenshot && task.latest_screenshot.encoding === "base64_jpeg"),
      created_at: task.created_at,
      updated_at: task.updated_at,
      finished_at: task.finished_at || "",
    };
  }

  function create(body = {}) {
    const instruction = sanitizeText(String(body.instruction || body.prompt || body.task || "").trim(), INSTRUCTION_CAP);
    if (!instruction) {
      throw new Error("instruction is required");
    }
    const now = new Date().toISOString();
    const task = {
      id: randomId("bagent"),
      status: "pending",
      instruction,
      url: sanitizeHttpUrl(body.url),
      source: String(body.source || "unknown").slice(0, 80),
      conversation_id: body.conversation_id ? sanitizeId(body.conversation_id) : "",
      branch_id: body.branch_id ? (sanitizeId(body.branch_id) || "default") : "default",
      agent_run_id: body.agent_run_id ? sanitizeId(body.agent_run_id) : "",
      max_steps: clampMaxSteps(body.max_steps),
      step_count: 0,
      steps: [],
      claimed_by: "",
      claimed_at: "",
      lease_expires_at: "",
      summary: "",
      error: "",
      latest_screenshot: null,
      created_at: now,
      updated_at: now,
      finished_at: "",
    };
    writeTask(task);
    return task;
  }

  function claim(clientId) {
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const task = listAll()
      .filter((candidate) => {
        if (candidate.status === "pending") return true;
        if (candidate.status !== "claimed") return false;
        const expires = Date.parse(candidate.lease_expires_at || "");
        return Number.isFinite(expires) && expires < nowMs;
      })
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))[0];
    if (!task) return null;
    const next = {
      ...task,
      status: "claimed",
      claimed_by: String(clientId || "agee-extension").slice(0, 120),
      claimed_at: now,
      lease_expires_at: new Date(nowMs + LEASE_MS).toISOString(),
      updated_at: now,
    };
    writeTask(next);
    return next;
  }

  function list({ status = "", limit = 25 } = {}) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 25, 100));
    return listAll()
      .filter((task) => !status || task.status === status)
      .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
      .slice(0, safeLimit)
      .map((task) => summarize(task));
  }

  function get(id) {
    const task = readTask(id);
    return task ? summarize(task, { includeSteps: true }) : null;
  }

  // Advance the loop one step: sanitize the observation, plan the next action
  // (model with act/finish tools, else deterministic fallback), append the
  // { step, observation, action } record, renew the lease, and store the latest
  // screenshot (replacing any prior one) for audit. Returns { action, step,
  // done } or an { error, code } the route maps to an HTTP status.
  async function step(id, body = {}) {
    const task = readTask(id);
    if (!task) {
      return { error: "browser agent task not found", code: 404 };
    }
    if (isTerminalStatus(task.status)) {
      return { error: `browser agent task already ${task.status}`, code: 409 };
    }
    const observation = sanitizeObservation(body.observation || body);
    const stepIndex = observation.step != null ? observation.step : (task.step_count || 0);

    let action;
    if (stepIndex >= task.max_steps) {
      action = {
        kind: "finish",
        status: "blocked",
        summary: sanitizeText(`Reached the ${task.max_steps}-step limit before finishing: ${task.instruction}`, 2000),
      };
    } else {
      const context = buildPlannerContext(task, observation);
      let proposed = null;
      if (planNext) {
        try {
          proposed = await planNext({ task, observation, system: context.system, userText: context.userText });
        } catch {
          proposed = null;
        }
      }
      action = sanitizeAgentAction(proposed) || deterministicFallbackAction(stepIndex, observation);
    }

    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const steps = Array.isArray(task.steps) ? task.steps.slice() : [];
    steps.push({ step: stepIndex, observation: observationForHistory(observation), action });
    const latestScreenshot = observation.screenshot && observation.screenshot.encoding === "base64_jpeg"
      ? observation.screenshot
      : task.latest_screenshot || null;
    const next = {
      ...task,
      steps,
      step_count: steps.length,
      latest_screenshot: latestScreenshot,
      lease_expires_at: new Date(nowMs + LEASE_MS).toISOString(),
      updated_at: now,
    };
    writeTask(next);
    return { action, step: stepIndex, done: action.kind === "finish", task: summarize(next) };
  }

  function finish(id, body = {}) {
    const task = readTask(id);
    if (!task) {
      return { error: "browser agent task not found", code: 404 };
    }
    const requested = String(body.status || "done").trim().toLowerCase();
    const status = ["done", "failed", "cancelled"].includes(requested) ? requested : "done";
    const summary = sanitizeText(body.summary || "", 2000);
    const now = new Date().toISOString();
    const next = {
      ...task,
      status,
      summary,
      error: status === "failed" ? (summary || "browser agent task failed") : "",
      updated_at: now,
      finished_at: now,
    };
    writeTask(next);
    return { task: summarize(next, { includeSteps: true }), status, summary, agent_run_id: task.agent_run_id || "" };
  }

  function healthCounts() {
    const nowMs = Date.now();
    let pending = 0;
    let active = 0;
    for (const task of listAll()) {
      if (task.status === "pending") {
        pending += 1;
      } else if (task.status === "claimed") {
        const expires = Date.parse(task.lease_expires_at || "");
        if (Number.isFinite(expires) && expires > nowMs) {
          active += 1;
        }
      }
    }
    return { pending, active };
  }

  return {
    dir,
    create,
    claim,
    list,
    get,
    getRecord: readTask,
    summarize,
    step,
    finish,
    healthCounts,
  };
}

module.exports = {
  createBrowserAgentLoopStore,
  sanitizeAgentAction,
  sanitizeObservation,
  observationForHistory,
  buildPlannerContext,
  buildAgentToolDefs,
  deterministicFallbackAction,
  AGENT_SYSTEM_PROMPT,
  ACTION_KINDS,
  MAX_STEPS_CEILING,
  DEFAULT_MAX_STEPS,
  LEASE_MS,
};
