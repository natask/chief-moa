// Privacy smoke for the real MV3 extension in headless Chrome for Testing.
//
// The harness copies the extension, removes checkout-local baked config, uses a
// throwaway profile, and points explicit requests at a loopback ledger. It
// attaches CDP Network instrumentation directly to every service-worker target
// it starts. The user's installed extension, profile, gateway, and active tabs
// are never touched.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { resolveChromeForTesting, quietChromeArgs } from "./chrome-for-testing.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const sourceExtensionPath = join(root, "extension");
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const runDir = join(root, ".gstack", "background-qa", `proactive-${runId}`);
const extensionPath = join(runDir, "extension");
const profilePath = join(runDir, "chrome-profile");
const TOKEN = "proactive-smoke-token";
const TEXT_PROMPT = "Help me plan an analysis for a table.";
const PROACTIVE_PATH = "/v1/proactive/turns";
const CONFIGURED_IDLE_MS = process.env.AGEE_PROACTIVE_SMOKE_FAST === "1" ? 250 : 35000;
const SENTINELS = [
  "SENTINEL_PAGE_BODY_DO_NOT_SEND",
  "SENTINEL_TABLE_CELL_DO_NOT_SEND",
  "SENTINEL_PASSWORD_DO_NOT_READ",
  "Private sentinel heading",
  "Private sentinel document",
  "HOSTILE_SENTINEL_PRIVATE_HEADING",
  "HOSTILE_SENTINEL_PAGE_BODY_DO_NOT_SEND",
  "HOSTILE_SENTINEL_TABLE_DO_NOT_SEND",
  "PAGE-SPOOFED",
  "FORGED PAGE ALLOW",
];
const CLAIM_PATHS = new Set([
  "/v1/browser/tasks/claim",
  "/v1/tool/requests/claim",
  "/v1/browser/agent-tasks/claim",
]);
let chromeStderr = "";

const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
const targetIdOf = (target) => target?.id || target?.targetId || "";
const sha256 = (value) => createHash("sha256").update(String(value), "utf8").digest("hex");
const validProactiveResponse = (text = "Text-only proactive reply") => ({
  source: "proactive_accept_v1",
  classification: "proactive_text_only",
  persisted: false,
  display: text,
  text,
  actions: [],
});

function serveFixtures() {
  const state = { requests: [] };
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    state.requests.push({ method: req.method, path: url.pathname, search: url.search, receivedAt: Date.now() });
    const relative = url.pathname.includes("hostile")
      ? "fixtures/proactive-hostile.html"
      : url.pathname.includes("checkout") || url.pathname.includes("sensitive")
        ? "fixtures/proactive-sensitive.html"
        : "fixtures/proactive.html";
    try {
      const body = readFileSync(join(root, relative));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  });
  return new Promise((resolveServer) => server.listen(0, "localhost", () => {
    resolveServer({ server, port: server.address().port, state });
  }));
}

function readRequestBody(req) {
  return new Promise((resolveBody) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      let json = null;
      try { json = raw ? JSON.parse(raw) : {}; } catch {}
      resolveBody({ raw, json });
    });
  });
}

function startStubGateway(redirectUrl) {
  const state = {
    requests: [],
    proactiveResponses: [],
    redirectCodes: [],
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const body = await readRequestBody(req);
    const request = {
      method: req.method,
      path: url.pathname,
      search: url.search,
      headers: { ...req.headers },
      raw: body.raw,
      body: body.json,
      receivedAt: Date.now(),
    };
    state.requests.push(request);
    const respond = (payload, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    if (url.pathname === "/v1/sessions/default") {
      return respond({ session_id: "proactive-smoke-session" });
    }
    if (url.pathname === PROACTIVE_PATH) {
      const redirectCode = state.redirectCodes.shift();
      if (redirectCode) {
        res.writeHead(redirectCode, { location: redirectUrl });
        res.end();
        return;
      }
      const next = state.proactiveResponses.shift() || validProactiveResponse();
      const delayMs = Number(next?.delayMs || 0);
      const payload = next && Object.hasOwn(next, "payload") ? next.payload : next;
      if (delayMs > 0) await delay(delayMs);
      return respond(payload);
    }
    if (url.pathname === "/v1/voice/turns") {
      return respond({ display: "Explicit workflow reply", text: "Explicit workflow reply", actions: [] });
    }
    if (CLAIM_PATHS.has(url.pathname)) return respond({ tasks: [], requests: [] });
    if (url.pathname === "/v1/device-clients/heartbeat") return respond({ ok: true });
    return respond({});
  });
  return new Promise((resolveServer) => server.listen(0, "127.0.0.1", () => {
    resolveServer({ server, port: server.address().port, state });
  }));
}

async function waitForFile(path, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (existsSync(path)) return readFileSync(path, "utf8");
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${path}`);
}

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.ready = new Promise((resolveReady, rejectReady) => {
      this.ws.onopen = resolveReady;
      this.ws.onerror = rejectReady;
    });
    this.ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        return;
      }
      for (const listener of this.listeners.get(message.method) || []) listener(message.params || {});
    };
  }

  on(method, listener) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(listener);
  }

  async send(method, params = {}) {
    await this.ready;
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolveCall, reject) => this.pending.set(id, { resolve: resolveCall, reject }));
  }

  close() { try { this.ws.close(); } catch {} }
}

async function targets(port) {
  return fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
}

async function waitForTarget(port, predicate, timeoutMs = 15000) {
  const started = Date.now();
  let latest = [];
  while (Date.now() - started < timeoutMs) {
    latest = await targets(port);
    const match = latest.find(predicate);
    if (match) return match;
    await delay(100);
  }
  throw new Error(`Timed out waiting for target: ${JSON.stringify(latest.map(({ type, url, id }) => ({ type, url, id })))}`);
}

async function waitForTargetGone(port, id, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!(await targets(port)).some((target) => targetIdOf(target) === id)) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for target ${id} to close`);
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}

async function waitForEval(cdp, expression, timeoutMs = 12000) {
  const started = Date.now();
  let latest;
  while (Date.now() - started < timeoutMs) {
    latest = await evaluate(cdp, expression).catch(() => undefined);
    if (latest) return latest;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${expression}; latest=${JSON.stringify(latest)}`);
}

async function waitFor(condition, label, timeoutMs = 12000) {
  const started = Date.now();
  let latest;
  while (Date.now() - started < timeoutMs) {
    latest = await condition();
    if (latest) return latest;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}; latest=${JSON.stringify(latest)}`);
}

function attachWorkerNetwork(cdp, label, ledger) {
  const byRequestId = new Map();
  const earlyExtra = new Map();
  const webSocketUrls = new Map();
  cdp.on("Network.requestWillBeSent", (params) => {
    const event = {
      kind: "http",
      label,
      requestId: params.requestId,
      url: params.request?.url || "",
      method: params.request?.method || "",
      headers: { ...(params.request?.headers || {}) },
      postData: params.request?.postData || "",
      wallTime: Number(params.wallTime || 0),
      capturedAt: Date.now(),
    };
    if (earlyExtra.has(params.requestId)) {
      event.extraHeaders = earlyExtra.get(params.requestId);
      earlyExtra.delete(params.requestId);
    }
    ledger.push(event);
    byRequestId.set(params.requestId, event);
  });
  cdp.on("Network.requestWillBeSentExtraInfo", (params) => {
    const headers = { ...(params.headers || {}) };
    const event = byRequestId.get(params.requestId);
    if (event) event.extraHeaders = headers;
    else earlyExtra.set(params.requestId, headers);
  });
  cdp.on("Network.webSocketCreated", (params) => {
    const url = params.url || "";
    webSocketUrls.set(params.requestId, url);
    ledger.push({ kind: "websocket-created", label, requestId: params.requestId, url, capturedAt: Date.now() });
  });
  cdp.on("Network.webSocketWillSendHandshakeRequest", (params) => {
    ledger.push({
      kind: "websocket-handshake-request",
      label,
      requestId: params.requestId,
      url: webSocketUrls.get(params.requestId) || "",
      headers: { ...(params.request?.headers || {}) },
      capturedAt: Date.now(),
    });
  });
  cdp.on("Network.webSocketHandshakeResponseReceived", (params) => {
    ledger.push({
      kind: "websocket-handshake-response",
      label,
      requestId: params.requestId,
      url: webSocketUrls.get(params.requestId) || "",
      headers: { ...(params.response?.headers || {}) },
      capturedAt: Date.now(),
    });
  });
}

function normalizedHeaders(...sources) {
  const output = {};
  for (const source of sources) {
    for (const [key, value] of Object.entries(source || {})) output[String(key).toLowerCase()] = String(value);
  }
  return output;
}

function networkMark(networkLedger, gatewayState) {
  return { network: networkLedger.length, gateway: gatewayState.requests.length };
}

function externalWorkerEvents(events) {
  const external = [];
  for (const event of events) {
    if (event.kind.startsWith("websocket")) {
      external.push(event);
      continue;
    }
    if (event.kind !== "http") continue;
    let url;
    try { url = new URL(event.url); } catch {
      external.push(event);
      continue;
    }
    if (url.protocol === "chrome-extension:") {
      // config.js deliberately checks for a packaged optional config file.
      // The smoke copy removes it, so a worker restart records a local
      // chrome-extension://.../agee.config.json GET. This never crosses a
      // network boundary; any other extension-package request is unexpected.
      if (event.method === "GET" && url.pathname === "/agee.config.json") continue;
      external.push(event);
      continue;
    }
    external.push(event);
  }
  return external;
}

function assertSilentSince(mark, networkLedger, gatewayState, label) {
  const network = externalWorkerEvents(networkLedger.slice(mark.network));
  const gateway = gatewayState.requests.slice(mark.gateway);
  if (network.length || gateway.length) {
    throw new Error(`${label} was not network-silent: ${JSON.stringify({ network, gateway })}`);
  }
}

function assertNoSentinels(value, label) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  for (const sentinel of SENTINELS) {
    if (text.includes(sentinel)) throw new Error(`${label} leaked ${sentinel}`);
  }
}

function assertExactAcceptedBody(request, disclosedPrompt = TEXT_PROMPT) {
  const body = request?.body;
  if (!body || typeof body !== "object") throw new Error("accepted turn did not carry JSON");
  const exactKeys = (value) => Object.keys(value || {}).sort().join(",");
  if (request.method !== "POST" || request.path !== PROACTIVE_PATH || request.search !== "") {
    throw new Error(`accepted destination drifted: ${JSON.stringify(request)}`);
  }
  if (exactKeys(body) !== "client,modality,source,transcript") throw new Error(`accepted body fields drifted: ${exactKeys(body)}`);
  if (exactKeys(body.client) !== "input,platform,source") throw new Error(`client fields drifted: ${exactKeys(body.client)}`);
  if (body.source !== "proactive_accept_v1" || body.modality !== "text") throw new Error("accepted source/modality contract drifted");
  if (!disclosedPrompt || body.transcript !== disclosedPrompt) {
    throw new Error(`accepted transcript did not equal disclosed prompt: ${JSON.stringify({ disclosedPrompt, sent: body.transcript })}`);
  }
  if (body.client.platform !== "browser" || body.client.source !== "agee-extension" || body.client.input !== "text") {
    throw new Error(`accepted client contract drifted: ${JSON.stringify(body.client)}`);
  }
  if (Buffer.byteLength(request.raw, "utf8") > 512) throw new Error(`accepted body exceeded 512 bytes (${Buffer.byteLength(request.raw, "utf8")})`);
  if (request.headers["content-type"] !== "application/json" || request.headers.authorization !== `Bearer ${TOKEN}`) {
    throw new Error(`accepted application headers drifted: ${JSON.stringify(request.headers)}`);
  }
  assertNoSentinels({ body, headers: request.headers }, "accepted request");
  const forbiddenKeys = new Set(["screen", "page", "url", "title", "body", "elements", "actions", "action", "snapshot", "screenshot", "history", "cookies", "form_values", "selected_text"]);
  const inspect = (value) => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (forbiddenKeys.has(key)) throw new Error(`accepted body contains forbidden key: ${key}`);
      inspect(child);
    }
  };
  inspect(body);
}

async function assertExactProactiveTraffic(mark, networkLedger, gatewayState, gatewayUrl, expectedCount, prompt = TEXT_PROMPT) {
  await delay(200);
  const gateway = gatewayState.requests.slice(mark.gateway);
  const network = externalWorkerEvents(networkLedger.slice(mark.network));
  const ws = network.filter((event) => event.kind.startsWith("websocket"));
  if (ws.length) throw new Error(`proactive acceptance opened WebSockets: ${JSON.stringify(ws)}`);
  if (gateway.length !== expectedCount || gateway.some((request) => request.path !== PROACTIVE_PATH)) {
    throw new Error(`proactive gateway traffic was not exact: ${JSON.stringify(gateway)}`);
  }
  const http = network.filter((event) => event.kind === "http");
  if (http.length !== expectedCount) throw new Error(`service-worker CDP captured ${http.length}, expected ${expectedCount}: ${JSON.stringify(network)}`);
  const expectedUrl = `${gatewayUrl}${PROACTIVE_PATH}`;
  for (let index = 0; index < expectedCount; index += 1) {
    const event = http[index];
    const request = gateway[index];
    assertExactAcceptedBody(request, prompt);
    if (event.url !== expectedUrl || event.method !== "POST") throw new Error(`CDP destination drifted: ${JSON.stringify(event)}`);
    if (!event.postData) throw new Error(`CDP did not capture proactive POST data: ${JSON.stringify(event)}`);
    if (JSON.stringify(JSON.parse(event.postData)) !== JSON.stringify(request.body)) throw new Error("CDP POST data did not match loopback ledger body");
    const headers = normalizedHeaders(event.headers, event.extraHeaders);
    if (headers["content-type"] !== "application/json" || headers.authorization !== `Bearer ${TOKEN}`) {
      throw new Error(`CDP did not capture exact proactive application headers: ${JSON.stringify(headers)}`);
    }
    assertNoSentinels({ url: event.url, headers, postData: event.postData }, "CDP proactive request");
  }
  return gateway;
}

async function navigate(browserCdp, pageCdp, targetId, url) {
  await browserCdp.send("Target.activateTarget", { targetId });
  await pageCdp.send("Page.navigate", { url });
  await waitForEval(pageCdp, `location.href === ${JSON.stringify(url)} && document.readyState === "complete"`);
  await waitForEval(pageCdp, `Boolean(document.querySelector("#proactiveHelp"))`);
}

async function tabIdForPage(workerCdp, url) {
  const origin = new URL(url).origin;
  return waitFor(
    () => evaluate(workerCdp, `chrome.tabs.query({}).then(tabs => tabs.find(tab => String(tab.url || "").startsWith(${JSON.stringify(origin)}) && !String(tab.url || "").includes("redirect-received"))?.id || 0)`),
    `tab id for ${origin}`,
  );
}

async function openPanel(workerCdp, pageCdp, tabId) {
  const response = await evaluate(workerCdp, `chrome.tabs.sendMessage(${Number(tabId)}, {cmd:"open"})`);
  if (!response?.ok) throw new Error(`could not open visible panel: ${JSON.stringify(response)}`);
  await waitForEval(pageCdp, `document.querySelector("#agee-root").classList.contains("agee-open") && getComputedStyle(document.querySelector("#agee-panel")).display !== "none"`);
}

async function trustedClick(cdp, selector) {
  const point = await evaluate(cdp, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return {error:"missing"};
    element.scrollIntoView({block:"center", inline:"center"});
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      width: rect.width,
      height: rect.height,
      disabled: Boolean(element.disabled),
      display: style.display,
      visibility: style.visibility,
    };
  })()`);
  if (point?.error || point.width <= 0 || point.height <= 0 || point.disabled || point.display === "none" || point.visibility === "hidden") {
    throw new Error(`cannot trusted-click ${selector}: ${JSON.stringify(point)}`);
  }
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1 });
}

async function trustedEnter(cdp, selector, value) {
  await evaluate(cdp, `(() => { const el=document.querySelector(${JSON.stringify(selector)}); el.value=${JSON.stringify(value)}; el.focus(); return true; })()`);
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
}

async function openCard(workerCdp, pageCdp, tabId) {
  await openPanel(workerCdp, pageCdp, tabId);
  await trustedClick(pageCdp, "#proactiveHelp");
  await waitForEval(pageCdp, `!document.querySelector("#agee-proactive-indicator").hidden`);
  await waitForEval(pageCdp, `Boolean(document.querySelector('.agee-proactive-card:not([hidden]) [data-agee-proactive="accept"]'))`, 10000);
  return evaluate(pageCdp, `document.querySelector(".agee-proactive-card").textContent`);
}

async function attachPage(target) {
  const cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  return cdp;
}

async function openConfirmation({ workerCdp, pageCdp, browserCdp, devToolsPort, tabId, seenPopupIds }) {
  const before = new Set((await targets(devToolsPort)).map(targetIdOf));
  await trustedClick(pageCdp, '[data-agee-proactive="accept"]');
  await waitForEval(workerCdp, `AgeeProactivePrivacy.pendingConfirmationCount() === 1`);
  const popupTarget = await waitForTarget(
    devToolsPort,
    (target) => target.type === "page"
      && target.url.includes("/proactive-confirm.html#pc_")
      && !before.has(targetIdOf(target))
      && !seenPopupIds.has(targetIdOf(target)),
  );
  seenPopupIds.add(targetIdOf(popupTarget));
  const popupCdp = await attachPage(popupTarget);
  await browserCdp.send("Target.activateTarget", { targetId: targetIdOf(popupTarget) });
  await waitForEval(popupCdp, `!document.querySelector("#allow").disabled && document.querySelector("#status").textContent.includes("Nothing has been sent")`);
  return { target: popupTarget, cdp: popupCdp, url: popupTarget.url, tabId };
}

async function confirmationDetails(popupCdp) {
  return evaluate(popupCdp, `(() => ({
    url: document.querySelector("#request-url").textContent,
    method: document.querySelector("#request-method").textContent,
    redirect: document.querySelector("#request-redirect").textContent,
    contentType: document.querySelector("#request-content-type").textContent,
    authorization: document.querySelector("#request-authorization").textContent,
    digest: document.querySelector("#request-digest").textContent,
    bodyText: document.querySelector("#request-body").textContent,
    exclusions: document.querySelector("#request-exclusions").textContent,
    persistence: document.querySelector("#request-persistence").textContent,
    connectivity: document.querySelector("#background-connectivity").textContent,
    boundary: document.querySelector(".boundary").textContent,
    heading: document.querySelector("h1").textContent,
  }))()`);
}

function assertCanonicalConfirmation(details, gatewayUrl, expectedPrompt = TEXT_PROMPT) {
  const body = JSON.parse(details.bodyText);
  const expected = {
    source: "proactive_accept_v1",
    transcript: expectedPrompt,
    modality: "text",
    client: { platform: "browser", source: "agee-extension", input: "text" },
  };
  if (details.url !== `${gatewayUrl}${PROACTIVE_PATH}` || details.method !== "POST") throw new Error(`confirmation URL/method drifted: ${JSON.stringify(details)}`);
  if (details.redirect !== "Blocked (fetch redirect=error)" || details.contentType !== "application/json") throw new Error(`confirmation redirect/content type drifted: ${JSON.stringify(details)}`);
  if (details.authorization !== "configured bearer token (value hidden)") throw new Error("confirmation did not disclose hidden configured authorization");
  if (JSON.stringify(body) !== JSON.stringify(expected)) throw new Error(`confirmation body drifted: ${details.bodyText}`);
  if (details.digest !== sha256(JSON.stringify(expected))) throw new Error(`confirmation body digest drifted: ${details.digest}`);
  for (const required of ["screenshot", "page body", "URL", "title", "form value", "cookie", "history", "selection", "structural count", "action", "task", "workflow", "agent-run"]) {
    if (!details.exclusions.includes(required)) throw new Error(`confirmation exclusions missing ${required}: ${details.exclusions}`);
  }
  for (const required of ["does not add", "conversation", "task", "workflow", "broker", "agent-run storage", "model provider", "data policy"]) {
    if (!details.persistence.includes(required)) throw new Error(`confirmation persistence/retention copy missing ${required}: ${details.persistence}`);
  }
  if (!details.connectivity.includes("DISABLED") || details.boundary !== "EXTENSION-OWNED CONFIRMATION") {
    throw new Error(`confirmation ownership/connectivity drifted: ${JSON.stringify(details)}`);
  }
  assertNoSentinels(details, "extension-owned confirmation");
  return expected;
}

async function closeTarget(browserCdp, devToolsPort, target) {
  const id = targetIdOf(target);
  const result = await browserCdp.send("Target.closeTarget", { targetId: id }).catch(() => ({ success: false }));
  if (result?.success === true) await waitForTargetGone(devToolsPort, id).catch(() => {});
}

async function narrowViewportCheck(pageCdp) {
  await pageCdp.send("Emulation.setDeviceMetricsOverride", { width: 360, height: 800, deviceScaleFactor: 1, mobile: false });
  // Exercise the maximum-width state. Stop is normally conditional on an
  // active run, but its fifth grid track must still fit when visible.
  await evaluate(pageCdp, `document.querySelector("#agee-stop").classList.add("visible"); true`);
  await delay(150);
  const geometry = await evaluate(pageCdp, `(() => {
    const selectors=["#agee-input","#proactiveHelp","#agee-voice","#agee-record","#agee-stop"];
    return {width:innerWidth, controls:selectors.map(selector => { const r=document.querySelector(selector).getBoundingClientRect(); return {selector,left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}; })};
  })()`);
  if (geometry.width !== 360) throw new Error(`narrow viewport did not apply: ${JSON.stringify(geometry)}`);
  for (const control of geometry.controls) {
    if (control.width <= 0 || control.height <= 0 || control.left < -0.5 || control.right > 360.5) throw new Error(`narrow control escaped viewport: ${JSON.stringify(control)}`);
  }
  const ordered = [...geometry.controls].sort((a, b) => a.left - b.left);
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index].left < ordered[index - 1].right - 0.5) throw new Error(`narrow controls overlap: ${JSON.stringify(ordered)}`);
  }
  await evaluate(pageCdp, `document.querySelector("#agee-stop").classList.remove("visible"); true`);
  await pageCdp.send("Emulation.setDeviceMetricsOverride", { width: 1000, height: 900, deviceScaleFactor: 1, mobile: false });
  await delay(150);
}

async function main() {
  mkdirSync(runDir, { recursive: true });
  mkdirSync(profilePath, { recursive: true });
  cpSync(sourceExtensionPath, extensionPath, { recursive: true });
  rmSync(join(extensionPath, "agee.config.json"), { force: true });

  const { server: fixtureServer, port: fixturePort, state: fixtureState } = await serveFixtures();
  const redirectSinkUrl = `http://localhost:${fixturePort}/redirect-received`;
  const { server: stubServer, port: stubPort, state } = await startStubGateway(redirectSinkUrl);
  const gatewayUrl = `http://127.0.0.1:${stubPort}`;
  const fixtureUrl = `http://localhost:${fixturePort}/fixtures/proactive.html`;
  const hostileUrl = `http://localhost:${fixturePort}/fixtures/proactive-hostile.html`;
  const sensitiveUrl = `http://localhost:${fixturePort}/fixtures/proactive-sensitive.html`;
  const checkoutHashUrl = `${fixtureUrl}#/checkout/payment`;
  const chromePath = resolveChromeForTesting();
  const args = quietChromeArgs({ extensionPath, profilePath });
  args.push("--host-resolver-rules=MAP api.agee.app ~NOTFOUND");
  const chrome = spawn(chromePath, args, { stdio: ["ignore", "pipe", "pipe"] });
  chrome.stderr.on("data", (chunk) => { chromeStderr = `${chromeStderr}${chunk}`.slice(-8000); });

  const networkLedger = [];
  const seenPopupIds = new Set();
  let browserCdp;
  let workerCdp;
  let workerTarget;
  let stopPinger = async () => {};
  let pageCdp;
  let pageTargetId = "";

  const attachWorker = async (devToolsPort, excludeId = "") => {
    const target = await waitForTarget(
      devToolsPort,
      (candidate) => candidate.type === "service_worker"
        && candidate.url.endsWith("/background.js")
        && targetIdOf(candidate) !== excludeId,
      15000,
    );
    const cdp = new Cdp(target.webSocketDebuggerUrl);
    attachWorkerNetwork(cdp, `worker-${targetIdOf(target)}`, networkLedger);
    await cdp.send("Network.enable", { maxPostDataSize: 1024 * 1024 });
    await cdp.send("Runtime.enable");
    await waitForEval(cdp, `Boolean(globalThis.AgeeProactivePrivacy)`);
    let alive = true;
    const pinger = (async () => {
      while (alive) {
        await evaluate(cdp, "1").catch(() => {});
        await delay(100);
      }
    })();
    stopPinger = async () => { alive = false; await pinger.catch(() => {}); };
    workerTarget = target;
    workerCdp = cdp;
  };

  const restartWorker = async (devToolsPort) => {
    const old = workerTarget;
    const oldId = targetIdOf(old);
    await stopPinger();
    const stopped = await browserCdp.send("Target.closeTarget", { targetId: oldId });
    if (stopped?.success !== true) throw new Error(`could not stop MV3 worker: ${JSON.stringify(stopped)}`);
    workerCdp.close();
    // Every restart leg deliberately has a live memory-only grant. Its
    // document-scoped 3-second status check is a real extension event that
    // wakes the replacement MV3 worker; no debugger-only production bypass is
    // needed.
    await attachWorker(devToolsPort, oldId);
  };

  try {
    const devToolsPort = Number((await waitForFile(join(profilePath, "DevToolsActivePort"))).split("\n")[0]);
    const browserInfo = await fetch(`http://127.0.0.1:${devToolsPort}/json/version`).then((response) => response.json());
    browserCdp = new Cdp(browserInfo.webSocketDebuggerUrl);
    await attachWorker(devToolsPort);

    const created = await browserCdp.send("Target.createTarget", { url: fixtureUrl });
    pageTargetId = created.targetId;
    const initialPageTarget = await waitForTarget(devToolsPort, (target) => targetIdOf(target) === pageTargetId);
    pageCdp = await attachPage(initialPageTarget);
    await pageCdp.send("Emulation.setDeviceMetricsOverride", { width: 1000, height: 900, deviceScaleFactor: 1, mobile: false });
    await navigate(browserCdp, pageCdp, pageTargetId, fixtureUrl);
    let tabId = await tabIdForPage(workerCdp, fixtureUrl);

    const defaults = await evaluate(workerCdp, `chrome.storage.local.get(["ageeGatewayUrl","ageeBackgroundAutomationEnabled","ageeBackgroundAutomationConsentVersion","ageePrivacyMigrationVersion"])`);
    if (defaults.ageeGatewayUrl) throw new Error(`fresh install persisted an implicit gateway: ${defaults.ageeGatewayUrl}`);
    if (defaults.ageeBackgroundAutomationEnabled !== false || defaults.ageeBackgroundAutomationConsentVersion !== 0 || defaults.ageePrivacyMigrationVersion !== 1) {
      throw new Error(`fresh privacy defaults were not fail-closed: ${JSON.stringify(defaults)}`);
    }

    // Explicitly configure only the throwaway loopback gateway. Its one-time
    // session adoption is allowed here; the following 35-second window must be
    // completely silent and crosses the extension's 30-second alarms.
    await evaluate(workerCdp, `chrome.storage.local.set(${JSON.stringify({
      ageeGatewayUrl: gatewayUrl,
      ageeGatewayToken: TOKEN,
      ageeGatewayUserSet: true,
    })})`);
    await waitFor(() => state.requests.some((request) => request.path === "/v1/sessions/default"), "explicit config session adoption").catch(() => true);
    await delay(400);
    const idleMark = networkMark(networkLedger, state);
    await delay(CONFIGURED_IDLE_MS);
    assertSilentSince(idleMark, networkLedger, state, "configured automation-off 35-second alarm window");

    // Real legacy migration: seed old automation/owner state and alarms, remove
    // the migration marker, stop the actual worker, and start a new worker.
    const migrationMark = networkMark(networkLedger, state);
    await openPanel(workerCdp, pageCdp, tabId);
    await trustedClick(pageCdp, "#proactiveHelp");
    await waitForEval(workerCdp, `AgeeProactivePrivacy.activeGrantCount() === 1`);
    await evaluate(workerCdp, `(async () => {
      await chrome.storage.local.set({
        ageeBackgroundAutomationEnabled: true,
        ageeBackgroundAutomationConsentVersion: 0,
        ageeGatewayUrl: ${JSON.stringify(gatewayUrl)},
        ageeGatewayToken: ${JSON.stringify(TOKEN)},
        ageeGatewayUserSet: true,
        ageeActiveBrowserAgentOwner: {tab_id: 77, cue_id: "preserve-cue", page_url: "https://private.invalid/path", page_title: "PRIVATE OWNER TITLE"},
        ageeActiveCompanionPetCache: {active_companion: {companion_id: "cached-pet", companion_name: "Cached pet", pet: {sprite: {asset_url: ${JSON.stringify(`${gatewayUrl}/companion-tracker`)}}}}}
      });
      await chrome.storage.local.remove("ageePrivacyMigrationVersion");
      chrome.alarms.create("agee-browser-task-poll", {delayInMinutes: 5, periodInMinutes: 5});
      chrome.alarms.create("agee-self-extension-runtime-refresh", {delayInMinutes: 5, periodInMinutes: 5});
      chrome.alarms.create("agee-ui-spec-refresh", {delayInMinutes: 5, periodInMinutes: 5});
      return true;
    })()`);
    await restartWorker(devToolsPort);
    await waitForEval(workerCdp, `Promise.all([
      chrome.storage.local.get(["ageePrivacyMigrationVersion","ageeBackgroundAutomationEnabled","ageeBackgroundAutomationConsentVersion"]),
      chrome.alarms.getAll()
    ]).then(([storage, alarms]) => storage.ageePrivacyMigrationVersion === 1
      && storage.ageeBackgroundAutomationEnabled === false
      && storage.ageeBackgroundAutomationConsentVersion === 0
      && !alarms.some(a => ["agee-browser-task-poll","agee-self-extension-runtime-refresh","agee-ui-spec-refresh"].includes(a.name)))`);
    const migrated = await evaluate(workerCdp, `Promise.all([
      chrome.storage.local.get(["ageePrivacyMigrationVersion","ageeBackgroundAutomationEnabled","ageeBackgroundAutomationConsentVersion","ageeGatewayUrl","ageeGatewayToken","ageeGatewayUserSet","ageeActiveBrowserAgentOwner"]),
      chrome.alarms.getAll()
    ]).then(([storage, alarms]) => ({storage, alarmNames: alarms.map(a => a.name).sort()}))`);
    if (
      migrated.storage.ageePrivacyMigrationVersion !== 1
      || migrated.storage.ageeBackgroundAutomationEnabled !== false
      || migrated.storage.ageeBackgroundAutomationConsentVersion !== 0
      || migrated.storage.ageeGatewayUrl !== gatewayUrl
      || migrated.storage.ageeGatewayToken !== TOKEN
      || migrated.storage.ageeGatewayUserSet !== true
      || migrated.storage.ageeActiveBrowserAgentOwner?.cue_id !== "preserve-cue"
      || Object.hasOwn(migrated.storage.ageeActiveBrowserAgentOwner || {}, "page_url")
      || Object.hasOwn(migrated.storage.ageeActiveBrowserAgentOwner || {}, "page_title")
    ) throw new Error(`legacy migration contract failed: ${JSON.stringify(migrated)}`);
    for (const retired of ["agee-browser-task-poll", "agee-self-extension-runtime-refresh", "agee-ui-spec-refresh"]) {
      if (migrated.alarmNames.includes(retired)) throw new Error(`legacy migration retained alarm ${retired}: ${JSON.stringify(migrated)}`);
    }
    await navigate(browserCdp, pageCdp, pageTargetId, `${fixtureUrl}?cached-companion=1`);
    tabId = await tabIdForPage(workerCdp, `${fixtureUrl}?cached-companion=1`);
    await delay(300);
    if (state.requests.slice(migrationMark.gateway).some((request) => request.path === "/companion-tracker")) {
      throw new Error("cached remote companion image triggered passive page-startup networking");
    }
    assertSilentSince(migrationMark, networkLedger, state, "legacy migration");

    const idempotentBefore = JSON.stringify(migrated);
    const idempotentMark = networkMark(networkLedger, state);
    await waitForEval(pageCdp, `document.querySelector("#agee-proactive-indicator").hidden`, 7000);
    tabId = await tabIdForPage(workerCdp, fixtureUrl);
    await openCard(workerCdp, pageCdp, tabId);
    await restartWorker(devToolsPort);
    const idempotentAfter = await evaluate(workerCdp, `Promise.all([
      chrome.storage.local.get(["ageePrivacyMigrationVersion","ageeBackgroundAutomationEnabled","ageeBackgroundAutomationConsentVersion","ageeGatewayUrl","ageeGatewayToken","ageeGatewayUserSet","ageeActiveBrowserAgentOwner"]),
      chrome.alarms.getAll()
    ]).then(([storage, alarms]) => ({storage, alarmNames: alarms.map(a => a.name).sort()}))`);
    if (JSON.stringify(idempotentAfter) !== idempotentBefore) throw new Error(`migration was not idempotent: ${JSON.stringify({ idempotentBefore, idempotentAfter })}`);
    assertSilentSince(idempotentMark, networkLedger, state, "idempotent migration reload");
    tabId = await tabIdForPage(workerCdp, fixtureUrl);

    // Page-world synthetic clicks are never authority. Open the panel visibly,
    // try a synthetic Local click, and then inspect the <=380px control row.
    await openPanel(workerCdp, pageCdp, tabId);
    const syntheticLocalMark = networkMark(networkLedger, state);
    await evaluate(pageCdp, `document.querySelector("#proactiveHelp").click(); true`);
    await delay(400);
    if ((await evaluate(workerCdp, `AgeeProactivePrivacy.activeGrantCount()`)) !== 0) throw new Error("page-world synthetic Local click created a grant");
    if (!(await evaluate(pageCdp, `document.querySelector("#agee-proactive-indicator").hidden`))) throw new Error("synthetic Local click activated visible indicator");
    assertSilentSince(syntheticLocalMark, networkLedger, state, "synthetic Local click");
    await narrowViewportCheck(pageCdp);

    // Initial client-side hash and password pages are suppressed before any
    // grant. Both legs are network-silent.
    await navigate(browserCdp, pageCdp, pageTargetId, checkoutHashUrl);
    tabId = await tabIdForPage(workerCdp, checkoutHashUrl);
    await openPanel(workerCdp, pageCdp, tabId);
    const hashMark = networkMark(networkLedger, state);
    await trustedClick(pageCdp, "#proactiveHelp");
    await waitForEval(pageCdp, `document.querySelector(".agee-proactive-card").textContent.includes("suppressed")`);
    if ((await evaluate(workerCdp, `AgeeProactivePrivacy.activeGrantCount()`)) !== 0) throw new Error("#/checkout/payment created a grant");
    assertSilentSince(hashMark, networkLedger, state, "initial sensitive hash suppression");

    await navigate(browserCdp, pageCdp, pageTargetId, sensitiveUrl);
    tabId = await tabIdForPage(workerCdp, sensitiveUrl);
    await openPanel(workerCdp, pageCdp, tabId);
    const sensitiveMark = networkMark(networkLedger, state);
    await trustedClick(pageCdp, "#proactiveHelp");
    await waitForEval(pageCdp, `document.querySelector(".agee-proactive-card").textContent.includes("suppressed")`);
    assertSilentSince(sensitiveMark, networkLedger, state, "password suppression");

    // A real trusted Local click and trusted Dismiss expose only structural
    // local state. The copy is scoped to this observation without exposing
    // gateway origin or background-consent state to the hostile host DOM.
    await navigate(browserCdp, pageCdp, pageTargetId, fixtureUrl);
    tabId = await tabIdForPage(workerCdp, fixtureUrl);
    const observeMark = networkMark(networkLedger, state);
    const cardText = await openCard(workerCdp, pageCdp, tabId);
    for (const required of ["Nothing from this local observation has been sent", "exact gateway URL", "shown only in the extension-owned confirmation"]) {
      if (!cardText.includes(required)) throw new Error(`local card copy missing ${required}: ${cardText}`);
    }
    if (cardText.includes(gatewayUrl) || /background connectivity is (?:enabled|disabled)/i.test(cardText)) {
      throw new Error(`host-page card exposed extension configuration: ${cardText}`);
    }
    assertNoSentinels(cardText, "local structural card");
    await evaluate(pageCdp, `document.querySelector('[data-agee-proactive="dismiss"]').click(); true`);
    await delay(200);
    if ((await evaluate(workerCdp, `AgeeProactivePrivacy.activeGrantCount()`)) !== 1) throw new Error("synthetic Dismiss consumed a grant");
    await trustedClick(pageCdp, '[data-agee-proactive="dismiss"]');
    await waitForEval(workerCdp, `AgeeProactivePrivacy.activeGrantCount() === 0`);
    assertSilentSince(observeMark, networkLedger, state, "local observe/card/dismiss");

    // Coexistence: starting a normal explicit typed gateway turn revokes the
    // proactive grant synchronously, before that workflow reaches the network.
    await openCard(workerCdp, pageCdp, tabId);
    const coexistCopy = await evaluate(pageCdp, `document.querySelector(".agee-proactive-card").textContent`);
    if (!coexistCopy.includes("this local observation") || !coexistCopy.includes("shown only in the extension-owned confirmation")) {
      throw new Error(`coexistence copy lost scope/extension-owned connectivity boundary: ${coexistCopy}`);
    }
    const coexistMark = networkMark(networkLedger, state);
    await trustedEnter(pageCdp, "#agee-input", "Say hello from an explicit workflow");
    await waitForEval(workerCdp, `AgeeProactivePrivacy.activeGrantCount() === 0`);
    const revokedObservedAt = Date.now();
    const explicitRequest = await waitFor(
      () => state.requests.slice(coexistMark.gateway).find((request) => request.path === "/v1/voice/turns"),
      "explicit typed workflow request",
    );
    if (explicitRequest.receivedAt < revokedObservedAt) throw new Error(`explicit workflow network preceded observed proactive revocation: ${JSON.stringify({ explicitRequest, revokedObservedAt })}`);
    const coexistGateway = state.requests.slice(coexistMark.gateway);
    const coexistAllowed = new Map([
      ["/v1/voice/turns", "POST"],
      ["/v1/self-extension/runtime", "GET"],
      ["/v1/ui/spec", "GET"],
    ]);
    if (
      coexistGateway.length !== coexistAllowed.size
      || coexistGateway.some((request) => coexistAllowed.get(request.path) !== request.method || request.search !== "")
      || new Set(coexistGateway.map((request) => request.path)).size !== coexistAllowed.size
    ) {
      throw new Error(`normal explicit workflow made unexpected gateway traffic: ${JSON.stringify(coexistGateway)}`);
    }
    const coexistNetwork = externalWorkerEvents(networkLedger.slice(coexistMark.network));
    if (coexistNetwork.some((event) => event.kind.startsWith("websocket"))) throw new Error(`typed coexistence opened a WebSocket: ${JSON.stringify(coexistNetwork)}`);
    const coexistHttp = coexistNetwork.filter((event) => event.kind === "http");
    if (
      coexistHttp.length !== coexistAllowed.size
      || coexistHttp.some((event) => {
        const url = new URL(event.url);
        return url.origin !== gatewayUrl || url.search !== "" || coexistAllowed.get(url.pathname) !== event.method;
      })
      || new Set(coexistHttp.map((event) => new URL(event.url).pathname)).size !== coexistAllowed.size
    ) {
      throw new Error(`normal explicit workflow made unexpected service-worker traffic: ${JSON.stringify(coexistNetwork)}`);
    }

    // Hash navigation after a grant, a top-level document replacement with a
    // pending popup, and stale-token reuse all revoke authority without traffic.
    await openCard(workerCdp, pageCdp, tabId);
    const hashNavigationMark = networkMark(networkLedger, state);
    await evaluate(pageCdp, `location.hash="ordinary-navigation"; true`);
    await waitForEval(workerCdp, `AgeeProactivePrivacy.activeGrantCount() === 0`);
    assertSilentSince(hashNavigationMark, networkLedger, state, "hash navigation revocation");

    await navigate(browserCdp, pageCdp, pageTargetId, `${fixtureUrl}?stale-document=before`);
    tabId = await tabIdForPage(workerCdp, fixtureUrl);
    await openCard(workerCdp, pageCdp, tabId);
    const staleMark = networkMark(networkLedger, state);
    const stalePopup = await openConfirmation({ workerCdp, pageCdp, browserCdp, devToolsPort, tabId, seenPopupIds });
    const staleUrl = stalePopup.url;
    const staleDocumentId = await evaluate(workerCdp, `chrome.scripting.executeScript({target:{tabId:${Number(tabId)}},func:()=>true}).then(results => results.find(result => result.frameId === 0)?.documentId || "")`);
    if (!staleDocumentId) throw new Error("could not capture old top-frame document id for stale-target test");
    await navigate(browserCdp, pageCdp, pageTargetId, `${fixtureUrl}?stale-document=after`);
    await waitForEval(workerCdp, `AgeeProactivePrivacy.activeGrantCount() === 0 && AgeeProactivePrivacy.pendingConfirmationCount() === 0`);
    const staleTargetResult = await evaluate(workerCdp, `chrome.tabs.sendMessage(
      ${Number(tabId)},
      {cmd:"proactiveSensitivityCheck"},
      {documentId:${JSON.stringify(staleDocumentId)},frameId:0}
    ).then(value => ({delivered:true,value})).catch(error => ({delivered:false,error:String(error?.message || error)}))`);
    if (staleTargetResult.delivered) throw new Error(`message targeted at replaced document was delivered: ${JSON.stringify(staleTargetResult)}`);
    await waitForTargetGone(devToolsPort, targetIdOf(stalePopup.target)).catch(() => {});
    stalePopup.cdp.close();
    const reopened = await browserCdp.send("Target.createTarget", { url: staleUrl });
    const reopenedTarget = await waitForTarget(devToolsPort, (target) => targetIdOf(target) === reopened.targetId);
    const reopenedCdp = await attachPage(reopenedTarget);
    await waitForEval(reopenedCdp, `document.querySelector("#status").classList.contains("error")`);
    if (!(await evaluate(reopenedCdp, `document.querySelector("#allow").disabled`))) throw new Error("stale confirmation token re-enabled Allow");
    await evaluate(reopenedCdp, `document.querySelector("#allow").click(); true`);
    await closeTarget(browserCdp, devToolsPort, reopenedTarget);
    reopenedCdp.close();
    assertSilentSince(staleMark, networkLedger, state, "stale document and token invalidation");

    // Closing a pending confirmation consumes its token. A separately tested
    // trusted Cancel also sends nothing.
    tabId = await tabIdForPage(workerCdp, fixtureUrl);
    await openCard(workerCdp, pageCdp, tabId);
    const closeMark = networkMark(networkLedger, state);
    const closePopup = await openConfirmation({ workerCdp, pageCdp, browserCdp, devToolsPort, tabId, seenPopupIds });
    const closedTokenUrl = closePopup.url;
    await closeTarget(browserCdp, devToolsPort, closePopup.target);
    closePopup.cdp.close();
    await waitForEval(workerCdp, `AgeeProactivePrivacy.pendingConfirmationCount() === 0 && AgeeProactivePrivacy.activeGrantCount() === 0`);
    const tokenRetry = await browserCdp.send("Target.createTarget", { url: closedTokenUrl });
    const tokenRetryTarget = await waitForTarget(devToolsPort, (target) => targetIdOf(target) === tokenRetry.targetId);
    const tokenRetryCdp = await attachPage(tokenRetryTarget);
    await waitForEval(tokenRetryCdp, `document.querySelector("#status").classList.contains("error")`);
    if (!(await evaluate(tokenRetryCdp, `document.querySelector("#allow").disabled`))) throw new Error("closed popup token was reusable");
    await closeTarget(browserCdp, devToolsPort, tokenRetryTarget);
    tokenRetryCdp.close();
    assertSilentSince(closeMark, networkLedger, state, "confirmation close/token invalidation");

    await openCard(workerCdp, pageCdp, tabId);
    const cancelMark = networkMark(networkLedger, state);
    const cancelPopup = await openConfirmation({ workerCdp, pageCdp, browserCdp, devToolsPort, tabId, seenPopupIds });
    await evaluate(cancelPopup.cdp, `document.querySelector("#cancel").click(); true`);
    await delay(200);
    if ((await evaluate(workerCdp, `AgeeProactivePrivacy.pendingConfirmationCount()`)) !== 1) throw new Error("synthetic popup Cancel consumed confirmation");
    await trustedClick(cancelPopup.cdp, "#cancel");
    await waitForEval(workerCdp, `AgeeProactivePrivacy.pendingConfirmationCount() === 0 && AgeeProactivePrivacy.activeGrantCount() === 0`);
    cancelPopup.cdp.close();
    assertSilentSince(cancelMark, networkLedger, state, "trusted confirmation cancel");

    // Hostile page CSS/DOM rewrites the injected preview and programmatically
    // clicks Local/Review. Neither synthetic click authorizes anything. The
    // extension-owned popup remains canonical and only its trusted Allow emits
    // one exact POST.
    await navigate(browserCdp, pageCdp, pageTargetId, hostileUrl);
    tabId = await tabIdForPage(workerCdp, hostileUrl);
    await openPanel(workerCdp, pageCdp, tabId);
    const hostileMark = networkMark(networkLedger, state);
    await waitForEval(pageCdp, `window.__hostileProactiveAttack?.syntheticLocalClicks > 0`);
    await delay(250);
    if ((await evaluate(workerCdp, `AgeeProactivePrivacy.activeGrantCount()`)) !== 0) throw new Error("hostile synthetic Local click created authority");
    await trustedClick(pageCdp, "#proactiveHelp");
    await waitForEval(pageCdp, `window.__hostileProactiveAttack?.previewRewrites > 0 && window.__hostileProactiveAttack?.syntheticReviewClicks > 0`);
    await delay(250);
    if ((await evaluate(workerCdp, `AgeeProactivePrivacy.pendingConfirmationCount()`)) !== 0) throw new Error("hostile synthetic Review click opened confirmation");
    assertSilentSince(hostileMark, networkLedger, state, "hostile page synthetic attacks");
    const hostilePopup = await openConfirmation({ workerCdp, pageCdp, browserCdp, devToolsPort, tabId, seenPopupIds });
    const hostileDetails = await confirmationDetails(hostilePopup.cdp);
    assertCanonicalConfirmation(hostileDetails, gatewayUrl);
    const hostileAllowMark = networkMark(networkLedger, state);
    await evaluate(hostilePopup.cdp, `document.querySelector("#allow").click(); true`);
    await delay(300);
    assertSilentSince(hostileAllowMark, networkLedger, state, "synthetic extension-popup Allow");
    await trustedClick(hostilePopup.cdp, "#allow");
    await waitFor(() => state.requests.slice(hostileAllowMark.gateway).filter((request) => request.path === PROACTIVE_PATH).length === 1, "trusted popup proactive POST");
    await assertExactProactiveTraffic(hostileAllowMark, networkLedger, state, gatewayUrl, 1);
    await waitForEval(hostilePopup.cdp, `document.querySelector("#status").classList.contains("success")`);
    await closeTarget(browserCdp, devToolsPort, hostilePopup.target);
    hostilePopup.cdp.close();

    // Both redirect-preserving status codes are rejected cross-origin. The
    // approved origin sees exactly one POST; the redirect sink sees none.
    await navigate(browserCdp, pageCdp, pageTargetId, fixtureUrl);
    tabId = await tabIdForPage(workerCdp, fixtureUrl);
    for (const code of [307, 308]) {
      await openCard(workerCdp, pageCdp, tabId);
      const popup = await openConfirmation({ workerCdp, pageCdp, browserCdp, devToolsPort, tabId, seenPopupIds });
      assertCanonicalConfirmation(await confirmationDetails(popup.cdp), gatewayUrl);
      state.redirectCodes.push(code);
      const redirectMark = networkMark(networkLedger, state);
      const sinkBefore = fixtureState.requests.filter((request) => request.path === "/redirect-received").length;
      await trustedClick(popup.cdp, "#allow");
      await waitFor(() => state.requests.slice(redirectMark.gateway).filter((request) => request.path === PROACTIVE_PATH).length === 1, `${code} proactive request`);
      await delay(300);
      await assertExactProactiveTraffic(redirectMark, networkLedger, state, gatewayUrl, 1);
      const sinkAfter = fixtureState.requests.filter((request) => request.path === "/redirect-received").length;
      if (sinkAfter !== sinkBefore) throw new Error(`proactive fetch followed ${code} redirect`);
      await waitForEval(popup.cdp, `document.querySelector("#status").classList.contains("error")`);
      await closeTarget(browserCdp, devToolsPort, popup.target);
      popup.cdp.close();
    }

    // Two concurrent final decisions for one immutable token cannot double
    // spend it, even when sent directly from the legitimate extension page.
    await openCard(workerCdp, pageCdp, tabId);
    const concurrencyPopup = await openConfirmation({ workerCdp, pageCdp, browserCdp, devToolsPort, tabId, seenPopupIds });
    const concurrencyMark = networkMark(networkLedger, state);
    const decisionResults = await evaluate(concurrencyPopup.cdp, `Promise.all([
      chrome.runtime.sendMessage({cmd:"proactiveConfirmationDecision", token:location.hash.slice(1), decision:"allow"}),
      chrome.runtime.sendMessage({cmd:"proactiveConfirmationDecision", token:location.hash.slice(1), decision:"allow"})
    ])`);
    await waitFor(() => state.requests.slice(concurrencyMark.gateway).filter((request) => request.path === PROACTIVE_PATH).length === 1, "concurrent final decision POST");
    await assertExactProactiveTraffic(concurrencyMark, networkLedger, state, gatewayUrl, 1);
    if (decisionResults.filter((result) => result?.ok).length !== 1 || decisionResults.filter((result) => !result?.ok).length !== 1) {
      throw new Error(`concurrent final decisions were not one-shot: ${JSON.stringify(decisionResults)}`);
    }
    await closeTarget(browserCdp, devToolsPort, concurrencyPopup.target);
    concurrencyPopup.cdp.close();

    // Protocol scanner: action-shaped null keys are violations, exceeding the
    // bounded scan is fail-closed, and two simultaneous receipts are preserved.
    const receiptsBefore = await evaluate(workerCdp, `chrome.storage.local.get({ageeProactiveRefusalReceipts:[]}).then(v => v.ageeProactiveRefusalReceipts.length)`);
    await openCard(workerCdp, pageCdp, tabId);
    const nullPopup = await openConfirmation({ workerCdp, pageCdp, browserCdp, devToolsPort, tabId, seenPopupIds });
    state.proactiveResponses.push({ ...validProactiveResponse("must be refused"), nested: { deeper: { action: null } } });
    const nullMark = networkMark(networkLedger, state);
    await trustedClick(nullPopup.cdp, "#allow");
    await waitFor(() => state.requests.slice(nullMark.gateway).filter((request) => request.path === PROACTIVE_PATH).length === 1, "nested-null response");
    await assertExactProactiveTraffic(nullMark, networkLedger, state, gatewayUrl, 1);
    await waitForEval(workerCdp, `chrome.storage.local.get({ageeProactiveRefusalReceipts:[]}).then(v => v.ageeProactiveRefusalReceipts.length === ${receiptsBefore + 1})`);
    const nullReceipt = await evaluate(workerCdp, `chrome.storage.local.get({ageeProactiveRefusalReceipts:[]}).then(v => v.ageeProactiveRefusalReceipts.at(-1))`);
    if (nullReceipt.proposal_count !== 1 || nullReceipt.scan_truncated !== false || nullReceipt.reason !== "proactive_text_only_action_protocol_violation") {
      throw new Error(`nested-null scanner receipt drifted: ${JSON.stringify(nullReceipt)}`);
    }
    await closeTarget(browserCdp, devToolsPort, nullPopup.target);
    nullPopup.cdp.close();

    await openCard(workerCdp, pageCdp, tabId);
    const overflowPopup = await openConfirmation({ workerCdp, pageCdp, browserCdp, devToolsPort, tabId, seenPopupIds });
    let overflowPayload = { safe: "bounded overflow" };
    for (let depth = 0; depth < 9; depth += 1) overflowPayload = { nested: overflowPayload };
    state.proactiveResponses.push({ ...validProactiveResponse("must be refused"), overflow: overflowPayload });
    const overflowMark = networkMark(networkLedger, state);
    await trustedClick(overflowPopup.cdp, "#allow");
    await waitFor(() => state.requests.slice(overflowMark.gateway).filter((request) => request.path === PROACTIVE_PATH).length === 1, "overflow response");
    await assertExactProactiveTraffic(overflowMark, networkLedger, state, gatewayUrl, 1);
    await waitForEval(workerCdp, `chrome.storage.local.get({ageeProactiveRefusalReceipts:[]}).then(v => v.ageeProactiveRefusalReceipts.length === ${receiptsBefore + 2})`);
    const overflowReceipt = await evaluate(workerCdp, `chrome.storage.local.get({ageeProactiveRefusalReceipts:[]}).then(v => v.ageeProactiveRefusalReceipts.at(-1))`);
    if (overflowReceipt.scan_truncated !== true) throw new Error(`overflow scan was not fail-closed: ${JSON.stringify(overflowReceipt)}`);
    await closeTarget(browserCdp, devToolsPort, overflowPopup.target);
    overflowPopup.cdp.close();

    const secondCreated = await browserCdp.send("Target.createTarget", { url: fixtureUrl });
    const secondTarget = await waitForTarget(devToolsPort, (target) => targetIdOf(target) === secondCreated.targetId);
    const secondPageCdp = await attachPage(secondTarget);
    await secondPageCdp.send("Emulation.setDeviceMetricsOverride", { width: 1000, height: 900, deviceScaleFactor: 1, mobile: false });
    await waitForEval(secondPageCdp, `Boolean(document.querySelector("#proactiveHelp"))`);
    const secondTabId = await evaluate(workerCdp, `chrome.tabs.query({}).then(tabs => tabs.find(tab => tab.id !== ${Number(tabId)} && String(tab.url || "").startsWith(${JSON.stringify(new URL(fixtureUrl).origin)}))?.id || 0)`);
    await browserCdp.send("Target.activateTarget", { targetId: pageTargetId });
    await openCard(workerCdp, pageCdp, tabId);
    await browserCdp.send("Target.activateTarget", { targetId: targetIdOf(secondTarget) });
    await openCard(workerCdp, secondPageCdp, secondTabId);
    const receiptPopupA = await openConfirmation({ workerCdp, pageCdp, browserCdp, devToolsPort, tabId, seenPopupIds });
    const receiptPopupB = await openConfirmation({ workerCdp, pageCdp: secondPageCdp, browserCdp, devToolsPort, tabId: secondTabId, seenPopupIds });
    state.proactiveResponses.push(
      { delayMs: 300, payload: { ...validProactiveResponse("refuse A"), proposal: null } },
      { delayMs: 300, payload: { ...validProactiveResponse("refuse B"), action: null } },
    );
    const receiptConcurrentMark = networkMark(networkLedger, state);
    await trustedClick(receiptPopupA.cdp, "#allow");
    await trustedClick(receiptPopupB.cdp, "#allow");
    await waitFor(() => state.requests.slice(receiptConcurrentMark.gateway).filter((request) => request.path === PROACTIVE_PATH).length === 2, "concurrent refusal requests");
    await assertExactProactiveTraffic(receiptConcurrentMark, networkLedger, state, gatewayUrl, 2);
    await waitForEval(workerCdp, `chrome.storage.local.get({ageeProactiveRefusalReceipts:[]}).then(v => v.ageeProactiveRefusalReceipts.length === ${receiptsBefore + 4})`);
    const concurrentReceipts = await evaluate(workerCdp, `chrome.storage.local.get({ageeProactiveRefusalReceipts:[]}).then(v => v.ageeProactiveRefusalReceipts.slice(-2))`);
    if (concurrentReceipts.length !== 2 || new Set(concurrentReceipts.map((receipt) => receipt.receipt_id)).size !== 2) {
      throw new Error(`concurrent refusal receipts were lost or duplicated: ${JSON.stringify(concurrentReceipts)}`);
    }
    for (const receipt of concurrentReceipts) {
      if (receipt.reason !== "proactive_text_only_action_protocol_violation" || receipt.proposal_count !== 1) throw new Error(`concurrent refusal receipt drifted: ${JSON.stringify(receipt)}`);
    }
    await closeTarget(browserCdp, devToolsPort, receiptPopupA.target);
    await closeTarget(browserCdp, devToolsPort, receiptPopupB.target);
    receiptPopupA.cdp.close();
    receiptPopupB.cdp.close();
    await closeTarget(browserCdp, devToolsPort, secondTarget);
    secondPageCdp.close();

    // A genuine worker restart erases the final memory-only grant and content's
    // status check clears its indicator. This last leg is network-silent.
    await browserCdp.send("Target.activateTarget", { targetId: pageTargetId });
    await openCard(workerCdp, pageCdp, tabId);
    const restartMark = networkMark(networkLedger, state);
    await restartWorker(devToolsPort);
    await waitForEval(workerCdp, `AgeeProactivePrivacy.activeGrantCount() === 0`);
    await waitForEval(pageCdp, `document.querySelector("#agee-proactive-indicator").hidden`, 7000);
    assertSilentSince(restartMark, networkLedger, state, "service-worker restart invalidation");

    if (networkLedger.some((event) => event.kind.startsWith("websocket"))) {
      throw new Error(`service-worker opened unexpected WebSocket anywhere in privacy smoke: ${JSON.stringify(networkLedger.filter((event) => event.kind.startsWith("websocket")))}`);
    }

    console.log(
      `Proactive privacy smoke passed (REAL extension, throwaway profile): service-worker CDP captured every observed requestWillBeSent plus WebSocket create/handshake event with full URL/headers; configured automation-off startup stayed externally silent for ${CONFIGURED_IDLE_MS / 1000}s${CONFIGURED_IDLE_MS >= 30000 ? " across 30s alarms" : " (fast harness mode)"}; real legacy migration reset consent/automation, scrubbed owner page identity, preserved credentials, cleared alarms, and was reload-idempotent; page-world synthetic Local/Review/Cancel/Allow clicks sent nothing; sensitive password and initial #/checkout/payment routes, hash/top-level document changes, stale/closed tokens, trusted Cancel, and worker restart were externally silent; <=380px controls stayed in bounds; normal explicit workflow revoked a live grant before its network request; hostile page CSS/DOM changed only the non-authoritative preview; extension-owned confirmation showed the exact /v1/proactive/turns POST/body/SHA-256/redirect/retention/exclusions contract; trusted Allow sent one exact <=512-byte text-only request; 307/308 cross-origin redirects were blocked; same-token concurrent final decisions emitted once; nested-null/overflow scanner failures and concurrent bounded refusal receipts passed.`,
    );
  } finally {
    await stopPinger().catch(() => {});
    pageCdp?.close();
    workerCdp?.close();
    browserCdp?.close();
    fixtureServer.close();
    stubServer.close();
    chrome.kill("SIGTERM");
    await delay(250);
    rmSync(runDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  if (chromeStderr.trim()) console.error(`Chrome stderr tail:\n${chromeStderr.trim()}`);
  process.exit(1);
});
