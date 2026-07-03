// agee — background service worker.
// Thin client: every turn is routed to the user's self-hosted gateway. No
// provider API keys and no direct model calls live in the browser; the gateway
// owns model routing and credentials.

import { getEffectiveGatewayConfig, seedGatewayConfig } from "./config.js";
import { parseSettingsIntent, parseProfileQueryIntent, looksLikeGatewayProfileControlIntent } from "./settings-intent.js";
import { parseBrowserTaskIntent, parseOpenTabIntent } from "./browser-task-intent.js";
import { isStopCommand } from "./stop-intent.js";

// Seed storage from the baked defaults on install/update so the Options page
// shows the live values and the user never has to fill them in by hand. Only
// fills blanks — a value the user typed always wins.
chrome.runtime.onInstalled.addListener(async () => {
  await seedGatewayConfig();
  await ensureContentOnOpenTabs();
});
void seedGatewayConfig();
chrome.runtime.onStartup.addListener(() => {
  ensureContentOnOpenTabs().catch(() => {});
});
const MAX_ELEMENTS = 100;
const ALLOWED_NAVIGATION_PROTOCOLS = new Set(["http:", "https:"]);
// Cues run concurrently: the user keeps talking, each utterance is its own lane.
// Keyed by cueId (a per-cue string), each value is { controller, tabId } so we
// can cancel one cue or all cues on a tab without blocking new ones.
const tasks = new Map();
const voiceSessions = new Map();
const MAX_PENDING_VOICE_EVENTS = 50;
// Microphone capture starts as soon as a voice session is requested — in
// parallel with the ticket/WebSocket handshake — so the start of the utterance
// is never lost. PCM captured before the gateway's session_ready is buffered
// here (drop-oldest beyond ~8s) and flushed once the turn is ready.
const MAX_PENDING_VOICE_AUDIO_BYTES = 16000 * 2 * 8;
const OFFSCREEN_VOICE_DOCUMENT = "offscreen.html";
const ACTIVE_BROWSER_AGENT_OWNER_KEY = "ageeActiveBrowserAgentOwner";
const VOICE_AUTO_COMMIT_ENABLED = true;
const VOICE_AUTO_COMMIT_SILENCE_MS = 900;
const VOICE_AUTO_COMMIT_MIN_SPEECH_MS = 220;
const VOICE_AUTO_COMMIT_MAX_RECORDING_MS = 18000;
const VOICE_ACTIVITY_RMS_THRESHOLD = 0.008;
const VOICE_ACTIVITY_PEAK_THRESHOLD = 0.055;
let activeAgentTabId = null;
let creatingOffscreenVoiceDocument = null;

async function getConfig() {
  return getEffectiveGatewayConfig();
}

// Pipe a request into the user's own agent gateway instead of the model vendor.
// Returns the parsed JSON body for the given path (e.g. "/v1/chat", "/health").
async function callGateway(cfg, path, { method = "POST", body, signal } = {}) {
  if (!cfg.gatewayUrl) {
    throw new Error("No gateway URL set. Open A.G. Options and set the Agent gateway URL.");
  }
  const headers = { "content-type": "application/json" };
  if (cfg.gatewayToken) headers.authorization = `Bearer ${cfg.gatewayToken}`;
  const resp = await fetch(`${cfg.gatewayUrl}${path}`, {
    method,
    signal,
    headers,
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await resp.text();
  if (!resp.ok) {
    if (resp.status === 401) {
      throw new Error(
        "Gateway rejected the token (401). Open A.G. Options and set a valid Gateway token, then Save."
      );
    }
    throw new Error(`gateway ${resp.status}: ${text.slice(0, 300)}`);
  }
  if (resp.status === 204 || !text.trim()) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`gateway returned non-JSON: ${text.slice(0, 200)}`);
  }
}

async function gatewayHealth(cfg, signal) {
  return callGateway(cfg, "/health", { method: "GET", signal });
}

// ---- Gateway-queued browser tasks -----------------------------------------
// Gemini Live can queue browser work on the gateway. The extension is the only
// component allowed to execute page-local CDP actions, so it claims tasks here,
// runs bounded debugger actions in a disposable background tab, then posts a
// receipt back to the gateway.
const BROWSER_TASK_CLIENT_ID = `agee-extension-${chrome.runtime.id}`;
const BROWSER_TASK_POLL_MS = 2000;
const DEV_RELOAD_ALARM = "agee-dev-reload-poll";
const DEV_RELOAD_DEFAULT_SERVER = "http://localhost:7777";
const DEV_RELOAD_POLL_MS = 1500;
const DEVICE_CLIENT_HEARTBEAT_MS = 15000;
let browserTaskPollInFlight = false;
let browserTaskPollTimer = null;
let browserToolRequestPollInFlight = false;
let devReloadPollTimer = null;
let devReloadPollInFlight = false;
let deviceClientHeartbeatTimer = null;
let deviceClientHeartbeatInFlight = false;

function startBrowserTaskPolling() {
  if (!chrome?.storage?.local || !chrome?.alarms || !chrome?.debugger || !chrome?.tabs) return;
  if (browserTaskPollTimer) return;
  browserTaskPollTimer = setInterval(() => {
    pollBrowserTasks().catch(() => {});
    pollBrowserToolRequests().catch(() => {});
  }, BROWSER_TASK_POLL_MS);
  chrome.alarms.create("agee-browser-task-poll", { periodInMinutes: 0.5 });
  pollBrowserTasks().catch(() => {});
  pollBrowserToolRequests().catch(() => {});
}

async function pollBrowserTasks() {
  if (browserTaskPollInFlight) return;
  browserTaskPollInFlight = true;
  try {
    const cfg = await getConfig();
    if (!cfg.gatewayUrl) return;
    const claimed = await callGateway(cfg, "/v1/browser/tasks/claim", {
      body: { client_id: BROWSER_TASK_CLIENT_ID },
    });
    const task = claimed?.task;
    if (!task?.id) return;
    const receipt = await executeGatewayBrowserTask(task);
    await callGateway(cfg, `/v1/browser/tasks/${encodeURIComponent(task.id)}/receipts`, {
      body: {
        client_id: BROWSER_TASK_CLIENT_ID,
        ...receipt,
      },
    });
  } catch {
    // Polling is background infrastructure; individual task failures are
    // reported as receipts when a task was claimed.
  } finally {
    browserTaskPollInFlight = false;
  }
}

async function pollBrowserToolRequests() {
  if (browserToolRequestPollInFlight) return;
  browserToolRequestPollInFlight = true;
  try {
    const cfg = await getConfig();
    if (!cfg.gatewayUrl) return;
    const deviceId = await getStableDeviceId();
    const claimed = await callGateway(cfg, "/v1/tool/requests/claim", {
      body: {
        device_id: deviceId,
        surface_type: "browser_extension",
        local_tool_manifest: browserLocalToolManifest(),
      },
    });
    const request = claimed?.request;
    if (!request?.id) return;
    const receipt = await executeBrowserToolRequest(request);
    await callGateway(cfg, `/v1/tool/requests/${encodeURIComponent(request.id)}/receipts`, {
      body: {
        device_id: deviceId,
        ...receipt,
      },
    });
  } catch {
    // Background polling stays quiet; claimed work reports through receipts.
  } finally {
    browserToolRequestPollInFlight = false;
  }
}

async function executeBrowserToolRequest(request) {
  const tool = String(request?.tool || "");
  const input = request?.input && typeof request.input === "object" ? request.input : {};
  try {
    if (tool === "browser.tab.open") {
      const url = allowedBrowserTaskUrl(input.url || input.href || input.target);
      if (!url) {
        return { ok: false, error: "blocked or invalid browser.tab.open URL", summary: "Browser tab open request was blocked." };
      }
      const tab = await chrome.tabs.create({ url, active: true });
      return {
        ok: true,
        summary: `Browser opened ${tab.url || url}.`,
        result: { tab_id: tab.id || null, url: tab.url || url },
        local_receipt: { tool, success: true },
      };
    }
    if (tool === "page.snapshot") {
      const [active] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
      if (!active?.id) {
        return { ok: false, error: "no active tab", summary: "No active browser tab was available." };
      }
      await ensureContent(active.id);
      const snap = await ask(active.id, { cmd: "snapshot" });
      return {
        ok: true,
        summary: `Captured page snapshot for ${snap?.title || active.title || "active tab"}.`,
        result: { screen: snapToScreen(snap) },
        local_receipt: { tool, success: true },
      };
    }
    if (tool === "browser.task.claim") {
      return {
        ok: true,
        summary: "Browser queued-task claim loop is active.",
        local_receipt: { tool, success: true },
      };
    }
    return { ok: false, error: `unsupported browser tool: ${tool}`, summary: `Unsupported browser tool: ${tool}` };
  } catch (error) {
    return {
      ok: false,
      error: String(error?.message || error),
      summary: `Browser tool request failed: ${tool}`,
      local_receipt: { tool, success: false },
    };
  }
}

async function executeGatewayBrowserTask(task) {
  let bgTabId = null;
  let attached = false;
  const target = {};
  const actionResults = [];
  let screenshot = null;
  let pageState = null;
  try {
    const startUrl = await browserTaskStartUrl(task);
    const bgTab = await chrome.tabs.create({ url: "about:blank", active: false });
    bgTabId = bgTab.id;
    target.tabId = bgTabId;
    await debuggerAttach(target);
    attached = true;
    await debuggerSend(target, "Page.enable");
    await debuggerSend(target, "Runtime.enable");

    if (startUrl) {
      await debuggerSend(target, "Page.navigate", { url: startUrl });
      await waitForBackgroundTabLoad(bgTabId);
    }

    const actions = Array.isArray(task.cdp_actions) && task.cdp_actions.length
      ? task.cdp_actions
      : defaultBrowserTaskActions(task);

    for (const action of actions) {
      const method = String(action?.method || "");
      const params = action?.params && typeof action.params === "object" ? action.params : {};
      if (!isAllowedQueuedCdpMethod(method)) {
        actionResults.push({ method, ok: false, error: "blocked CDP method" });
        continue;
      }
      try {
        const result = await debuggerSend(target, method, params);
        if (method === "Page.navigate") {
          await waitForBackgroundTabLoad(bgTabId);
        }
        if (method === "Page.captureScreenshot") {
          screenshot = { format: params.format || "png", bytes: result?.data ? result.data.length : 0 };
        }
        actionResults.push({ method, ok: true, value: compactCdpResult(result) });
      } catch (error) {
        actionResults.push({ method, ok: false, error: String(error?.message || error) });
      }
    }

    pageState = await readCdpPageState(target);
    if (!screenshot) {
      const shot = await debuggerSend(target, "Page.captureScreenshot", { format: "jpeg", quality: 35 });
      screenshot = { format: "jpeg", bytes: shot?.data ? shot.data.length : 0 };
    }

    const title = pageState?.title || "(untitled)";
    return {
      ok: actionResults.every((result) => result.ok !== false),
      summary: `Browser task completed in background tab: ${title}`,
      action_results: actionResults,
      page_state: pageState,
      screenshot,
    };
  } catch (error) {
    return {
      ok: false,
      error: String(error?.message || error),
      summary: "Browser task failed in extension CDP executor.",
      action_results: actionResults,
      page_state: pageState,
      screenshot,
    };
  } finally {
    if (attached) await debuggerDetach(target);
    if (bgTabId != null) {
      try {
        await chrome.tabs.remove(bgTabId);
      } catch {
        // already gone
      }
    }
  }
}

async function browserTaskStartUrl(task) {
  const explicit = allowedBrowserTaskUrl(task?.url);
  if (explicit) return explicit;
  const owner = await getActiveBrowserAgentOwner();
  const ownerTabId = Number(owner?.tab_id ?? owner?.tabId);
  if (Number.isFinite(ownerTabId)) {
    try {
      const tab = await chrome.tabs.get(ownerTabId);
      const ownerUrl = allowedBrowserTaskUrl(tab?.url || owner?.page_url);
      if (ownerUrl) return ownerUrl;
    } catch {
      const ownerUrl = allowedBrowserTaskUrl(owner?.page_url);
      if (ownerUrl) return ownerUrl;
    }
  }
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  return allowedBrowserTaskUrl(active?.url);
}

function allowedBrowserTaskUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return ALLOWED_NAVIGATION_PROTOCOLS.has(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

function defaultBrowserTaskActions() {
  return [
    { method: "Runtime.evaluate", params: { expression: "JSON.stringify({ title: document.title, url: location.href, ready: document.readyState })", returnByValue: true } },
    { method: "Page.captureScreenshot", params: { format: "jpeg", quality: 40 } },
  ];
}

function isAllowedQueuedCdpMethod(method) {
  return method === "Page.navigate" ||
    method === "Runtime.evaluate" ||
    method === "Input.dispatchKeyEvent" ||
    method === "Input.insertText" ||
    method === "Page.captureScreenshot";
}

function compactCdpResult(result) {
  if (!result || typeof result !== "object") return null;
  if (result.data) {
    return { data_bytes: String(result.data).length };
  }
  if (result.result?.value != null) {
    return result.result.value;
  }
  return JSON.stringify(result).slice(0, 1000);
}

async function readCdpPageState(target) {
  const evalRes = await debuggerSend(target, "Runtime.evaluate", {
    expression: "JSON.stringify({ title: document.title, url: location.href, ready: document.readyState })",
    returnByValue: true,
  });
  try {
    return JSON.parse(evalRes?.result?.value || "{}");
  } catch {
    return {};
  }
}

if (chrome?.alarms?.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "agee-browser-task-poll") {
      pollBrowserTasks().catch(() => {});
      pollBrowserToolRequests().catch(() => {});
    } else if (alarm.name === DEV_RELOAD_ALARM) {
      pollDevReloadVersion("alarm").catch(() => {});
    }
  });
}
startBrowserTaskPolling();
startDevReloadPolling().catch(() => {});
startDeviceClientHeartbeat().catch(() => {});
reloadDevTabsAfterExtensionRestart().catch(() => {});

// ---- Gateway device-client heartbeat --------------------------------------
// The gateway is the shared registry; the extension advertises only browser-local
// capabilities. It does not execute phone actions and it never stores provider
// keys.
async function startDeviceClientHeartbeat() {
  if (!chrome?.storage?.local) return;
  if (deviceClientHeartbeatTimer) return;
  deviceClientHeartbeatTimer = setInterval(() => {
    heartbeatDeviceClient().catch(() => {});
  }, DEVICE_CLIENT_HEARTBEAT_MS);
  heartbeatDeviceClient().catch(() => {});
}

async function heartbeatDeviceClient() {
  if (deviceClientHeartbeatInFlight) return;
  deviceClientHeartbeatInFlight = true;
  try {
    const cfg = await getConfig();
    if (!cfg.gatewayUrl) return;
    const deviceId = await getStableDeviceId();
    const sessionId = await getStableSessionId();
    const owner = await getActiveBrowserAgentOwner();
    await callGateway(cfg, "/v1/device-clients/heartbeat", {
      body: {
        device_id: deviceId,
        surface_type: "browser_extension",
        session_id: sessionId,
        status: "online",
        local_tool_manifest: browserLocalToolManifest(),
        metadata: {
          source: "agee-extension",
          extension_id: chrome.runtime.id,
          active_owner: owner || null,
        },
      },
    });
  } finally {
    deviceClientHeartbeatInFlight = false;
  }
}

function browserLocalToolManifest() {
  return [
    { tool: "browser.tab.open", risk: "navigation", approval: "implicit_user_command" },
    { tool: "browser.task.claim", risk: "browser_local", approval: "none" },
    { tool: "page.snapshot", risk: "read_only", approval: "none" },
  ];
}

// ---- Developer auto-reload -----------------------------------------------
// Disabled by default. The developer bridge (`dev.html`) opts this in by
// writing ageeDevReloadEnabled + ageeDevReloadServer to storage. Once enabled,
// the already-loaded extension can notice source edits without keeping the
// bridge page open: active content scripts poll the dev server and this
// background worker also polls while awake / via alarms.

async function startDevReloadPolling() {
  if (!chrome?.storage?.local || !chrome?.alarms) return;
  const cfg = await devReloadConfig();
  if (!cfg.enabled) return;
  ensureDevReloadTimer();
}

function ensureDevReloadTimer() {
  if (devReloadPollTimer) return;
  devReloadPollTimer = setInterval(() => {
    pollDevReloadVersion("interval").catch(() => {});
  }, DEV_RELOAD_POLL_MS);
  chrome.alarms.create(DEV_RELOAD_ALARM, { periodInMinutes: 0.5 });
  pollDevReloadVersion("startup").catch(() => {});
}

async function stopDevReloadTimer() {
  if (devReloadPollTimer) {
    clearInterval(devReloadPollTimer);
    devReloadPollTimer = null;
  }
  try {
    await chrome.alarms.clear(DEV_RELOAD_ALARM);
  } catch {}
}

async function devReloadConfig() {
  const stored = await chrome.storage.local.get({
    ageeDevReloadEnabled: false,
    ageeDevReloadServer: DEV_RELOAD_DEFAULT_SERVER,
    ageeDevReloadVersion: null,
  });
  const server = String(stored.ageeDevReloadServer || DEV_RELOAD_DEFAULT_SERVER).replace(/\/+$/, "");
  return {
    enabled: Boolean(stored.ageeDevReloadEnabled),
    server,
    version: stored.ageeDevReloadVersion == null ? null : Number(stored.ageeDevReloadVersion),
  };
}

async function fetchDevReloadVersion(server) {
  const resp = await fetch(`${server}/__agee-dev/version?ts=${Date.now()}`, { cache: "no-store" });
  if (!resp.ok) throw new Error(`dev server returned ${resp.status}`);
  return resp.json();
}

async function pollDevReloadVersion(source) {
  if (devReloadPollInFlight) return;
  devReloadPollInFlight = true;
  try {
    const cfg = await devReloadConfig();
    if (!cfg.enabled) {
      await stopDevReloadTimer();
      return;
    }
    const info = await fetchDevReloadVersion(cfg.server);
    await maybeReloadForDevVersion(info, { server: cfg.server, previousVersion: cfg.version, source });
  } catch {
    // Dev server may be offline. Keep quiet; dev.html surfaces connection state.
  } finally {
    devReloadPollInFlight = false;
  }
}

async function maybeReloadForDevVersion(info, { server, previousVersion, source }) {
  const nextVersion = Number(info?.version || 0);
  if (!nextVersion) return;
  if (!previousVersion) {
    await chrome.storage.local.set({ ageeDevReloadVersion: nextVersion });
    return;
  }
  if (nextVersion === previousVersion) return;
  await chrome.storage.local.set({
    ageeDevReloadVersion: nextVersion,
    ageeDevReloadPendingLocalhostRefresh: true,
    ageeDevReloadLastReload: {
      previousVersion,
      nextVersion,
      source,
      server,
      at: new Date().toISOString(),
    },
  });
  chrome.runtime.reload();
}

async function reloadDevTabsAfterExtensionRestart() {
  if (!chrome?.storage?.local || !chrome?.tabs) return;
  const { ageeDevReloadPendingLocalhostRefresh } = await chrome.storage.local.get({
    ageeDevReloadPendingLocalhostRefresh: false,
  });
  if (!ageeDevReloadPendingLocalhostRefresh) return;
  await chrome.storage.local.set({ ageeDevReloadPendingLocalhostRefresh: false });
  await reloadLocalhostTabs();
}

async function reloadLocalhostTabs() {
  const tabs = await chrome.tabs.query({ url: ["http://localhost/*", "http://127.0.0.1/*"] });
  await Promise.all(tabs.filter((tab) => tab.id).map((tab) => chrome.tabs.reload(tab.id).catch(() => {})));
}

if (chrome?.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (!changes.ageeDevReloadEnabled && !changes.ageeDevReloadServer) return;
    const enabled = Boolean(changes.ageeDevReloadEnabled?.newValue);
    if (enabled) ensureDevReloadTimer();
    else if (changes.ageeDevReloadEnabled) stopDevReloadTimer().catch(() => {});
  });
}

// ---- Router activation loop (the gateway side of a branch) -----------------
// The sterile router on the gateway launches a disposable agent run and never
// speaks. We POST the intent to /v1/router/activate (202 + run id), then poll
// /v1/router/activations/:id for the durable router_ping the gateway emits on
// completion. This is the loop the integration fuses to the CDP task agent: the
// gateway tracks + pings the run, the browser does the actual page work.
//
// `parentRunId` threads fan-out lineage so two concurrent activations share a
// parent. The harness/echo output stays a proposal — we only render its summary.
async function routerActivate(cfg, { intent, screen, parentRunId, signal }) {
  const deviceId = await getStableDeviceId();
  const body = { intent, source: "agee-extension", device_id: deviceId };
  if (screen) body.screen = screen;
  if (parentRunId) body.parent_run_id = parentRunId;
  const activation = await callGateway(cfg, "/v1/router/activate", { signal, body });
  const runId = activation && (activation.run_id || activation.activation_id);
  if (!runId) throw new Error("router activate returned no run id");
  return { runId, statusUrl: activation.status_url || `/v1/router/activations/${runId}` };
}

// Poll a router activation until its durable router_ping appears (or timeout).
// Returns the ping event { type:"router_ping", ok, run_status, summary, ... }.
async function waitForRouterPing(cfg, runId, signal, { timeoutMs = 12000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    last = await callGateway(cfg, `/v1/router/activations/${runId}`, { method: "GET", signal });
    if (last && last.ping) return last.ping;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`router activation ${runId} did not ping in time`);
}

// ---- Runtime agent profile (the settings the agent reads/writes) ----------
// Cache key shared with the options page so a change applied here refreshes an
// open settings surface live (chrome.storage.onChanged).
const PROFILE_CACHE_KEY = "ageeProfileCache";

// Read the effective profile from the gateway (GET /v1/agent/profile).
async function getGatewayProfile(cfg, signal) {
  return callGateway(cfg, "/v1/agent/profile", { method: "GET", signal });
}

// Patch + persist a profile change through the gateway (PUT /v1/agent/profile)
// and cache the authoritative result so the settings surface stays in sync.
async function putGatewayProfile(cfg, patch, signal, source = "agee-extension", options = {}) {
  const deviceId = await getStableDeviceId();
  const payload = await callGateway(cfg, "/v1/agent/profile", {
    method: "PUT",
    signal,
    body: {
      profile: patch,
      source,
      scope: options.scope || "global",
      device_id: deviceId,
    },
  });
  await chrome.storage.local.set({ [PROFILE_CACHE_KEY]: payload });
  return payload;
}

// Read the queryable prompt-change history from the gateway.
async function getGatewayProfileHistory(cfg, signal) {
  return callGateway(cfg, "/v1/agent/profile/history?system_prompt_only=1&limit=50", { method: "GET", signal });
}

// Profile fields the gateway owns end to end. The local settings matcher is no
// longer allowed to write these; the gateway profile classifier is the single
// writer (it sanitizes and can reject with a spoken reply). Everything else in a
// patch stays local for now.
const SERVER_OWNED_PROFILE_FIELDS = new Set([
  "system_prompt",
  "language",
  "language_mode",
  "language_primary",
  "language_output",
  "language_auto_switch",
  "input_languages",
  "input_language_primary",
  "voice",
]);

function withoutServerOwnedProfileFields(patch) {
  if (!patch || typeof patch !== "object") return patch;
  const out = {};
  for (const [key, value] of Object.entries(patch)) {
    if (SERVER_OWNED_PROFILE_FIELDS.has(key)) continue;
    out[key] = value;
  }
  return out;
}

// "Change settings by talking to the agent": if the instruction is a settings
// request, turn it into a concrete profile patch and apply it through the
// gateway profile endpoints, then render a confirmation. Returns true when the
// instruction was handled as a settings change (so the caller skips the normal
// conversational turn); false otherwise.
async function maybeApplySettingsChange(tabId, instruction, cfg, signal, cueId) {
  // A quick pre-check avoids a profile GET for ordinary commands: only fetch
  // the current profile (needed for relative changes like "be terser") when the
  // text already looks like a settings intent given gateway defaults.
  let current = null;
  if (!parseSettingsIntent(instruction, current)) {
    return false;
  }
  try {
    const profilePayload = await getGatewayProfile(cfg, signal);
    current = profilePayload?.profile || null;
    await chrome.storage.local.set({ [PROFILE_CACHE_KEY]: profilePayload });
  } catch {
    // Fall back to defaults-based parsing if the GET fails; the PUT below will
    // surface any real gateway error loudly.
  }

  const intent = parseSettingsIntent(instruction, current);
  if (!intent) return false;

  // Demote the local writer for fields the gateway owns end to end. Language,
  // voice, and system-prompt requests already route to the gateway profile
  // classifier (looksLikeGatewayProfileControlIntent) earlier in the chain, and
  // the gateway is the single writer for them: it sanitizes, rejects, and replies.
  // Strip those fields here so this local path never double-writes them. The
  // fields with no gateway equivalent yet — temperature, voice_max_chars
  // (terser/verbose), model — stay local for now (follow-up: move them too).
  const patch = withoutServerOwnedProfileFields(intent.patch);
  if (!patch || Object.keys(patch).length === 0) {
    // Everything in this intent is gateway-owned; let the gateway path handle it.
    return false;
  }

  await saveTaskState(cueId, { status: "running", instruction, step: 0, lastResult: "applying settings change", tabId });
  send(tabId, { cmd: "progress", cueId, text: "updating settings…" });
  throwIfAborted(signal);

  await putGatewayProfile(cfg, patch, signal, "agee-extension", { scope: intent.scope || "global" });
  const summary = `Settings updated — ${intent.summary}. It takes effect on the next turn.`;
  send(tabId, { cmd: "done", cueId, summary });
  await saveTaskState(cueId, { status: "done", instruction, step: 1, lastResult: summary.slice(0, 400), tabId });
  return true;
}

// "What prompts have I set?" / "how many system prompts?" → answer from the
// gateway's prompt-change history instead of running a model turn.
async function maybeAnswerProfileQuery(tabId, instruction, cfg, signal, cueId) {
  if (!parseProfileQueryIntent(instruction)) {
    return false;
  }
  send(tabId, { cmd: "progress", cueId, text: "checking prompt history…" });
  throwIfAborted(signal);
  let data;
  try {
    data = await getGatewayProfileHistory(cfg, signal);
  } catch (error) {
    send(tabId, { cmd: "error", cueId, text: `Could not read prompt history: ${String(error?.message || error)}` });
    return true;
  }
  const count = Number(data?.system_prompt_changes || 0);
  const entries = Array.isArray(data?.history) ? data.history : [];
  const lines = [
    count === 0
      ? "You haven't set any system prompts yet."
      : `You've set ${count} system prompt${count === 1 ? "" : "s"}.`,
  ];
  if (data?.current_system_prompt) {
    lines.push(`Current: "${truncate(data.current_system_prompt, 160)}"`);
  }
  entries.slice(0, 5).forEach((entry, i) => {
    const when = String(entry.ts || "").replace("T", " ").slice(0, 16);
    lines.push(`${i + 1}. [${when}] ${truncate(entry.system_prompt || "", 120)}`);
  });
  const summary = lines.join("\n");
  send(tabId, { cmd: "done", cueId, summary, speak: lines[0] });
  await saveTaskState(cueId, { status: "done", instruction, step: 1, lastResult: summary.slice(0, 400), tabId });
  return true;
}

// Voice/language/profile controls belong in the canonical gateway turn router,
// even when typed. That path stores a profile_control turn and applies the
// versioned profile update/query. Keep the direct PUT fallback below for older
// extension-only tweaks the gateway parser does not yet understand.
async function maybeRouteGatewayProfileControl(tabId, instruction, cfg, signal, cueId) {
  if (!looksLikeGatewayProfileControlIntent(instruction)) {
    return false;
  }
  const data = await runViaGateway(tabId, instruction, cfg, signal, cueId);
  if (data?.classification === "profile_control") {
    try {
      const profilePayload = await getGatewayProfile(cfg, signal);
      await chrome.storage.local.set({ [PROFILE_CACHE_KEY]: profilePayload });
    } catch {
      // The profile-control turn already completed; cache refresh is best-effort.
    }
  }
  return true;
}

// Page tweaks are handled by tweaks.js in the content world. The trigger used to
// be a local keyword regex (looksLikePageTweak) that fired before any model turn.
// That baked-in detector is removed: the gateway model now decides when a page
// change is warranted (propose_page_tweak) and returns a page_tweak action, which
// runViaGateway applies via tweak:applyRecord. The tweak:apply/tweak:applyRecord
// message API in tweaks.js stays intact for the smoke and options paths.

function truncate(text, max) {
  const t = String(text || "");
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// One session id per cue. Each cue is its own conversation lane on the gateway —
// this is what lets the user keep cueing ("do X", "now Y", "also Z") and have
// each routed independently underneath instead of forced into one thread.
function sessionIdForCue(cueId) {
  return `agee_${String(cueId || "").replace(/[^a-zA-Z0-9_]/g, "") || Date.now().toString(36)}`;
}

// One stable session id for the whole conversation, persisted in
// chrome.storage.local. Conversational turns share this id so the gateway
// accumulates them under one session and the overlay can reload chat history
// across reopens. Per-cue/branch distinction is preserved via branch_id (the
// cueId), not by minting a throwaway session per message. Not a secret.
async function getStableSessionId() {
  const { ageeSessionId } = await chrome.storage.local.get("ageeSessionId");
  if (ageeSessionId) return ageeSessionId;
  const sessionId = `agee_${crypto.randomUUID()}`;
  await chrome.storage.local.set({ ageeSessionId: sessionId });
  return sessionId;
}

async function getStableDeviceId() {
  const { ageeDeviceId } = await chrome.storage.local.get("ageeDeviceId");
  if (ageeDeviceId) return ageeDeviceId;
  const deviceId = `browser_${crypto.randomUUID().replace(/-/g, "")}`;
  await chrome.storage.local.set({ ageeDeviceId: deviceId });
  return deviceId;
}

async function getActiveBrowserAgentOwner() {
  const stored = await chrome.storage.local.get(ACTIVE_BROWSER_AGENT_OWNER_KEY);
  return stored[ACTIVE_BROWSER_AGENT_OWNER_KEY] || null;
}

async function setActiveBrowserAgentOwner(tabId, reason = "browser agent owner changed", patch = {}) {
  if (tabId == null || !chrome?.storage?.local) return null;
  let tab = null;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {}
  const sessionId = await getStableSessionId();
  const owner = {
    browser_session_id: sessionId,
    tab_id: tabId,
    window_id: tab?.windowId ?? patch.window_id ?? null,
    page_url: tab?.url || patch.page_url || "",
    page_title: tab?.title || patch.page_title || "",
    cue_id: patch.cue_id || patch.cueId || null,
    voice_session_id: patch.voice_session_id || patch.voiceSessionId || null,
    agent_run_id: patch.agent_run_id || patch.agentRunId || null,
    status: patch.status || "active",
    last_result: patch.last_result || patch.lastResult || "",
    reason,
    updated_at: new Date().toISOString(),
  };
  await chrome.storage.local.set({ [ACTIVE_BROWSER_AGENT_OWNER_KEY]: owner });
  await notifyBrowserAgentOwner(owner);
  return owner;
}

async function updateActiveBrowserAgentOwner(patch = {}) {
  const owner = await getActiveBrowserAgentOwner();
  if (!owner) return null;
  const next = {
    ...owner,
    ...patch,
    updated_at: new Date().toISOString(),
  };
  await chrome.storage.local.set({ [ACTIVE_BROWSER_AGENT_OWNER_KEY]: next });
  await notifyBrowserAgentOwner(next);
  return next;
}

async function updateActiveBrowserAgentOwnerFromTask(cueId, patch) {
  if (!patch || patch.tabId == null) return;
  const owner = await getActiveBrowserAgentOwner();
  if (!owner || owner.tab_id !== patch.tabId) return;
  if (owner.cue_id && cueId && owner.cue_id !== cueId) return;
  await updateActiveBrowserAgentOwner({
    cue_id: cueId || owner.cue_id || null,
    status: patch.status || owner.status || "active",
    last_result: patch.lastResult || owner.last_result || "",
  });
}

async function clearActiveBrowserAgentOwner(tabId, reason = "browser agent owner cleared") {
  const owner = await getActiveBrowserAgentOwner();
  if (!owner || (tabId != null && owner.tab_id !== tabId)) return;
  const cleared = {
    ...owner,
    status: "cleared",
    reason,
    updated_at: new Date().toISOString(),
  };
  await chrome.storage.local.set({ [ACTIVE_BROWSER_AGENT_OWNER_KEY]: cleared });
  await notifyBrowserAgentOwner(cleared);
}

async function notifyBrowserAgentOwner(owner) {
  if (!chrome?.tabs) return;
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] }).catch(() => []);
  await Promise.allSettled(tabs.filter((tab) => tab.id != null).map((tab) => (
    chrome.tabs.sendMessage(tab.id, {
      cmd: "browserAgentOwnerChanged",
      owner,
      isOwner: owner?.tab_id === tab.id && owner?.status !== "cleared",
    }).catch(() => {})
  )));
}

// Read the persisted conversation's ordered turns from the gateway so the
// overlay can render prior turns when it reopens. Returns [] when nothing is
// configured/stored yet (a fresh conversation simply has no history).
async function loadHistory(cfg) {
  if (!cfg.gatewayUrl) return [];
  const sessionId = await getStableSessionId();
  const data = await callGateway(cfg, `/v1/sessions/${encodeURIComponent(sessionId)}/turns`, {
    method: "GET",
  });
  return Array.isArray(data?.turns) ? data.turns : [];
}

async function createVoiceSessionTicket(cfg, signal) {
  const sessionId = await getStableSessionId();
  const deviceId = await getStableDeviceId();
  const data = await callGateway(cfg, "/v1/voice/session-ticket", {
    signal,
    body: {
      source: "agee-extension",
      device_id: deviceId,
      session_id: sessionId,
      conversation_id: sessionId,
    },
  });
  return {
    ...data,
    session_id: sessionId,
    conversation_id: sessionId,
    device_id: deviceId,
  };
}

// Conversational turn through the user's gateway (/v1/voice/turns).
// The gateway classifies chat vs. home-machine agent runs and replies with
// display text; we render it. Page-DOM actions are a later wave.
async function runViaGateway(tabId, instruction, cfg, signal, cueId) {
  await saveTaskState(cueId, { status: "running", instruction, step: 0, lastResult: "sending to gateway", tabId });
  send(tabId, { cmd: "progress", cueId, text: "thinking…" });
  throwIfAborted(signal);

  let screen;
  try {
    const snap = await ask(tabId, { cmd: "snapshot" });
    screen = snapToScreen(snap);
  } catch {
    screen = undefined; // restricted page; send without screen context
  }

  throwIfAborted(signal);
  // Share one stable session+conversation id across turns so the gateway
  // accumulates them (and the overlay can reload them). The cueId becomes the
  // branch_id, preserving per-cue distinction without fragmenting the session.
  const sessionId = await getStableSessionId();
  const deviceId = await getStableDeviceId();
  const data = await callGateway(cfg, "/v1/voice/turns", {
    signal,
    body: {
      source: "agee-extension",
      device_id: deviceId,
      session_id: sessionId,
      conversation_id: sessionId,
      branch_id: cueId,
      all_branches_context: true,
      transcript: instruction,
      client: {
        platform: "browser",
        source: "agee-extension",
        device_id: deviceId,
        input: "text",
      },
      screen,
    },
  });

  // The gateway model can now decide a page change is warranted and return it as
  // a structured action on the turn result instead of relying on a baked-in
  // keyword detector. Handle known action types here; ignore unknown ones so a
  // future gateway envelope never breaks this client.
  const tweakActionHandled = await maybeApplyTurnActions(tabId, data, signal, cueId);
  if (tweakActionHandled) {
    return data;
  }

  const reply = String(data.display || data.text || data.speak || "").trim();
  // The gateway returns a separate TTS-safe `speak` string (short, markdown-
  // stripped). Forward it so the overlay can speak the reply aloud; the gateway
  // decides when to stay silent by sending an empty speak (e.g. control turns).
  const speak = String(data.speak || "").trim();
  const runs = Array.isArray(data.agent_runs) ? data.agent_runs : [];
  const summary = reply || (runs.length ? `Started ${runs.length} agent run(s).` : "Done.");
  send(tabId, { cmd: "done", cueId, summary, speak });
  await saveTaskState(cueId, {
    status: "done",
    instruction,
    step: 1,
    tabId,
    lastResult: `[${data.classification || "chat"}] ${summary.slice(0, 400)}`,
  });
  return data;
}

// Collect structured actions off a gateway turn result. The gateway may attach a
// single `action` or an `actions` array; we accept either shape.
function turnActions(data) {
  const out = [];
  if (data && typeof data.action === "object" && data.action) out.push(data.action);
  if (data && Array.isArray(data.actions)) out.push(...data.actions.filter((a) => a && typeof a === "object"));
  return out;
}

// Execute known gateway-proposed actions from a turn. Only `page_tweak` is
// handled today: forward the pre-planned record to the content world's tweaks
// module as tweak:applyRecord, which validates and compiles it locally. Unknown
// action types are ignored silently. Returns true when a page_tweak action was
// applied and a done summary was already sent.
async function maybeApplyTurnActions(tabId, data, signal, cueId) {
  const actions = turnActions(data);
  const tweakAction = actions.find((a) => a.type === "page_tweak" && a.record && typeof a.record === "object");
  if (!tweakAction) return false;

  send(tabId, { cmd: "progress", cueId, text: "changing this page…" });
  await saveTaskState(cueId, { status: "running", instruction: "", step: 0, lastResult: "applying page tweak", tabId });
  throwIfAborted(signal);

  let result;
  try {
    result = await ask(tabId, { cmd: "tweak:applyRecord", record: tweakAction.record });
  } catch (error) {
    send(tabId, { cmd: "error", cueId, text: `Page tweak failed: ${String(error?.message || error)}` });
    await saveTaskState(cueId, { status: "error", instruction: "", step: 1, lastResult: String(error?.message || error), tabId });
    return true;
  }

  if (!result?.ok) {
    const message = result?.error || "That page change was not a bounded tweak I can apply.";
    send(tabId, { cmd: "done", cueId, summary: message, speak: message });
    await saveTaskState(cueId, { status: "done", instruction: "", step: 1, lastResult: message, tabId });
    return true;
  }

  const tweak = result.tweak || {};
  const summary = `Changed this page — ${tweak.name || "page tweak"} is saved for ${result.origin || "this site"}.`;
  // pageTweak flag tells the overlay to offer the "Changes on this page" review
  // affordance next to this done cue.
  send(tabId, { cmd: "done", cueId, summary, speak: summary, pageTweak: true });
  await saveTaskState(cueId, {
    status: "done",
    instruction: "",
    step: 1,
    tabId,
    lastResult: summary.slice(0, 400),
    tweakId: tweak.id,
    tweakKind: tweak.kind,
  });
  return true;
}

function send(tabId, msg) {
  chrome.tabs.sendMessage(tabId, msg).catch(() => {});
}

function ask(tabId, msg) {
  return chrome.tabs.sendMessage(tabId, msg);
}

async function ensureContent(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { cmd: "ping" });
  } catch {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ["overlay.css"] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  }
}

async function ensureContentOnOpenTabs() {
  if (!chrome?.tabs || !chrome?.scripting) return;
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  await Promise.allSettled(tabs.filter((tab) => tab.id != null).map((tab) => ensureContent(tab.id)));
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new Error("Task cancelled.");
}

function bytesToBase64(buffer) {
  const bytes = new Uint8Array(buffer || 0);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToBuffer(value) {
  const binary = atob(String(value || ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function voiceSessionId() {
  return `v_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function hasOffscreenVoiceDocument() {
  if (!chrome?.offscreen) return false;
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_VOICE_DOCUMENT);
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [offscreenUrl],
    });
    return contexts.length > 0;
  }
  const clients = await self.clients.matchAll();
  return clients.some((client) => client.url === offscreenUrl);
}

async function ensureOffscreenVoiceDocument() {
  if (!chrome?.offscreen?.createDocument) {
    throw new Error("Extension microphone capture is not supported in this Chrome build.");
  }
  if (await hasOffscreenVoiceDocument()) return;
  if (!creatingOffscreenVoiceDocument) {
    creatingOffscreenVoiceDocument = chrome.offscreen.createDocument({
      url: OFFSCREEN_VOICE_DOCUMENT,
      reasons: ["USER_MEDIA"],
      justification: "A.G. captures microphone audio from the extension origin and streams it to the configured gateway.",
    }).finally(() => {
      creatingOffscreenVoiceDocument = null;
    });
  }
  await creatingOffscreenVoiceDocument;
}

function extensionMicApprovalMessage(error) {
  const detail = String(error?.message || error || "").trim();
  const suffix = detail ? ` (${detail})` : "";
  return `A.G. could not open the extension microphone. Open the A.G. toolbar icon > Options, click "Grant microphone", and allow microphone access for the extension. If Chrome has blocked it, open chrome://extensions/?id=${chrome.runtime.id}, choose Details or Site settings, set Microphone to Allow, then start voice again.${suffix}`;
}

async function startOffscreenVoiceCapture(id) {
  await ensureOffscreenVoiceDocument();
  const response = await chrome.runtime.sendMessage({
    cmd: "offscreenVoiceCaptureStart",
    voiceSessionId: id,
  });
  if (!response?.ok) throw new Error(response?.error || "extension microphone capture did not start");
}

async function stopOffscreenVoiceCapture(id) {
  if (!chrome?.offscreen) return;
  if (!(await hasOffscreenVoiceDocument())) return;
  await chrome.runtime
    .sendMessage({
      cmd: "offscreenVoiceCaptureStop",
      voiceSessionId: id || null,
    })
    .catch(() => {});
}

function handleOffscreenVoiceError(id, error) {
  const session = voiceSessions.get(id);
  if (!session) return;
  chrome.runtime.openOptionsPage?.().catch(() => {});
  deliverVoiceSessionEvent(session, {
    event: {
      type: "error",
      code: "microphone_capture_failed",
      recoverable: false,
      message: extensionMicApprovalMessage(error),
    },
  });
  closeVoiceSession(id, "microphone capture failed");
}

function claimActiveAgentTab(tabId, reason = "another page became active", patch = {}) {
  if (tabId == null) return;
  const revokedTabs = new Map();

  for (const [cueId, task] of [...tasks]) {
    if (task.tabId === tabId) continue;
    try {
      task.controller.abort();
    } catch {}
    tasks.delete(cueId);
    if (!revokedTabs.has(task.tabId)) revokedTabs.set(task.tabId, []);
    revokedTabs.get(task.tabId).push(cueId);
  }

  for (const oldTabId of revokeOtherTabVoiceSessions(tabId, reason)) {
    if (!revokedTabs.has(oldTabId)) revokedTabs.set(oldTabId, []);
  }

  for (const [oldTabId, cueIds] of revokedTabs) {
    send(oldTabId, { cmd: "agentRevoked", cueIds, reason });
  }
  activeAgentTabId = tabId;
  setActiveBrowserAgentOwner(tabId, reason, patch).catch(() => {});
}

function revokeOtherTabVoiceSessions(tabId, reason) {
  const tabIds = new Set();
  if (activeAgentTabId != null && activeAgentTabId !== tabId) tabIds.add(activeAgentTabId);
  for (const [id, session] of [...voiceSessions]) {
    if (session.tabId === tabId) continue;
    tabIds.add(session.tabId);
    closeVoiceSession(id, reason, { revoked: true });
  }
  return tabIds;
}

async function startVoiceSessionProxy(tabId, { cueId, turnId, assistantOverlap, capture, autoCommit } = {}) {
  const cfg = await getConfig();
  const ticket = await createVoiceSessionTicket(cfg);
  if (!ticket?.ws_url) throw new Error("gateway did not return a voice session WebSocket URL");

  const id = voiceSessionId();
  return new Promise((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(ticket.ws_url);
    const session = {
      id,
      tabId,
      ws,
      turnId,
      opened: false,
      attached: false,
      pendingEvents: [],
      capture: capture || "content-script",
      captureStarted: false,
      ready: false,
      pendingAudio: [],
      pendingAudioBytes: 0,
      autoCommitEnabled: autoCommit !== false && VOICE_AUTO_COMMIT_ENABLED,
      audioStartedAt: 0,
      lastSpeechAt: 0,
      speechMs: 0,
      recordingMs: 0,
      committed: false,
      autoCommitTimer: null,
      maxCommitTimer: null,
    };
    voiceSessions.set(id, session);
    ws.binaryType = "arraybuffer";

    // Open the microphone NOW, in parallel with the ticket/WS/session_start
    // handshake, so nothing the user says while the session spins up is lost.
    // Frames land in session.pendingAudio until session_ready flushes them.
    if (session.capture === "extension-offscreen") {
      session.captureStarted = true;
      startOffscreenVoiceCapture(id).catch((error) => handleOffscreenVoiceError(id, error));
    }

    const failBeforeOpen = (message) => {
      voiceSessions.delete(id);
      try {
        ws.close();
      } catch {}
      if (!settled) {
        settled = true;
        reject(new Error(message));
      }
    };

    ws.onopen = () => {
      if (!voiceSessionSocketOpen(session)) {
        failBeforeOpen(session.revoked ? "Live voice session was revoked." : "Live voice connection closed.");
        return;
      }
      const started = sendVoiceSessionJson(session, {
        type: "session_start",
        source: "agee-extension",
        device_id: ticket.device_id || "",
        session_id: ticket.session_id,
        conversation_id: ticket.conversation_id || ticket.session_id,
        branch_id: cueId,
        turn_id: turnId,
        all_branches_context: true,
        client: {
          platform: "browser",
          source: "agee-extension",
          device_id: ticket.device_id || "",
          input: "voice",
        },
        playback_policy: {
          assistant_overlap: assistantOverlap === true,
        },
        format: {
          encoding: "pcm16",
          sample_rate: 16000,
          channels: 1,
        },
      });
      if (!started) {
        failBeforeOpen("Live voice connection failed.");
        return;
      }
      session.opened = true;
      settled = true;
      resolve({
        voiceSessionId: id,
        session_id: ticket.session_id,
        conversation_id: ticket.conversation_id || ticket.session_id,
      });
    };

    ws.onmessage = (event) => forwardVoiceSessionEvent(session, event).catch(() => {});
    ws.onerror = () => {
      if (!session.opened) {
        failBeforeOpen("Live voice connection failed.");
        return;
      }
      deliverVoiceSessionEvent(session, {
        event: { type: "error", message: "Live voice connection failed." },
      });
    };
    ws.onclose = () => {
      if (!session.opened) {
        if (session.revoked) {
          if (!settled) {
            settled = true;
            resolve({ voiceSessionId: id, revoked: true });
          }
          session.closed = true;
          deliverVoiceSessionEvent(session, {
            event: { type: "revoked", reason: session.closedReason || "revoked" },
          });
          if (session.attached) voiceSessions.delete(id);
          else setTimeout(() => voiceSessions.delete(id), 5000);
          return;
        }
        failBeforeOpen("Live voice connection closed.");
        return;
      }
      session.closed = true;
      deliverVoiceSessionEvent(session, {
        event: session.revoked
          ? { type: "revoked", reason: session.closedReason || "revoked" }
          : { type: "connection_closed" },
      });
      if (session.attached) voiceSessions.delete(id);
      else setTimeout(() => voiceSessions.delete(id), 5000);
    };
  });
}

function voiceSessionSocketOpen(session) {
  return !!session
    && !session.closed
    && voiceSessions.get(session.id) === session
    && session.ws?.readyState === WebSocket.OPEN;
}

function markVoiceSessionSendFailed(session, reason = "send failed") {
  if (!session || session.closed) return;
  session.closed = true;
  session.closedReason = reason;
  session.commitWhenReady = null;
  session.pendingAudio = [];
  session.pendingAudioBytes = 0;
  voiceSessions.delete(session.id);
  clearVoiceAutoCommit(session);
  stopOffscreenVoiceCapture(session.id).catch(() => {});
  try {
    session.ws?.close(1000, reason);
  } catch {}
}

function sendVoiceSessionJson(session, message) {
  if (!voiceSessionSocketOpen(session)) return false;
  try {
    session.ws.send(JSON.stringify(message || {}));
    return true;
  } catch {
    markVoiceSessionSendFailed(session);
    return false;
  }
}

function sendVoiceSessionBinary(session, buffer) {
  if (!voiceSessionSocketOpen(session)) return false;
  try {
    session.ws.send(buffer);
    return true;
  } catch {
    markVoiceSessionSendFailed(session);
    return false;
  }
}

function deliverVoiceSessionEvent(session, payload) {
  if (!session) return;
  const message = { cmd: "voiceSessionEvent", voiceSessionId: session.id, ...payload };
  if (!session.attached) {
    session.pendingEvents = session.pendingEvents || [];
    session.pendingEvents.push(message);
    if (session.pendingEvents.length > MAX_PENDING_VOICE_EVENTS) session.pendingEvents.shift();
    return;
  }
  send(session.tabId, message);
}

function attachVoiceSession(id, tabId) {
  const session = voiceSessions.get(id);
  if (!session || session.tabId !== tabId) return { ok: false, error: "voice session not found" };
  session.attached = true;
  const pendingEvents = session.pendingEvents || [];
  session.pendingEvents = [];
  for (const event of pendingEvents) send(session.tabId, event);
  if (session.closed) voiceSessions.delete(id);
  return { ok: true, flushed: pendingEvents.length };
}

async function forwardVoiceSessionEvent(session, event) {
  if (!voiceSessions.has(session.id)) return;
  const data = event.data;
  if (data instanceof ArrayBuffer) {
    deliverVoiceSessionEvent(session, { audio: bytesToBase64(data) });
    return;
  }
  if (data instanceof Blob) {
    const buffer = await data.arrayBuffer();
    deliverVoiceSessionEvent(session, { audio: bytesToBase64(buffer) });
    return;
  }
  let parsed = null;
  try {
    parsed = JSON.parse(String(data || "{}"));
  } catch {}
  if (parsed?.type === "session_ready") {
    session.ready = true;
    if (session.capture === "extension-offscreen" && !session.captureStarted) {
      session.captureStarted = true;
      startOffscreenVoiceCapture(session.id).catch((error) => handleOffscreenVoiceError(session.id, error));
    }
    flushPendingVoiceAudio(session);
    if (session.commitWhenReady) {
      const commit = session.commitWhenReady;
      session.commitWhenReady = null;
      sendVoiceSessionJson(session, commit);
    }
  }
  deliverVoiceSessionEvent(session, {
    event: parsed || { type: "raw", data: String(data || "") },
  });
}

function bufferPendingVoiceAudio(session, buffer) {
  session.pendingAudio.push(buffer);
  session.pendingAudioBytes += buffer.byteLength;
  while (session.pendingAudioBytes > MAX_PENDING_VOICE_AUDIO_BYTES && session.pendingAudio.length > 0) {
    const dropped = session.pendingAudio.shift();
    session.pendingAudioBytes -= dropped.byteLength;
  }
}

function flushPendingVoiceAudio(session) {
  const pending = session.pendingAudio;
  session.pendingAudio = [];
  session.pendingAudioBytes = 0;
  for (const buffer of pending) {
    if (!sendVoiceSessionBinary(session, buffer)) return false;
  }
  return true;
}

function sendVoiceSessionAudio(id, audio) {
  const session = voiceSessions.get(id);
  if (!session || session.closed || session.committed) return { ok: false, error: "voice session is not open" };
  const buffer = base64ToBuffer(audio);
  noteVoiceSessionAudio(session, buffer);
  if (!session.ready || session.ws?.readyState !== WebSocket.OPEN) {
    // Capture is running before the gateway turn is ready; hold the frames so
    // the utterance start survives the handshake.
    bufferPendingVoiceAudio(session, buffer);
    return { ok: true, buffered: true };
  }
  if (!flushPendingVoiceAudio(session)) return { ok: false, error: "voice session is not open" };
  if (!sendVoiceSessionBinary(session, buffer)) return { ok: false, error: "voice session is not open" };
  return { ok: true };
}

async function sendVoiceSessionControl(id, message) {
  const session = voiceSessions.get(id);
  if (!voiceSessionSocketOpen(session)) return { ok: false, error: "voice session is not open" };
  if (message?.type === "commit_turn") {
    session.committed = true;
    clearVoiceAutoCommit(session);
    await stopOffscreenVoiceCapture(id);
    if (!commitVoiceSession(session, message)) return { ok: false, error: "voice session is not open" };
    return { ok: true };
  }
  if (message?.type === "cancel_turn") {
    session.committed = true;
    session.commitWhenReady = null;
    session.pendingAudio = [];
    session.pendingAudioBytes = 0;
    clearVoiceAutoCommit(session);
    await stopOffscreenVoiceCapture(id);
  }
  if (!sendVoiceSessionJson(session, message || {})) return { ok: false, error: "voice session is not open" };
  return { ok: true };
}

// Commit path shared by the client-driven and auto-commit routes. Buffered
// audio always goes out before the commit so the gateway never commits a
// truncated turn. If the gateway turn is not ready yet, the commit is deferred
// to session_ready (mirrors the Android controller) with a bounded wait.
function commitVoiceSession(session, message) {
  if (!session.ready) {
    session.commitWhenReady = message;
    setTimeout(() => {
      if (!session.commitWhenReady || session.closed) return;
      session.commitWhenReady = null;
      deliverVoiceSessionEvent(session, {
        event: { type: "error", message: "Voice gateway did not become ready in time." },
      });
      closeVoiceSession(session.id, "commit timed out before session_ready");
    }, 8000);
    return true;
  }
  if (!flushPendingVoiceAudio(session)) return false;
  return sendVoiceSessionJson(session, message);
}

function closeVoiceSession(id, reason = "closed", { revoked = false } = {}) {
  const session = voiceSessions.get(id);
  if (!session) return;
  session.closedReason = reason;
  session.revoked = revoked === true;
  session.commitWhenReady = null;
  session.pendingAudio = [];
  session.pendingAudioBytes = 0;
  voiceSessions.delete(id);
  clearVoiceAutoCommit(session);
  stopOffscreenVoiceCapture(id).catch(() => {});
  try {
    session.ws.close(1000, reason);
  } catch {}
}

function noteVoiceSessionAudio(session, buffer) {
  if (!session?.autoCommitEnabled || session.committed || !buffer?.byteLength) return;
  const now = Date.now();
  const durationMs = Math.max(1, Math.round((buffer.byteLength / 2 / 16000) * 1000));
  session.audioStartedAt ||= now;
  session.recordingMs = (session.recordingMs || 0) + durationMs;
  const activity = pcm16VoiceActivity(buffer);
  if (activity.speech) {
    session.lastSpeechAt = now;
    session.speechMs = (session.speechMs || 0) + durationMs;
  }
  if (
    !activity.speech &&
    session.lastSpeechAt &&
    (session.speechMs || 0) >= VOICE_AUTO_COMMIT_MIN_SPEECH_MS &&
    now - session.lastSpeechAt >= VOICE_AUTO_COMMIT_SILENCE_MS
  ) {
    autoCommitVoiceSession(session.id, "silence audio").catch(() => {});
    return;
  }
  if (session.lastSpeechAt) {
    scheduleVoiceAutoCommit(session, VOICE_AUTO_COMMIT_SILENCE_MS);
  }
  if (session.lastSpeechAt && !session.maxCommitTimer) {
    session.maxCommitTimer = setTimeout(() => {
      autoCommitVoiceSession(session.id, "max recording reached").catch(() => {});
    }, VOICE_AUTO_COMMIT_MAX_RECORDING_MS);
  }
}

function pcm16VoiceActivity(buffer) {
  const view = new DataView(buffer);
  const samples = Math.floor(buffer.byteLength / 2);
  if (!samples) return { speech: false, rms: 0, peak: 0 };
  let sumSquares = 0;
  let peak = 0;
  for (let offset = 0; offset + 1 < buffer.byteLength; offset += 2) {
    const sample = view.getInt16(offset, true) / 32768;
    const abs = Math.abs(sample);
    sumSquares += sample * sample;
    if (abs > peak) peak = abs;
  }
  const rms = Math.sqrt(sumSquares / samples);
  return {
    speech: rms >= VOICE_ACTIVITY_RMS_THRESHOLD || peak >= VOICE_ACTIVITY_PEAK_THRESHOLD,
    rms,
    peak,
  };
}

function scheduleVoiceAutoCommit(session, delayMs) {
  if (!session || session.committed) return;
  if (session.autoCommitTimer) clearTimeout(session.autoCommitTimer);
  session.autoCommitTimer = setTimeout(() => {
    autoCommitVoiceSession(session.id, "silence after speech").catch(() => {});
  }, Math.max(120, delayMs));
}

async function autoCommitVoiceSession(id, reason) {
  const session = voiceSessions.get(id);
  if (!session || session.committed || !voiceSessionSocketOpen(session)) return;
  if (!session.lastSpeechAt || (session.speechMs || 0) < VOICE_AUTO_COMMIT_MIN_SPEECH_MS) {
    scheduleVoiceAutoCommit(session, VOICE_AUTO_COMMIT_SILENCE_MS);
    return;
  }
  const silenceMs = Date.now() - session.lastSpeechAt;
  if (reason !== "max recording reached" && silenceMs < VOICE_AUTO_COMMIT_SILENCE_MS) {
    scheduleVoiceAutoCommit(session, VOICE_AUTO_COMMIT_SILENCE_MS - silenceMs);
    return;
  }
  session.committed = true;
  clearVoiceAutoCommit(session);
  await stopOffscreenVoiceCapture(id);
  commitVoiceSession(session, {
    type: "commit_turn",
    turn_id: session.turnId,
    reason: `browser_auto_commit:${reason}`,
  });
}

function clearVoiceAutoCommit(session) {
  if (!session) return;
  if (session.autoCommitTimer) clearTimeout(session.autoCommitTimer);
  if (session.maxCommitTimer) clearTimeout(session.maxCommitTimer);
  session.autoCommitTimer = null;
  session.maxCommitTimer = null;
}

function closeTabVoiceSessions(tabId) {
  for (const session of voiceSessions.values()) {
    if (session.tabId === tabId) closeVoiceSession(session.id, "tab closed");
  }
}

// Persist per-cue state (keyed by cueId) so concurrent cues don't clobber each
// other. Falls back to a synthetic key when no id is given.
async function saveTaskState(id, patch) {
  const key = `ageeCue:${id || "default"}`;
  const previous = (await chrome.storage.local.get(key))[key] || {};
  await chrome.storage.local.set({
    [key]: {
      ...previous,
      ...patch,
      cueId: id,
      updatedAt: new Date().toISOString(),
    },
  });
  await updateActiveBrowserAgentOwnerFromTask(id, patch).catch(() => {});
}

async function captureScreenshot(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 55 });
    return dataUrl.split(",")[1]; // strip data: prefix
  } catch {
    return null;
  }
}

function elementsText(snap) {
  const lines = (snap.elements || []).slice(0, MAX_ELEMENTS).map((e) => `[${e.i}] <${e.tag}${e.type ? " " + e.type : ""}> ${e.label}`);
  const pageText = truncate(String(snap.pageText || snap.page_text || "").trim(), 2800);
  return [
    `URL: ${snap.url}`,
    `TITLE: ${snap.title}`,
    pageText ? `VISIBLE PAGE TEXT:\n${pageText}` : "",
    `INTERACTABLE ELEMENTS:\n${lines.join("\n") || "(none found)"}`,
  ].filter(Boolean).join("\n");
}

async function snapshotBlocks(tabId, signal) {
  throwIfAborted(signal);
  const snap = await ask(tabId, { cmd: "snapshot" });
  const blocks = [{ type: "text", text: elementsText(snap) }];
  throwIfAborted(signal);
  const shot = await captureScreenshot(tabId);
  if (shot) blocks.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: shot } });
  return blocks;
}

function waitForLoad(tabId) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 8000);
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(resolve, 400);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function confirmNavigation(tabId, url) {
  const tab = await chrome.tabs.get(tabId);
  const from = tab.url ? new URL(tab.url).origin : "";
  const to = url.origin;
  if (from === to) return true;
  try {
    const response = await ask(tabId, {
      cmd: "confirm",
      text: `Allow A.G. to navigate from ${from || "this page"} to ${to}?`,
    });
    return response?.ok === true;
  } catch {
    return false;
  }
}

async function executeAction(tabId, input, signal) {
  throwIfAborted(signal);
  if (input.action === "navigate" && input.url) {
    let url;
    try {
      url = new URL(input.url);
    } catch {
      return `blocked invalid URL: ${input.url}`;
    }
    if (!ALLOWED_NAVIGATION_PROTOCOLS.has(url.protocol)) {
      return `blocked navigation to ${url.protocol}`;
    }
    if (!(await confirmNavigation(tabId, url))) {
      return `user cancelled navigation to ${url.origin}`;
    }
    throwIfAborted(signal);
    await chrome.tabs.update(tabId, { url: url.href });
    await waitForLoad(tabId);
    return "navigated";
  }
  if (input.action === "wait") {
    await new Promise((r) => setTimeout(r, 1000));
    return "waited";
  }
  let result;
  try {
    result = await ask(tabId, { cmd: "act", ...input });
  } catch {
    // Page likely navigated and tore down the content script.
    await waitForLoad(tabId);
    return "action sent; page navigated";
  }
  // Settle: clicks/typing may trigger navigation or async updates.
  await new Promise((r) => setTimeout(r, 700));
  return (result && result.result) || "done";
}

// Map a page snapshot into the gateway's screen-context shape so the same
// home-machine context format works for browser and Android surfaces.
function snapToScreen(snap) {
  const nodes = (snap.elements || []).slice(0, MAX_ELEMENTS).map((e) => ({
    text: e.label,
    clickable: true,
  }));
  return {
    available: true,
    package: snap.url || "",
    class: snap.title || "",
    summary: elementsText(snap),
    nodes,
  };
}

async function describePageViaGateway(tabId, cfg, signal, cueId) {
  await saveTaskState(cueId, { status: "running", instruction: "Describe this page", step: 0, lastResult: "reading page (gateway)", tabId });
  send(tabId, { cmd: "progress", cueId, text: "reading the page…" });
  throwIfAborted(signal);
  const snap = await ask(tabId, { cmd: "snapshot" });
  throwIfAborted(signal);
  const sessionId = await getStableSessionId();
  const deviceId = await getStableDeviceId();
  const data = await callGateway(cfg, "/v1/chat", {
    signal,
    body: {
      source: "agee-extension",
      device_id: deviceId,
      session_id: sessionId,
      conversation_id: sessionId,
      branch_id: cueId || "describe",
      all_branches_context: true,
      screen: snapToScreen(snap),
      client: {
        platform: "browser",
        source: "agee-extension",
        device_id: deviceId,
        input: "text",
      },
      messages: [
        { role: "user", content: "Describe this page in 3-5 compact bullets. Include what it is and what the user can do here. Do not claim you took any action." },
      ],
    },
  });
  const text = String(data.text || "").trim() || "The gateway returned an empty description.";
  send(tabId, { cmd: "done", cueId, summary: text });
  await saveTaskState(cueId, { status: "done", instruction: "Describe this page", step: 1, lastResult: text.slice(0, 500), tabId });
}

async function describePage(tabId, controller, cueId) {
  const signal = controller.signal;

  try {
    const cfg = await getConfig();

    // Thin client: page description is produced by the user's gateway. There is
    // no in-browser model path.
    if (!cfg.gatewayUrl) {
      send(tabId, { cmd: "error", cueId, text: "No gateway URL set. Click the A.G. toolbar icon → Options and set the Agent gateway URL." });
      return;
    }
    await describePageViaGateway(tabId, cfg, signal, cueId);
  } catch (err) {
    const message = signal.aborted ? "Task cancelled." : String(err.message || err);
    send(tabId, { cmd: signal.aborted ? "done" : "error", cueId, summary: message, text: message });
    await saveTaskState(cueId, { status: signal.aborted ? "cancelled" : "error", instruction: "Describe this page", lastResult: message, tabId });
  } finally {
    if (tasks.get(cueId)?.controller === controller) tasks.delete(cueId);
  }
}

async function runAgent(tabId, instruction, controller, cueId) {
  const signal = controller.signal;

  try {
    const cfg = await getConfig();

    // Thin client: every turn is handled by the user's self-hosted gateway.
    // There is no in-browser model path or provider key.
    if (!cfg.gatewayUrl) {
      send(tabId, { cmd: "error", cueId, text: "No gateway URL set. Click the A.G. toolbar icon → Options and set the Agent gateway URL." });
      return;
    }

    // First, see if the user is asking *about* their prompt history, then if
    // they are changing settings by talking to the agent ("be terser", "set
    // the system prompt to …"). Either is handled through the profile
    // endpoints instead of running a conversational turn.
    // Fast local stop path, defense in depth. The overlay already halts typed
    // "stop / shut up / be quiet" before it reaches here, but if a stop utterance
    // ever arrives as a run it must halt silently and never touch a model. Tell
    // the overlay to stop playback and live turns; do not produce a reply.
    if (isStopCommand(instruction)) {
      send(tabId, { cmd: "stop", cueId });
      send(tabId, { cmd: "done", cueId, summary: "", text: "" });
      return;
    }
    if (await maybeAnswerProfileQuery(tabId, instruction, cfg, signal, cueId)) {
      return;
    }
    if (await maybeRouteGatewayProfileControl(tabId, instruction, cfg, signal, cueId)) {
      return;
    }
    if (await maybeApplySettingsChange(tabId, instruction, cfg, signal, cueId)) {
      return;
    }
    if (await maybeRequestAndroidSpeak(tabId, instruction, cfg, signal, cueId)) {
      return;
    }
    // Page-change requests are no longer gated by a local keyword regex. They flow
    // to the gateway model turn, which can call propose_page_tweak and return a
    // page_tweak action; runViaGateway applies it through tweak:applyRecord. The
    // tweak:* message API stays intact for the smoke and options paths.
    const browserTask = parseBrowserTaskIntent(instruction);
    if (browserTask) {
      await runBranchTaskAgent(tabId, browserTask.instruction, browserTask.url, controller, cueId);
      return;
    }
    if (await maybeOpenRequestedTab(tabId, instruction, signal, cueId)) {
      return;
    }
    await runViaGateway(tabId, instruction, cfg, signal, cueId);
  } catch (err) {
    const message = signal.aborted ? "Task cancelled." : String(err.message || err);
    send(tabId, { cmd: signal.aborted ? "done" : "error", cueId, summary: message, text: message });
    await saveTaskState(cueId, { status: signal.aborted ? "cancelled" : "error", instruction, lastResult: message, tabId });
  } finally {
    if (tasks.get(cueId)?.controller === controller) tasks.delete(cueId);
  }
}

async function maybeRequestAndroidSpeak(tabId, instruction, cfg, signal, cueId) {
  const text = parseAndroidSpeakIntent(instruction);
  if (!text) return false;
  await saveTaskState(cueId, { status: "running", instruction, step: 0, lastResult: "queueing Android speech request", tabId });
  send(tabId, { cmd: "progress", cueId, text: "sending to phone…" });
  throwIfAborted(signal);

  const sessionId = await getStableSessionId();
  const deviceId = await getStableDeviceId();
  const data = await callGateway(cfg, "/v1/tool/requests", {
    signal,
    body: {
      source: "agee-extension",
      source_device_id: deviceId,
      source_surface_type: "browser_extension",
      target_surface_type: "android",
      tool: "audio.speak",
      input: { text },
      session_id: sessionId,
      branch_id: cueId || "browser",
      instruction,
    },
  });
  const request = data?.request || {};
  const target = request.target_device_id
    ? `for ${request.target_device_id}`
    : "for the next Android client heartbeat";
  const summary = `Queued Android speech request ${request.id || ""} ${target}.`;
  send(tabId, { cmd: "done", cueId, summary });
  await saveTaskState(cueId, {
    status: "done",
    instruction,
    step: 1,
    tabId,
    lastResult: summary,
    toolRequestId: request.id || "",
  });
  return true;
}

function parseAndroidSpeakIntent(instruction) {
  const value = String(instruction || "").trim();
  if (!value) return "";
  const lower = value.toLowerCase();
  if (!/\b(?:android|phone|mobile)\b/.test(lower)) return "";
  if (!/\b(?:say|speak|read|announce)\b/.test(lower)) return "";

  const quoted = value.match(/["“”']([^"“”']{1,500})["“”']/);
  if (quoted?.[1]) return quoted[1].trim();

  const patterns = [
    /\b(?:android|phone|mobile)\b.*?\b(?:say|speak|read|announce)\b\s*:?\s*(.+)$/i,
    /\b(?:say|speak|read|announce)\b\s+(.+?)\s+\b(?:on|from|through)\b\s+(?:the\s+)?(?:android|phone|mobile)\b/i,
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    const text = match?.[1]?.trim();
    if (text) return text.replace(/[.?!]\s*$/, "").slice(0, 500);
  }
  return "";
}

async function maybeOpenRequestedTab(tabId, instruction, signal, cueId) {
  const intent = parseOpenTabIntent(instruction);
  if (!intent) return false;
  throwIfAborted(signal);
  const url = new URL(intent.url);
  if (!ALLOWED_NAVIGATION_PROTOCOLS.has(url.protocol)) {
    send(tabId, { cmd: "error", cueId, text: `Blocked unsupported URL: ${intent.url}` });
    return true;
  }
  const opened = await chrome.tabs.create({ url: url.href, active: true });
  const summary = `Opened ${opened.url || url.href}.`;
  send(tabId, { cmd: "done", cueId, summary });
  await saveTaskState(cueId, {
    status: "done",
    instruction,
    step: 1,
    tabId,
    lastResult: summary,
    openedTabId: opened.id,
  });
  return true;
}

// ---- CDP task agent (router → disposable background-tab agent) -------------
// The product framing: a sterile router launches N disposable task agents, each
// driving its OWN background tab via chrome.debugger (Chrome DevTools Protocol).
// This is the minimal verifiable spike of ONE such agent: open a background tab
// (active:false, no focus steal), attach the debugger, navigate + screenshot +
// one input event + read a little page state over CDP, detach, dispose the tab,
// and ping the overlay "done" on the cue path the rest of the extension uses.
//
// Trust boundary: this drives a browser tab; it touches NO API keys and makes
// NO model calls. The instruction is a label for the disposable run, not an
// executable command.

const CDP_PROTOCOL_VERSION = "1.3";

function debuggerAttach(target) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach(target, CDP_PROTOCOL_VERSION, () => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve();
    });
  });
}

function debuggerDetach(target) {
  return new Promise((resolve) => {
    try {
      chrome.debugger.detach(target, () => {
        void chrome.runtime.lastError; // tolerate already-detached / gone tab
        resolve();
      });
    } catch {
      resolve();
    }
  });
}

function debuggerSend(target, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, method, params, (result) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(`${method}: ${err.message}`));
      else resolve(result || {});
    });
  });
}

// Wait until the background tab reports a non-loading state, or time out. We
// avoid focusing the tab; we only poll its status via chrome.tabs.get.
async function waitForBackgroundTabLoad(tabId, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === "complete") return;
    } catch {
      return; // tab gone
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

// Run one disposable task agent in its own background tab. `overlayTabId` is the
// user's foreground tab whose overlay shows the cue; `instruction`/`url` come
// from the {cmd:"branch"} intent. Never activates the background tab.
//
// `opts.parentRunId` (optional) threads fan-out lineage so concurrent workers in
// one BRANCH-TO-TWO trigger share a gateway parent. When a gateway is configured
// we ALSO register a router activation for this worker: the gateway launches its
// disposable agent run, tracks it, and emits a durable router_ping the overlay
// renders. The CDP browser work and the gateway activation run concurrently; the
// gateway's harness output is a proposal we summarize, never an executable
// command.
async function runBranchTaskAgent(overlayTabId, instruction, url, controller, cueId, opts = {}) {
  const signal = controller.signal;
  let bgTabId = null;
  let attached = false;
  const target = {};
  const navUrl = (() => {
    try {
      const u = new URL(url);
      return ALLOWED_NAVIGATION_PROTOCOLS.has(u.protocol) ? u.href : null;
    } catch {
      return null;
    }
  })();

  try {
    if (!navUrl) {
      send(overlayTabId, { cmd: "error", cueId, text: `branch: blocked or invalid url: ${url}` });
      await saveTaskState(cueId, { status: "error", instruction, lastResult: `invalid url ${url}`, tabId: overlayTabId });
      return;
    }

    await saveTaskState(cueId, { status: "running", instruction, step: 0, lastResult: "launching background task agent", tabId: overlayTabId });
    send(overlayTabId, { cmd: "progress", cueId, text: "launching background agent…" });
    throwIfAborted(signal);

    // Fuse the two PoCs: if a gateway is configured, register a router activation
    // for this worker. The gateway launches + tracks a disposable run and emits a
    // durable router_ping; we poll for it CONCURRENTLY with the CDP browser work
    // below so neither blocks the other. Best-effort: a gateway hiccup must not
    // sink the local browser task.
    const cfg = await getConfig();
    let routerPromise = null;
    let routerRunId = null;
    if (cfg.gatewayUrl) {
      routerPromise = (async () => {
        const { runId } = await routerActivate(cfg, {
          intent: instruction,
          parentRunId: opts.parentRunId,
          signal,
        });
        routerRunId = runId;
        await saveTaskState(cueId, { status: "running", instruction, routerRunId: runId, tabId: overlayTabId });
        return waitForRouterPing(cfg, runId, signal);
      })().catch((err) => ({ error: String(err?.message || err) }));
    }

    // Disposable background tab — the agent's own surface. active:false is the
    // whole contract: it must never steal the user's focus.
    const bgTab = await chrome.tabs.create({ url: "about:blank", active: false });
    bgTabId = bgTab.id;
    target.tabId = bgTabId;

    // One debugger client per tab: attach can fail (e.g. DevTools already
    // attached). Emit an error cue instead of throwing.
    try {
      await debuggerAttach(target);
      attached = true;
    } catch (err) {
      send(overlayTabId, { cmd: "error", cueId, text: `branch: could not attach debugger (${err.message})` });
      await saveTaskState(cueId, { status: "error", instruction, lastResult: `attach failed: ${err.message}`, tabId: overlayTabId });
      return;
    }

    throwIfAborted(signal);
    await debuggerSend(target, "Page.enable");
    await debuggerSend(target, "Runtime.enable");

    send(overlayTabId, { cmd: "progress", cueId, text: "navigating background tab…" });
    await debuggerSend(target, "Page.navigate", { url: navUrl });
    await waitForBackgroundTabLoad(bgTabId);
    throwIfAborted(signal);

    // Capture a screenshot of the BACKGROUND tab over CDP (no foreground capture,
    // so the user's visible tab is untouched).
    send(overlayTabId, { cmd: "progress", cueId, text: "capturing background screenshot…" });
    const shot = await debuggerSend(target, "Page.captureScreenshot", { format: "jpeg", quality: 40 });
    const screenshotBytes = shot?.data ? shot.data.length : 0;
    if (!screenshotBytes) throw new Error("background screenshot capture returned no data");

    // Dispatch exactly ONE input event into the background tab. A keyboard event
    // is enough to prove we can drive input over CDP without focusing the tab.
    throwIfAborted(signal);
    await debuggerSend(target, "Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    await debuggerSend(target, "Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });

    // Read a little page state back over CDP.
    const evalRes = await debuggerSend(target, "Runtime.evaluate", {
      expression: "JSON.stringify({ title: document.title, url: location.href, ready: document.readyState })",
      returnByValue: true,
    });
    let pageState = {};
    try {
      pageState = JSON.parse(evalRes?.result?.value || "{}");
    } catch {
      pageState = {};
    }

    // Confirm the background tab never became active (focus contract).
    let stayedBackground = true;
    try {
      const finalTab = await chrome.tabs.get(bgTabId);
      stayedBackground = finalTab.active === false;
    } catch {
      // tab already gone — treat as background (it was never surfaced)
    }

    // Await the gateway router_ping (if we started one) so the overlay reflects
    // both sides of the fused loop: the CDP browser work AND the durable router
    // ping. The ping summary is a proposal we render, never executed.
    let routerPing = null;
    if (routerPromise) {
      send(overlayTabId, { cmd: "progress", cueId, text: "awaiting router ping…" });
      routerPing = await routerPromise;
    }

    const title = pageState.title || "(untitled)";
    let summary =
      `Background task agent done — opened "${title}", captured ${Math.round(screenshotBytes / 1024)}KB screenshot, ` +
      `dispatched 1 input event${stayedBackground ? ", tab stayed in background." : " (warning: tab became active)."}`;
    if (routerPing && !routerPing.error && routerPing.summary) {
      summary += ` Router ping: ${truncate(String(routerPing.summary), 160)}`;
    } else if (routerPing && routerPing.error) {
      summary += ` (router ping unavailable: ${truncate(routerPing.error, 120)})`;
    }
    send(overlayTabId, { cmd: "done", cueId, summary });
    await saveTaskState(cueId, {
      status: "done",
      instruction,
      step: 1,
      tabId: overlayTabId,
      routerRunId,
      routerPingOk: Boolean(routerPing && !routerPing.error && routerPing.ok),
      lastResult: summary.slice(0, 400),
    });
  } catch (err) {
    const message = signal.aborted ? "Task cancelled." : `branch failed: ${String(err.message || err)}`;
    send(overlayTabId, { cmd: signal.aborted ? "done" : "error", cueId, summary: message, text: message });
    await saveTaskState(cueId, { status: signal.aborted ? "cancelled" : "error", instruction, lastResult: message, tabId: overlayTabId });
  } finally {
    if (attached) await debuggerDetach(target);
    // Dispose the throwaway tab — task agents are disposable by design.
    if (bgTabId != null) {
      try {
        await chrome.tabs.remove(bgTabId);
      } catch {
        // tab already closed
      }
    }
    if (tasks.get(cueId)?.controller === controller) tasks.delete(cueId);
  }
}

// BRANCH-TO-TWO (the headline): one trigger fans out to N disposable task
// agents that run CONCURRENTLY, each in its OWN background tab with its OWN cue.
// Neither steals focus; each pings independently on completion; each registers
// its own gateway router activation under a shared parent run, so the gateway
// records one router_ping per worker.
//
// `branches` is an array of { instruction, url, cueId }. We start every worker
// in the same tick (no awaiting between launches) so they are genuinely
// in-flight together, then let each finish on its own lane.
async function runBranchFanout(overlayTabId, branches, controllersByCue) {
  // A shared parent gateway run ties the fan-out together as lineage. Best-effort:
  // if the gateway is down or unset, the workers still run locally.
  let parentRunId = null;
  try {
    const cfg = await getConfig();
    if (cfg.gatewayUrl) {
      const parent = await routerActivate(cfg, {
        intent: `fan-out: ${branches.length} concurrent task agents`,
        signal: undefined,
      });
      parentRunId = parent.runId;
    }
  } catch {
    parentRunId = null; // lineage is a nicety, not a requirement
  }

  // Launch every worker without awaiting between them: they share this tick and
  // are therefore concurrently in flight.
  for (const branch of branches) {
    const controller = controllersByCue.get(branch.cueId);
    if (!controller) continue;
    runBranchTaskAgent(overlayTabId, branch.instruction, branch.url, controller, branch.cueId, {
      parentRunId,
    });
  }
}

// Generate a cueId server-side if the content script didn't supply one, so old
// callers still work. Each cue is independent — we never reject a new one.
function nextCueId(provided) {
  if (typeof provided === "string" && provided) return provided;
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

// Cancel every running cue on a tab (Stop button with no specific cue).
function cancelTabCues(tabId) {
  for (const [cueId, task] of tasks) {
    if (task.tabId === tabId) {
      task.controller.abort();
      tasks.delete(cueId);
    }
  }
}

// ---- Ambient capture loop (continuous / rung-3 interaction mode) ----------
// While active, sample the screen on a fixed interval (~200ms target) and POST
// each frame to the gateway's /v1/voice/frames intake. Self-throttling: it
// never overlaps a post, so a slow capture lowers the effective rate instead of
// piling requests up. One ambient run at a time (one person, one screen).
const AMBIENT_MIN_INTERVAL_MS = 100;
const AMBIENT_DEFAULT_INTERVAL_MS = 200;
let ambient = null; // { tabId, timer, seq, inFlight, sessionId }

async function startAmbientCapture(tabId, intervalMs) {
  if (ambient) stopAmbientCapture();
  const interval = Math.max(AMBIENT_MIN_INTERVAL_MS, Number(intervalMs) || AMBIENT_DEFAULT_INTERVAL_MS);
  const sessionId = await getStableSessionId();
  ambient = { tabId, timer: null, seq: 0, inFlight: false, intervalMs: interval, sessionId };
  send(tabId, { cmd: "ambient", state: "on" });
  ambient.timer = setInterval(() => captureAmbientFrame().catch(() => {}), interval);
  captureAmbientFrame().catch(() => {});
  return { ok: true, intervalMs: interval, sessionId };
}

function stopAmbientCapture() {
  if (!ambient) return;
  clearInterval(ambient.timer);
  const tabId = ambient.tabId;
  ambient = null;
  try { send(tabId, { cmd: "ambient", state: "off" }); } catch {}
}

async function captureAmbientFrame() {
  if (!ambient || ambient.inFlight) return; // self-throttle: skip while a post is pending
  ambient.inFlight = true;
  const tabId = ambient.tabId;
  try {
    const cfg = await getConfig();
    if (!cfg.gatewayUrl) { stopAmbientCapture(); return; }
    let screen;
    try {
      const snap = await ask(tabId, { cmd: "snapshot" });
      screen = snapToScreen(snap);
    } catch {
      screen = undefined; // restricted page; still send a frame so cadence holds
    }
    await callGateway(cfg, "/v1/voice/frames", {
      body: { source: "agee-extension", session_id: ambient.sessionId, seq: ambient.seq++, screen },
    });
  } finally {
    if (ambient) ambient.inFlight = false;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.cmd === "offscreenVoiceAudio") {
    sendResponse(sendVoiceSessionAudio(msg.voiceSessionId, msg.audio));
    return true;
  }
  if (msg.cmd === "offscreenVoiceError") {
    handleOffscreenVoiceError(msg.voiceSessionId, msg.error);
    sendResponse({ ok: true });
    return true;
  }
  if (msg.cmd === "voiceSessionStart" && sender.tab) {
    const tabId = sender.tab.id;
    claimActiveAgentTab(tabId, "another page voice session started", {
      cue_id: msg.cueId || null,
      status: "listening",
    });
    startVoiceSessionProxy(tabId, {
      cueId: msg.cueId,
      turnId: msg.turnId,
      assistantOverlap: msg.assistantOverlap === true,
      capture: msg.capture === "extension-offscreen" ? "extension-offscreen" : "content-script",
      autoCommit: msg.autoCommit !== false,
    })
      .then((session) => {
        if (session?.voiceSessionId) {
          setActiveBrowserAgentOwner(tabId, "browser voice session started", {
            cue_id: msg.cueId || null,
            voice_session_id: session.voiceSessionId,
            status: "listening",
          }).catch(() => {});
        }
        sendResponse({ ok: true, ...session });
      })
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }
  if (msg.cmd === "voiceSessionAttach" && sender.tab) {
    sendResponse(attachVoiceSession(msg.voiceSessionId, sender.tab.id));
    return true;
  }
  if (msg.cmd === "voiceSessionAudio") {
    sendResponse(sendVoiceSessionAudio(msg.voiceSessionId, msg.audio));
    return true;
  }
  if (msg.cmd === "voiceSessionControl") {
    sendVoiceSessionControl(msg.voiceSessionId, msg.message)
      .then((response) => sendResponse(response))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }
  if (msg.cmd === "voiceSessionClose") {
    closeVoiceSession(msg.voiceSessionId, String(msg.reason || "closed"));
    sendResponse({ ok: true });
    return true;
  }
  if (msg.cmd === "devReloadExtension") {
    devReloadConfig()
      .then((cfg) => maybeReloadForDevVersion(msg.info || {}, {
        server: String(msg.server || cfg.server || DEV_RELOAD_DEFAULT_SERVER).replace(/\/+$/, ""),
        previousVersion: Number(msg.previousVersion || cfg.version || 0) || null,
        source: String(msg.source || "message"),
      }))
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }
  if (msg.cmd === "history") {
    getConfig()
      .then((cfg) => loadHistory(cfg))
      .then((turns) => sendResponse({ ok: true, turns }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error), turns: [] }));
    return true;
  }
  if (msg.cmd === "voiceSessionTicket") {
    getConfig()
      .then((cfg) => createVoiceSessionTicket(cfg))
      .then((ticket) => sendResponse({ ok: true, ...ticket }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }
  if (msg.cmd === "run" && sender.tab) {
    const tabId = sender.tab.id;
    const cueId = nextCueId(msg.cueId);
    claimActiveAgentTab(tabId, "another page agent turn started", {
      cue_id: cueId,
      status: "running",
    });
    const controller = new AbortController();
    tasks.set(cueId, { controller, tabId });
    runAgent(tabId, msg.instruction, controller, cueId);
  }
  if (msg.cmd === "branch" && sender.tab) {
    // Router intent: launch a disposable task agent in its OWN background tab.
    const overlayTabId = sender.tab.id;
    const cueId = nextCueId(msg.cueId);
    claimActiveAgentTab(overlayTabId, "another page agent turn started", {
      cue_id: cueId,
      status: "running",
    });
    const controller = new AbortController();
    tasks.set(cueId, { controller, tabId: overlayTabId });
    runBranchTaskAgent(overlayTabId, msg.instruction, msg.url, controller, cueId);
  }
  if (msg.cmd === "branchFanout" && sender.tab && Array.isArray(msg.branches)) {
    // BRANCH-TO-TWO: one trigger, N concurrent disposable task agents, each its
    // own background tab + own cue + own gateway router activation.
    const overlayTabId = sender.tab.id;
    const controllersByCue = new Map();
    const branches = msg.branches.map((b) => {
      const cueId = nextCueId(b.cueId);
      const controller = new AbortController();
      tasks.set(cueId, { controller, tabId: overlayTabId });
      controllersByCue.set(cueId, controller);
      return { instruction: b.instruction, url: b.url, cueId };
    });
    claimActiveAgentTab(overlayTabId, "another page agent turn started", {
      cue_id: branches[0]?.cueId || null,
      status: "running",
    });
    runBranchFanout(overlayTabId, branches, controllersByCue);
  }
  if (msg.cmd === "describe" && sender.tab) {
    const tabId = sender.tab.id;
    const cueId = nextCueId(msg.cueId);
    claimActiveAgentTab(tabId, "another page agent turn started", {
      cue_id: cueId,
      status: "running",
    });
    const controller = new AbortController();
    tasks.set(cueId, { controller, tabId });
    describePage(tabId, controller, cueId);
  }
  if (msg.cmd === "cancel" && sender.tab) {
    const tabId = sender.tab.id;
    if (msg.cueId && tasks.has(msg.cueId)) {
      tasks.get(msg.cueId).controller.abort();
      tasks.delete(msg.cueId);
    } else {
      cancelTabCues(tabId);
    }
  }
  if (msg.cmd === "ambientStart" && sender.tab) {
    const tabId = sender.tab.id;
    claimActiveAgentTab(tabId, "another page ambient session started", {
      status: "ambient",
    });
    startAmbientCapture(tabId, msg.intervalMs)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }
  if (msg.cmd === "ambientStop") {
    stopAmbientCapture();
    sendResponse({ ok: true });
    return true;
  }
  // Overlay review surface -> tweaks module. content.js and tweaks.js are separate
  // content scripts in the same tab and cannot message each other directly, so the
  // overlay routes list/remove through the background, which forwards to the
  // tweaks module in the same tab via the existing tweak:* API.
  if (msg.cmd === "tweakList" && sender.tab) {
    ask(sender.tab.id, { cmd: "tweak:list" })
      .then((res) => sendResponse(res || { ok: false, tweaks: [] }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error), tweaks: [] }));
    return true;
  }
  if (msg.cmd === "tweakRemove" && sender.tab) {
    ask(sender.tab.id, { cmd: "tweak:remove", id: msg.id })
      .then((res) => sendResponse(res || { ok: false }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }
});

// Stop the ambient loop if its tab goes away, so it never posts against a dead tab.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (ambient && ambient.tabId === tabId) stopAmbientCapture();
  if (activeAgentTabId === tabId) {
    activeAgentTabId = null;
    clearActiveBrowserAgentOwner(tabId, "owner tab closed").catch(() => {});
  }
  closeTabVoiceSessions(tabId);
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;
  try {
    await ensureContent(tab.id);
    await chrome.tabs.sendMessage(tab.id, { cmd: "open" });
  } catch {
    // Restricted browser pages cannot receive content scripts.
  }
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if ((command !== "toggle-agee" && command !== "toggle-agee-voice") || !tab?.id) return;
  try {
    await ensureContent(tab.id);
    await chrome.tabs.sendMessage(tab.id, {
      cmd: command === "toggle-agee-voice" ? "toggleVoice" : "toggle",
      source: "command",
    });
  } catch {
    // Restricted browser pages cannot receive content scripts.
  }
});
