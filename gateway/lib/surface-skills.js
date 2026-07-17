"use strict";

// Per-surface skills. The skills offered to the model depend on the surface a
// turn came from, while chat history stays shared (one default session). Phone
// and browser actions are ALWAYS offered because cross-device is the point of
// the tool hub: a browser turn can ask the phone to open an app, and a phone
// turn can ask the browser to open a tab. Each such action is brokered as a
// bounded tool_request the target client must claim, validate against its own
// local manifest, execute, and receipt. The gateway only queues and polls; it
// never presses a phone button or opens a tab itself.
//
// This lib is pure and dependency-injected: server.js passes in the real
// createToolRequest / readToolRequest / launchBrowserAgentTask so the model-call
// and store machinery stays there and this file stays testable.

// Canonical surface resolver. android-overlay/android -> android;
// agee-extension/browser -> browser. isBrowserSourcedCall delegates to this so
// existing callers keep identical behavior (browser detection is unchanged).
function resolveTurnSurface(call) {
  const source = String(call && call.source ? call.source : "").toLowerCase();
  if (source.includes("android")) return "android";
  if (source.includes("agee-extension") || source.includes("browser")) return "browser";
  return "unknown";
}

// Code-mode capability name -> brokered tool + target surface + input field.
const PHONE_CAPABILITIES = {
  phone_open_app: {
    tool: "app.launch",
    surface: "android",
    field: "app",
    aliases: ["app", "app_name", "name", "package", "target"],
    max: 240,
    label: "open an app on the phone",
  },
  phone_open_url: {
    tool: "url.open",
    surface: "android",
    field: "url",
    aliases: ["url", "link", "address"],
    max: 2000,
    label: "open a URL on the phone",
  },
  phone_dial: {
    tool: "phone.dial",
    surface: "android",
    field: "number",
    aliases: ["number", "phone", "tel", "phone_number"],
    max: 40,
    label: "open the phone dialer with a number (the user presses call)",
  },
  phone_open_contact: {
    tool: "contact.open",
    surface: "android",
    field: "name",
    aliases: ["name", "contact", "person"],
    max: 200,
    label: "open a contact card on the phone",
  },
  browser_open_tab: {
    tool: "browser.tab.open",
    surface: "browser_extension",
    field: "url",
    aliases: ["url", "link", "address"],
    max: 2000,
    label: "open a tab in the browser",
  },
};

// Classic tool `tool` enum -> code-mode capability that carries the same broker
// mapping, so the non-code-mode path proposes the exact same tool_request.
const CLASSIC_PHONE_TOOLS = {
  "app.launch": "phone_open_app",
  "url.open": "phone_open_url",
  "phone.dial": "phone_dial",
  "contact.open": "phone_open_contact",
};

function cleanErr(deps, error) {
  if (deps && typeof deps.cleanError === "function") {
    return deps.cleanError(error);
  }
  return String((error && error.message) || error || "unknown error").replace(/[\r\n]+/g, " ").slice(0, 500);
}

function pickInputValue(args, spec) {
  const source = args && typeof args === "object" && !Array.isArray(args) ? args : {};
  if (source.input && typeof source.input === "object" && !Array.isArray(source.input)) {
    for (const alias of spec.aliases) {
      if (source.input[alias] != null && String(source.input[alias]).trim()) {
        return String(source.input[alias]).trim().slice(0, spec.max);
      }
    }
  }
  for (const alias of spec.aliases) {
    if (source[alias] != null && String(source[alias]).trim()) {
      return String(source[alias]).trim().slice(0, spec.max);
    }
  }
  return "";
}

function defaultDelay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Poll the stored tool_request for a receipt: 400ms cadence up to ~10s. On a
// terminal receipt return it; on timeout the caller returns { queued: true }.
async function awaitToolReceipt(deps, requestId, options = {}) {
  const timeoutMs = Number(options.timeoutMs) || 10000;
  const pollMs = Number(options.pollMs) || 400;
  const delay = typeof deps.delay === "function" ? deps.delay : defaultDelay;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let current = null;
    try {
      current = await deps.readToolRequest(requestId);
    } catch {
      current = null;
    }
    if (current && (current.status === "completed" || current.status === "failed")) {
      const receipts = Array.isArray(current.receipts) ? current.receipts : [];
      return {
        resolved: true,
        ok: current.status === "completed",
        status: current.status,
        receipt: receipts.length ? receipts[receipts.length - 1] : (current.latest_receipt || null),
      };
    }
    await delay(pollMs);
  }
  return { resolved: false };
}

// Broker one phone/browser action: create the tool_request targeting the mapped
// surface + tool, then await a receipt. On timeout, return { queued: true,
// request_id } instead of failing.
async function brokerToolRequest(call, deps, spec, value, options = {}) {
  if (!value) {
    return { ok: false, error: `${spec.field} is required to ${spec.label}` };
  }
  let request;
  try {
    request = await deps.createToolRequest({
      tool: spec.tool,
      target_surface_type: spec.surface,
      input: options.inputObject ? value : { [spec.field]: value },
      source: (call && call.source) || "surface-skill",
      source_surface_type: resolveTurnSurface(call),
      session_id: (call && (call.conversation_id || call.session_id)) || "",
      branch_id: (call && call.branch_id) || "default",
      instruction: `Surface skill: ${spec.label}.`,
    });
  } catch (error) {
    return { ok: false, tool: spec.tool, error: cleanErr(deps, error) };
  }
  const requestId = request && (request.id || request.request_id);
  const outcome = await awaitToolReceipt(deps, requestId, options);
  if (!outcome.resolved) {
    return {
      ok: true,
      type: "tool_request_queued",
      tool: spec.tool,
      queued: true,
      request_id: requestId,
      message: `Queued ${spec.tool} for the ${spec.surface} client; it will run when the device claims it.`,
    };
  }
  return {
    ok: outcome.ok,
    type: "tool_request_receipt",
    tool: spec.tool,
    request_id: requestId,
    status: outcome.status,
    receipt: outcome.receipt,
    message: outcome.ok
      ? `The ${spec.surface} client ran ${spec.tool}.`
      : `The ${spec.surface} client could not run ${spec.tool}.`,
  };
}

async function launchBrowserAgentTask(call, deps, args) {
  const instruction = String((args && (args.instruction || args.prompt || args.task)) || "").trim();
  if (!instruction) {
    return { ok: false, error: "instruction is required to launch a background browser task" };
  }
  const url = String((args && args.url) || "").trim();
  try {
    const created = await deps.launchBrowserAgentTask({
      instruction,
      url,
      call,
      delegation_envelope: call && call.delegation_envelope,
    });
    return {
      ok: true,
      type: "browser_agent_task",
      task_id: created.task_id,
      agent_run_id: created.agent_run_id,
      message: `Started background browser task ${created.task_id}; it runs in the browser and its result appears in session context.`,
    };
  } catch (error) {
    return { ok: false, error: cleanErr(deps, error) };
  }
}

async function browserPageAutomation(call, deps, args) {
  const { BROWSER_AUTOMATION_TOOL, validateBrowserAutomationRequest } = require("./browser-automation-capability");
  const checked = validateBrowserAutomationRequest(args || {});
  if (!checked.ok) return { ok: false, error: checked.error };
  return brokerToolRequest(call, deps, {
    tool: BROWSER_AUTOMATION_TOOL,
    surface: "browser_extension",
    field: "request",
    label: "run a Chief MOA browser page operation",
  }, checked.request, {
    inputObject: true,
    timeoutMs: deps.browserToolReceiptTimeoutMs,
    pollMs: deps.browserToolReceiptPollMs,
  });
}

// The code-mode capabilities merged into cascadedExecuteCapabilities. Each phone
// capability creates a brokered tool_request and awaits a receipt; browser_agent
// _task starts a background browser agent-loop task.
function surfaceExecuteCapabilities(call, deps) {
  const capabilities = {};
  for (const [name, spec] of Object.entries(PHONE_CAPABILITIES)) {
    capabilities[name] = {
      description: `Ask the connected device to ${spec.label}. Args: { ${spec.field}: string }. Brokered as a ${spec.tool} tool_request the ${spec.surface} client claims, validates, executes, and receipts; returns { queued: true } if no device claims it within ~10s.`,
      run: (args) => brokerToolRequest(call, deps, spec, pickInputValue(args || {}, spec)),
    };
  }
  capabilities.browser_agent_task = {
    description: "Start a background browser agent only when the trusted turn carries a confirmed delegation envelope. Args: { instruction: string, url?: string }. Returns { task_id, agent_run_id }.",
    run: (args) => launchBrowserAgentTask(call, deps, args || {}),
  };
  capabilities.browser_page_automation = {
    description: "Use Chief MOA's local browser extension to inspect a page (read_only) or apply a validated page tweak (full_control). The gateway queues; only the extension executes and receipts.",
    run: (args) => browserPageAutomation(call, deps, args || {}),
  };
  return capabilities;
}

// Classic (non-code-mode) tool defs so the surface skills work even when the
// `execute` tool is off. Added to the cascaded tool loop next to the agent-run
// tools. Handlers reuse the exact same brokers as the capabilities above.
function surfaceClassicTools(call, deps) {
  return [
    {
      name: "phone_action",
      description: "Ask the connected phone to run one local action. tool is the action; input carries its argument. app.launch opens an app ({app}); url.open opens a URL ({url}); phone.dial opens the dialer with a number the user presses call on ({number}); contact.open opens a contact card ({name}). Brokered as a tool_request the phone claims, validates, executes, and receipts.",
      parameters: {
        type: "object",
        properties: {
          tool: {
            type: "string",
            enum: ["app.launch", "url.open", "phone.dial", "contact.open"],
            description: "Which phone-local action to run.",
          },
          input: {
            type: "object",
            description: "Argument for the action: {app} for app.launch, {url} for url.open, {number} for phone.dial, {name} for contact.open.",
          },
        },
        required: ["tool"],
      },
      handler: (args) => {
        const capabilityName = CLASSIC_PHONE_TOOLS[String((args && args.tool) || "").trim()];
        const spec = capabilityName ? PHONE_CAPABILITIES[capabilityName] : null;
        if (!spec) {
          return Promise.resolve({ ok: false, error: "tool must be one of app.launch, url.open, phone.dial, contact.open" });
        }
        return brokerToolRequest(call, deps, spec, pickInputValue(args || {}, spec));
      },
    },
    {
      name: "launch_background_browser_task",
      description: "Start a background browser agent that opens tabs the user does not see and works a multi-step task (research, navigation, extraction). It runs in the browser and its result appears in session context; confirm it started, do not claim the work is done. Args: { instruction, url? }.",
      parameters: {
        type: "object",
        properties: {
          instruction: { type: "string", description: "Complete, self-contained task for the browser agent." },
          url: { type: "string", description: "Optional starting URL." },
        },
        required: ["instruction"],
      },
      handler: (args) => launchBrowserAgentTask(call, deps, args || {}),
    },
    {
      name: "browser_page_automation",
      description: "Ask the connected Chief MOA browser extension to inspect a page or apply one validated page tweak. inspect_page is read_only; apply_page_tweak is full_control and requires explicit local approval. The gateway never executes page actions.",
      parameters: {
        type: "object",
        properties: {
          operation: { type: "string", enum: ["inspect_page", "apply_page_tweak"] },
          target_tab_id: { type: "string" },
          include: { type: "array", items: { type: "string" } },
          tweak: { type: "object" },
        },
        required: ["operation", "target_tab_id"],
      },
      handler: (args) => browserPageAutomation(call, deps, args || {}),
    },
  ];
}

module.exports = {
  resolveTurnSurface,
  surfaceExecuteCapabilities,
  surfaceClassicTools,
  brokerToolRequest,
  launchBrowserAgentTask,
  awaitToolReceipt,
  PHONE_CAPABILITIES,
  browserPageAutomation,
};
