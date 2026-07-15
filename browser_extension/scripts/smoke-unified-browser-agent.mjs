// Quiet headless smoke for the unified browser-agent turn path.
//
// Loads the REAL extension in Chrome for Testing, points it at a throwaway local
// gateway, and proves modern page/current-page turns send their snapshot and
// optional screenshot in the initial /v1/browser/turns request. A second leg
// preserves the older needs_evidence negotiation. The fake gateway returns an
// inert action proposal; the smoke confirms the page was not acted on.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { resolveChromeForTesting, quietChromeArgs } from "./chrome-for-testing.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const extensionPath = join(root, "extension");
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const runDir = join(root, ".gstack", "background-qa", `unified-browser-agent-${runId}`);
const profilePath = join(runDir, "chrome-profile");
const TOKEN = "unified-browser-agent-smoke-token";
const MAX_SCREENSHOT_BASE64_CHARS = 420 * 1024;

let latestChromeStderr = "";

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function waitForFile(path, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (existsSync(path)) return readFileSync(path, "utf8");
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${path}`);
}

function readBody(req) {
  return new Promise((resolveBody) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        resolveBody(body ? JSON.parse(body) : {});
      } catch {
        resolveBody({ __invalidJson: body });
      }
    });
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function serve() {
  const calls = [];
  let evidenceSeq = 0;
  let turnSeq = 0;
  const turnById = new Map();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname === "/health") {
      sendJson(res, 200, { ok: true, provider: "smoke" });
      return;
    }
    if (url.pathname.startsWith("/v1/")) {
      const auth = req.headers.authorization || "";
      if (auth !== `Bearer ${TOKEN}`) {
        sendJson(res, 401, { error: "bad token" });
        return;
      }
    }
    if (req.method === "POST" && url.pathname === "/v1/browser/evidence") {
      const body = await readBody(req);
      if (!body.turn_id || !body.evidence_request_id) {
        sendJson(res, 400, { error: "turn_id and evidence_request_id are required" });
        return;
      }
      evidenceSeq += 1;
      const id = `evidence-${evidenceSeq}`;
      calls.push({ method: req.method, path: url.pathname, body });
      const turn = turnById.get(body.turn_id) || {};
      turn.evidence_id = id;
      turn.evidence = body;
      turnById.set(body.turn_id, turn);
      sendJson(res, 202, {
        id: body.turn_id,
        turn_id: body.turn_id,
        evidence: { id },
        status: "pending",
        status_url: `/v1/browser/turns/${body.turn_id}/status`,
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/browser/turns") {
      const body = await readBody(req);
      turnSeq += 1;
      const id = `turn-${turnSeq}`;
      calls.push({ method: req.method, path: url.pathname, body });
      turnById.set(id, body);
      if (turnSeq === 1) {
        sendJson(res, 200, {
          id,
          status: "completed",
          text: `Unified browser turn answer: ${body.instruction || body.transcript || "page"}`,
          actions: [{ action: "click", index: 0, reason: "inert proposal smoke" }],
        });
        return;
      }
      sendJson(res, 202, {
        id,
        status: "needs_evidence",
        evidence_request_ids: [`evreq-${turnSeq}`],
        status_url: `/v1/browser/turns/${id}/status`,
      });
      return;
    }
    const statusMatch = url.pathname.match(/^\/v1\/browser\/turns\/([^/]+)\/status$/);
    if (req.method === "GET" && statusMatch) {
      const id = decodeURIComponent(statusMatch[1]);
      const body = turnById.get(id) || {};
      calls.push({ method: req.method, path: url.pathname, id });
      if (!body.evidence_id) {
        sendJson(res, 200, {
          id,
          status: "needs_evidence",
          evidence_request_ids: [`evreq-${id.replace(/\D/g, "") || "1"}`],
          text: "Waiting for browser evidence.",
        });
        return;
      }
      sendJson(res, 200, {
        id,
        status: "done",
        text: `Unified browser turn answer: ${body.instruction || body.transcript || "page"}`,
        actions: [{ action: "click", index: 0, reason: "inert proposal smoke" }],
      });
      return;
    }
    if (url.pathname === "/v1/voice/turns") {
      const body = await readBody(req);
      calls.push({ method: req.method, path: url.pathname, body });
      sendJson(res, 500, { error: "page-context turns must not use /v1/voice/turns" });
      return;
    }

    const path = url.pathname === "/" ? "/fixtures/demo.html" : url.pathname;
    const file = join(root, path.replace(/^\/+/, ""));
    try {
      const body = readFileSync(file);
      res.writeHead(200, { "content-type": file.endsWith(".html") ? "text/html" : "text/plain" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  });
  return new Promise((resolveServer) => {
    server.listen(0, "localhost", () => {
      const address = server.address();
      resolveServer({ server, port: address.port, calls });
    });
  });
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
      const msg = JSON.parse(event.data);
      if (msg.method) {
        const handlers = this.listeners.get(msg.method);
        if (handlers) for (const handler of handlers) handler(msg.params);
        return;
      }
      if (!msg.id || !this.pending.has(msg.id)) return;
      const { resolveCall, rejectCall } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) rejectCall(new Error(`${msg.error.message}: ${msg.error.data || ""}`));
      else resolveCall(msg.result);
    };
  }

  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(handler);
  }

  async send(method, params = {}) {
    await this.ready;
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolveCall, rejectCall) => {
      this.pending.set(id, { resolveCall, rejectCall });
    });
  }

  close() {
    this.ws.close();
  }
}

async function targets(port) {
  return fetch(`http://127.0.0.1:${port}/json/list`).then((resp) => resp.json());
}

async function waitForTarget(port, predicate, timeoutMs = 15000) {
  const started = Date.now();
  let lastTargets = [];
  while (Date.now() - started < timeoutMs) {
    lastTargets = await targets(port);
    const found = lastTargets.find(predicate);
    if (found) return found;
    await delay(200);
  }
  throw new Error(`Timed out waiting for Chrome target. Last targets: ${JSON.stringify(lastTargets.map((target) => ({
    type: target.type,
    title: target.title,
    url: target.url,
  })), null, 2)}`);
}

async function evaluate(cdp, expression, { contextId } = {}) {
  const params = { expression, awaitPromise: true, returnByValue: true };
  if (contextId != null) params.contextId = contextId;
  const result = await cdp.send("Runtime.evaluate", params);
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || result.exceptionDetails.exception?.description || "Runtime evaluation failed");
  }
  return result.result.value;
}

async function waitForEval(cdp, expression, timeoutMs = 12000, opts = {}) {
  const started = Date.now();
  let lastValue;
  while (Date.now() - started < timeoutMs) {
    lastValue = await evaluate(cdp, expression, opts).catch(() => undefined);
    if (lastValue) return lastValue;
    await delay(150);
  }
  throw new Error(`Timed out waiting for expression: ${expression}; last=${JSON.stringify(lastValue)}`);
}

async function waitForCondition(predicate, timeoutMs = 12000, label = "condition") {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await delay(150);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function resolveContentContext(pageCdp, isolatedContexts) {
  for (const candidate of isolatedContexts) {
    const isOverlay = await evaluate(
      pageCdp,
      `Boolean(window.__ageeLoaded && typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage)`,
      { contextId: candidate },
    ).catch(() => false);
    if (isOverlay) return candidate;
  }
  throw new Error(`could not resolve the overlay isolated execution context (candidates: ${isolatedContexts.length})`);
}

function installProgressRecorderExpr() {
  return `
    (() => {
      window.__ageeProgressTexts = [];
      const remember = () => {
        const texts = [...document.querySelectorAll(".agee-cue-status, .agee-row")]
          .map((node) => (node.textContent || "").trim())
          .filter(Boolean);
        for (const text of texts) {
          if (!window.__ageeProgressTexts.includes(text)) window.__ageeProgressTexts.push(text);
        }
      };
      const log = document.querySelector("#agee-log");
      if (window.__ageeProgressObserver) window.__ageeProgressObserver.disconnect();
      window.__ageeProgressObserver = new MutationObserver(remember);
      if (log) window.__ageeProgressObserver.observe(log, { childList: true, subtree: true, characterData: true });
      remember();
      return true;
    })()
  `;
}

function submitTypedExpr(instruction) {
  return `
    (() => {
      const input = document.querySelector("#agee-input");
      if (!input) return false;
      input.value = ${JSON.stringify(instruction)};
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      return true;
    })()
  `;
}

function latestResultExpr() {
  return `
    (() => {
      const log = document.querySelector("#agee-log");
      const input = document.querySelector("#agee-input");
      const terminal = [...document.querySelectorAll(".agee-cue-done, .agee-cue-error, .agee-done, .agee-error")].pop();
      return terminal ? {
        kind: terminal.classList.contains("agee-cue-error") || terminal.classList.contains("agee-error") ? "error" : "done",
        text: terminal.textContent || "",
        draft: input ? input.value : "",
        logVisible: log ? getComputedStyle(log).display !== "none" : false,
        progress: window.__ageeProgressTexts || [],
        pageResult: document.querySelector("#results")?.textContent || "",
      } : null;
    })()
  `;
}

async function main() {
  const chromePath = resolveChromeForTesting();
  const gateway = await serve();
  mkdirSync(profilePath, { recursive: true });
  const baseUrl = `http://localhost:${gateway.port}`;
  const demoUrl = `${baseUrl}/fixtures/demo.html`;

  console.log("agee unified browser-agent smoke (REAL extension + fake gateway, headless)");
  console.log(`  gateway: ${baseUrl}`);

  const chrome = spawn(chromePath, quietChromeArgs({ extensionPath, profilePath }), {
    stdio: ["ignore", "pipe", "pipe"],
  });
  chrome.stderr.on("data", (chunk) => {
    latestChromeStderr += chunk.toString();
    latestChromeStderr = latestChromeStderr.slice(-4000);
  });

  let browserCdp;
  let workerCdp;
  let pageCdp;
  try {
    const devToolsPort = Number((await waitForFile(join(profilePath, "DevToolsActivePort"))).split("\n")[0]);
    const workerTarget = await waitForTarget(
      devToolsPort,
      (target) => target.type === "service_worker" && /^chrome-extension:\/\/[a-p]+\/background\.js$/.test(target.url || ""),
    );
    if (latestChromeStderr.includes("--load-extension is not allowed")) {
      throw new Error("The resolved Chrome refused --load-extension. Point AGEE_CHROME_PATH at Chrome for Testing.");
    }
    const extensionId = workerTarget.url.match(/^chrome-extension:\/\/([a-p]+)\//)[1];

    const browserInfo = await fetch(`http://127.0.0.1:${devToolsPort}/json/version`).then((resp) => resp.json());
    browserCdp = new Cdp(browserInfo.webSocketDebuggerUrl);
    const { targetId } = await browserCdp.send("Target.createTarget", { url: "about:blank" });
    const pageTarget = await waitForTarget(devToolsPort, (target) => target.type === "page" && target.id === targetId);

    pageCdp = new Cdp(pageTarget.webSocketDebuggerUrl);
    const isolatedContexts = [];
    pageCdp.on("Runtime.executionContextCreated", ({ context }) => {
      const aux = context.auxData || {};
      if (aux.type === "isolated" || context.name) isolatedContexts.push(context.id);
    });
    await pageCdp.send("Runtime.enable");
    await pageCdp.send("Page.enable");
    await pageCdp.send("Page.navigate", { url: demoUrl });
    await waitForEval(pageCdp, `location.href.startsWith(${JSON.stringify(demoUrl)}) && document.readyState === "complete"`);

    workerCdp = new Cdp(workerTarget.webSocketDebuggerUrl);
    await workerCdp.send("Runtime.enable");
    const tabId = await waitForEval(workerCdp, `
      (async () => {
        const [tab] = await chrome.tabs.query({ url: "http://localhost/*" });
        if (!tab) return null;
        try {
          const res = await chrome.tabs.sendMessage(tab.id, { cmd: "ping" });
          return res?.ok ? tab.id : null;
        } catch { return null; }
      })()
    `);
    if (!tabId) throw new Error("real content script did not answer ping");

    await evaluate(workerCdp, `
      chrome.storage.local.set({
        ageeGatewayUrl: ${JSON.stringify(baseUrl)},
        ageeGatewayToken: ${JSON.stringify(TOKEN)},
        ageeApiKey: ""
      })
    `);
    await evaluate(workerCdp, `chrome.tabs.sendMessage(${tabId}, { cmd: "open" })`);
    await waitForEval(pageCdp, `Boolean(document.querySelector("#agee-input"))`);
    const contentCtx = await resolveContentContext(pageCdp, isolatedContexts);
    await evaluate(pageCdp, `
      (() => {
        const select = document.querySelector("#agee-mode-select");
        if (!select) return false;
        select.value = "help";
        select.dispatchEvent(new Event("change", { bubbles: true }));
        return select.value === "help";
      })()
    `, { contextId: contentCtx });

    await evaluate(pageCdp, installProgressRecorderExpr(), { contextId: contentCtx });
    await evaluate(pageCdp, submitTypedExpr("summarize this page"), { contextId: contentCtx });
    const typed = await waitForEval(pageCdp, latestResultExpr(), 20000, { contextId: contentCtx });
    if (typed.kind !== "done" || !typed.text.includes("Unified browser turn answer")) {
      throw new Error(`typed page-context turn did not render answer: ${JSON.stringify(typed)}`);
    }
    for (const state of ["collecting page context", "capturing screenshot", "sending to gateway", "waiting for answer"]) {
      if (!typed.progress.some((text) => text.includes(state))) {
        throw new Error(`missing progress state "${state}": ${JSON.stringify(typed.progress)}`);
      }
    }
    if (!typed.text.includes("not executed in this slice")) {
      throw new Error(`action proposal was not rendered as inert: ${JSON.stringify(typed)}`);
    }
    if (typed.pageResult !== "No search yet.") {
      throw new Error(`gateway action proposal was executed unexpectedly: ${JSON.stringify(typed)}`);
    }

    await evaluate(pageCdp, installProgressRecorderExpr(), { contextId: contentCtx });
    await evaluate(pageCdp, `chrome.runtime.sendMessage({ cmd: "describe", cueId: "describe-smoke" }).catch(() => {}); true;`, { contextId: contentCtx });
    await waitForCondition(
      () => gateway.calls.filter((call) => call.path === "/v1/browser/turns").length >= 2,
      20000,
      "describe browser turn call",
    );
    await waitForCondition(
      () => gateway.calls.filter((call) => /^\/v1\/browser\/turns\/turn-\d+\/status$/.test(call.path)).length >= 1,
      20000,
      "describe browser turn status poll",
    );

    const evidenceCalls = gateway.calls.filter((call) => call.path === "/v1/browser/evidence");
    const turnCalls = gateway.calls.filter((call) => call.path === "/v1/browser/turns");
    const voiceCalls = gateway.calls.filter((call) => call.path === "/v1/voice/turns");
    if (evidenceCalls.length !== 1 || turnCalls.length !== 2) {
      throw new Error(`expected one modern turn leg and one legacy evidence leg: ${JSON.stringify(gateway.calls)}`);
    }
    if (voiceCalls.length) {
      throw new Error(`page-context turns incorrectly used /v1/voice/turns: ${JSON.stringify(voiceCalls)}`);
    }
    for (const call of turnCalls) {
      const screenshot = call.body.screenshot;
      if (!("screenshot" in call.body) || (screenshot !== null && typeof screenshot !== "object")) {
        throw new Error(`initial browser turn did not include optional screenshot status: ${JSON.stringify(call.body)}`);
      }
      if (screenshot?.encoding === "base64" && String(screenshot.data || "").length > MAX_SCREENSHOT_BASE64_CHARS) {
        throw new Error(`inline screenshot exceeded cap: ${String(screenshot.data || "").length}`);
      }
      if (screenshot?.encoding === "omitted" && screenshot.data) {
        throw new Error(`omitted screenshot still included base64 data: ${JSON.stringify(screenshot)}`);
      }
      if (!call.body.snapshot?.snapshot_id || !call.body.snapshot?.captured_at) {
        throw new Error(`initial browser turn did not include its snapshot: ${JSON.stringify(call.body)}`);
      }
      if (
        !call.body.page?.observation?.document_id ||
        !call.body.snapshot?.observation?.document_id ||
        !Array.isArray(call.body.page?.observation_limitations) ||
        !Array.isArray(call.body.snapshot?.observation_limitations) ||
        !call.body.snapshot.elements.some((element) => element.observation_anchor?.anchor_id)
      ) {
        throw new Error(`initial browser turn dropped observation anchors or limitations: ${JSON.stringify(call.body)}`);
      }
    }

    const firstTurn = turnCalls[0].body;
    if (
      !firstTurn?.snapshot?.viewport ||
      !Array.isArray(firstTurn?.snapshot?.element_summaries) ||
      !firstTurn.snapshot.element_summaries.length ||
      !String(firstTurn?.snapshot?.page_text || "").includes("Use this page for a low-risk extension smoke test")
    ) {
      throw new Error(`initial browser turn payload is missing snapshot fields: ${JSON.stringify(firstTurn)}`);
    }
    if (firstTurn.input?.text !== "summarize this page" || firstTurn.intent_hint !== "browser_page_question") {
      throw new Error(`browser turn payload did not carry input/intent hint: ${JSON.stringify(firstTurn)}`);
    }
    if (firstTurn.role !== "help") {
      throw new Error(`explicit Help turn lost its browser role: ${JSON.stringify(firstTurn)}`);
    }

    const legacyTurn = turnCalls[1].body;
    const legacyEvidence = evidenceCalls[0].body;
    if (legacyEvidence.turn_id !== "turn-2" || legacyEvidence.evidence_request_id !== "evreq-2") {
      throw new Error(`legacy evidence payload was not linked to the turn/request: ${JSON.stringify(legacyEvidence)}`);
    }
    if (
      JSON.stringify(legacyEvidence.snapshot) !== JSON.stringify(legacyTurn.snapshot) ||
      JSON.stringify(legacyEvidence.screenshot) !== JSON.stringify(legacyTurn.screenshot)
    ) {
      throw new Error(`legacy fallback did not reuse the exact initial evidence: ${JSON.stringify({ legacyTurn, legacyEvidence })}`);
    }
    const modernFollowups = evidenceCalls.filter((call) => call.body.turn_id === "turn-1");
    if (modernFollowups.length) {
      throw new Error(`modern completed turn unexpectedly sent follow-up evidence: ${JSON.stringify(modernFollowups)}`);
    }

    console.log(
      `unified browser-agent smoke passed: id=${extensionId}, ` +
        `modern inline turn completed in one request/response leg, legacy needs_evidence reused exact evidence, ` +
        `action proposal stayed inert, no window shown.`,
    );
  } finally {
    pageCdp?.close();
    workerCdp?.close();
    browserCdp?.close();
    gateway.server.close();
    chrome.kill("SIGTERM");
    await delay(300);
    rmSync(runDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message || error);
  if (latestChromeStderr.trim()) {
    console.error("Chrome stderr tail:");
    console.error(latestChromeStderr.trim());
  }
  process.exit(1);
});
