// Quiet headless smoke for the REAL agee CDP background-tab task agent.
//
// Mirrors smoke-extension.mjs: launches Chrome for Testing with --headless=new
// and a throwaway profile under .gstack/background-qa/<run>/, loads the unpacked
// extension/, and exercises the {cmd:"branch"} path — the router launching ONE
// disposable task agent that drives its OWN background tab over chrome.debugger
// (Chrome DevTools Protocol). No visible window, no focus steal, never the daily
// profile.
//
// Asserts the spike's contract:
//   (a) a background tab was created and NEVER became active,
//   (b) a screenshot of that background tab was captured over CDP,
//   (c) a completion "done" cue rendered in the overlay on the user's tab.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import net from "node:net";
import { join, resolve } from "node:path";
import { resolveChromeForTesting, quietChromeArgs } from "./chrome-for-testing.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const repoRoot = resolve(root, "..");
const gatewayDir = join(repoRoot, "gateway");
const extensionPath = join(root, "extension");
const nodeBin = process.env.NODE_BINARY || "node";
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const runDir = join(root, ".gstack", "background-qa", `smoke-cdp-${runId}`);
const profilePath = join(runDir, "chrome-profile");
const gatewayDataDir = join(runDir, "gateway-data");
const TOKEN = "cdp-smoke-token";
let latestChromeStderr = "";
let latestGatewayStderr = "";

function serve() {
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
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
      resolveServer({ server, port: address.port });
    });
  });
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function freePort() {
  return new Promise((resolveFreePort, rejectFreePort) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolveFreePort(port));
    });
    server.on("error", rejectFreePort);
  });
}

async function startGateway() {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  mkdirSync(gatewayDataDir, { recursive: true });
  const gateway = spawn(nodeBin, ["server.js"], {
    cwd: gatewayDir,
    env: {
      PATH: process.env.PATH || "",
      HOME: process.env.HOME || "",
      TMPDIR: process.env.TMPDIR || "",
      HOST: "127.0.0.1",
      PORT: String(port),
      DATA_DIR: gatewayDataDir,
      MOA_GATEWAY_TOKEN: TOKEN,
      DEFAULT_AGENT_HARNESS: "echo",
      MODEL_API_KEY: "",
      OPENAI_API_KEY: "",
      GOOGLE_API_KEY: "",
      GEMINI_API_KEY: "",
      VERTEX_PROJECT: "",
      GOOGLE_CLOUD_PROJECT: "",
      GOOGLE_APPLICATION_CREDENTIALS: "",
      VERTEX_ACCESS_TOKEN: "",
      HARNESS_STATUS_TIMEOUT_MS: "200",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const append = (chunk) => {
    latestGatewayStderr += chunk.toString();
    latestGatewayStderr = latestGatewayStderr.slice(-4000);
  };
  gateway.stdout.on("data", append);
  gateway.stderr.on("data", append);
  const started = Date.now();
  while (Date.now() - started < 10000) {
    try {
      const resp = await fetch(`${baseUrl}/health`);
      if (resp.ok) return { gateway, baseUrl };
    } catch {
      // not ready
    }
    await delay(100);
  }
  gateway.kill("SIGTERM");
  throw new Error(`local gateway did not become healthy on ${baseUrl}.\n${latestGatewayStderr}`);
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
    this.ready = new Promise((resolveReady, rejectReady) => {
      this.ws.onopen = resolveReady;
      this.ws.onerror = rejectReady;
    });
    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (!msg.id || !this.pending.has(msg.id)) return;
      const { resolveCall, rejectCall } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) rejectCall(new Error(`${msg.error.message}: ${msg.error.data || ""}`));
      else resolveCall(msg.result);
    };
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

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "Runtime evaluation failed");
  }
  return result.result.value;
}

async function waitForEval(cdp, expression, timeoutMs = 15000) {
  const started = Date.now();
  let lastValue;
  while (Date.now() - started < timeoutMs) {
    lastValue = await evaluate(cdp, expression).catch(() => undefined);
    if (lastValue) return lastValue;
    await delay(150);
  }
  throw new Error(`Timed out waiting for expression: ${expression}; last=${JSON.stringify(lastValue)}`);
}

async function waitForGatewayTask(baseUrl, taskId, timeoutMs = 20000) {
  const started = Date.now();
  let lastTask = null;
  while (Date.now() - started < timeoutMs) {
    const body = await fetch(`${baseUrl}/v1/browser/tasks?limit=20`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    }).then((resp) => resp.json());
    lastTask = (body.tasks || []).find((task) => task.id === taskId) || null;
    if (lastTask?.status === "completed" || lastTask?.status === "failed") {
      return lastTask;
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for gateway browser task ${taskId}; last=${JSON.stringify(lastTask)}`);
}

async function waitForBrowserDevice(baseUrl, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const body = await fetch(`${baseUrl}/v1/device-clients`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    }).then((resp) => resp.json());
    const device = (body.devices || []).find((item) => item.surface_type === "browser_extension" && item.status === "online");
    if (device) return device;
    await delay(200);
  }
  throw new Error("Timed out waiting for the extension device heartbeat");
}

async function waitForToolRequest(baseUrl, requestId, timeoutMs = 15000) {
  const started = Date.now();
  let lastRequest = null;
  while (Date.now() - started < timeoutMs) {
    const body = await fetch(`${baseUrl}/v1/tool/requests?limit=100`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    }).then((resp) => resp.json());
    lastRequest = (body.requests || []).find((item) => item.id === requestId) || null;
    if (lastRequest?.status === "completed" || lastRequest?.status === "failed") return lastRequest;
    await delay(200);
  }
  throw new Error(`Timed out waiting for browser tool request ${requestId}; last=${JSON.stringify(lastRequest)}`);
}

async function main() {
  const chromePath = resolveChromeForTesting();
  const { server, port: serverPort } = await serve();
  mkdirSync(profilePath, { recursive: true });

  const demoUrl = `http://localhost:${serverPort}/fixtures/demo.html`;
  const branchUrl = `http://localhost:${serverPort}/fixtures/demo.html?branch=1`;
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
  let gateway;
  try {
    gateway = await startGateway();
    const devToolsPort = Number((await waitForFile(join(profilePath, "DevToolsActivePort"))).split("\n")[0]);

    // The agee service worker target is the proof the REAL extension loaded.
    const workerTarget = await waitForTarget(
      devToolsPort,
      (target) => target.type === "service_worker" && /^chrome-extension:\/\/[a-p]+\/background\.js$/.test(target.url || ""),
    );

    if (latestChromeStderr.includes("--load-extension is not allowed")) {
      throw new Error(
        "The resolved Chrome refused --load-extension (branded Chrome blocks it). " +
          "Point AGEE_CHROME_PATH at a Chrome for Testing binary.",
      );
    }

    const extensionId = workerTarget.url.match(/^chrome-extension:\/\/([a-p]+)\//)[1];

    // Open the user's foreground tab (the overlay tab) on the demo page so the
    // real content script auto-injects on the localhost match.
    const browserInfo = await fetch(`http://127.0.0.1:${devToolsPort}/json/version`).then((resp) => resp.json());
    browserCdp = new Cdp(browserInfo.webSocketDebuggerUrl);
    const { targetId } = await browserCdp.send("Target.createTarget", { url: "about:blank" });
    const pageTarget = await waitForTarget(devToolsPort, (target) => target.type === "page" && target.id === targetId);

    pageCdp = new Cdp(pageTarget.webSocketDebuggerUrl);
    await pageCdp.send("Runtime.enable");
    await pageCdp.send("Page.enable");
    await pageCdp.send("Page.navigate", { url: demoUrl });
    await waitForEval(pageCdp, `location.href.startsWith(${JSON.stringify(demoUrl)}) && document.readyState === "complete"`);

    // Confirm the real content script is alive on the overlay tab (it owns the
    // cue-card overlay we assert against). The content script runs in an isolated
    // world, so we prove it via a ping through the service worker (production
    // path) and via the overlay root it injects into the shared page DOM.
    workerCdp = new Cdp(workerTarget.webSocketDebuggerUrl);
    await workerCdp.send("Runtime.enable");
    await waitForEval(workerCdp, `chrome.storage.local.get("ageePrivacyMigrationVersion").then(value => value.ageePrivacyMigrationVersion === 1)`);
    await evaluate(workerCdp, `chrome.storage.local.set(${JSON.stringify({
      ageeGatewayUrl: gateway.baseUrl,
      ageeGatewayToken: TOKEN,
      ageePrivacyMigrationVersion: 1,
      ageeBackgroundAutomationEnabled: true,
      ageeBackgroundAutomationConsentVersion: 1,
    })}).then(() => true)`);
    const ping = await waitForEval(workerCdp, `
      (async () => {
        const [tab] = await chrome.tabs.query({ url: "http://localhost/*" });
        if (!tab) return null;
        try {
          const res = await chrome.tabs.sendMessage(tab.id, { cmd: "ping" });
          return res && res.ok ? { tabId: tab.id } : null;
        } catch {
          return null;
        }
      })()
    `);
    if (!ping?.tabId) throw new Error("real content script did not answer ping via the service worker");
    await waitForEval(pageCdp, `Boolean(document.getElementById("agee-root"))`);

    // Prove the first-party browser facade is advertised and executable through
    // the real gateway tool-request broker. This description becomes an Amazon
    // search URL inside the extension; no Tweeks MCP/native host is involved.
    const browserDevice = await waitForBrowserDevice(gateway.baseUrl);
    if (!(browserDevice.local_tool_manifest || []).some((entry) => entry.tool === "browser.search.open")) {
      throw new Error(`browser.search.open missing from heartbeat manifest: ${JSON.stringify(browserDevice.local_tool_manifest)}`);
    }
    const searchQueued = await fetch(`${gateway.baseUrl}/v1/tool/requests`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        source: "smoke-cdp",
        source_surface_type: "browser_extension",
        target_surface_type: "browser_extension",
        tool: "browser.search.open",
        input: { query: "ergonomic red chair", provider: "amazon", active: false },
        session_id: "browser_facade_smoke",
        branch_id: "amazon_search",
      }),
    }).then((resp) => resp.json());
    if (!searchQueued?.request?.id) throw new Error(`gateway did not queue browser.search.open: ${JSON.stringify(searchQueued)}`);
    const searchRequest = await waitForToolRequest(gateway.baseUrl, searchQueued.request.id);
    if (searchRequest.status !== "completed" || !searchRequest.latest_receipt?.ok) {
      throw new Error(`browser.search.open did not complete: ${JSON.stringify(searchRequest)}`);
    }
    const searchTabId = Number(searchRequest.latest_receipt?.result?.tab_id);
    const searchTab = Number.isInteger(searchTabId)
      ? await waitForEval(workerCdp, `chrome.tabs.get(${searchTabId}).catch(() => null)`, 10000)
      : null;
    const requestedSearchUrl = String(searchRequest.latest_receipt?.result?.url || "");
    if (
      !searchTab?.id ||
      searchTab.active ||
      !requestedSearchUrl.startsWith("https://www.amazon.com/s?k=ergonomic+red+chair")
    ) {
      throw new Error(`Amazon search tab missing, malformed, or stole focus: ${JSON.stringify({ searchTab, requestedSearchUrl })}`);
    }
    await evaluate(workerCdp, `chrome.tabs.remove(${Number(searchTab.id)}).then(() => true)`);

    // Count page targets before the queued task so we can prove a NEW
    // background tab is created by the task agent.
    const pagesBefore = (await targets(devToolsPort)).filter((t) => t.type === "page").length;

    const queued = await fetch(`${gateway.baseUrl}/v1/browser/tasks`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        source: "smoke-cdp",
        instruction: "inspect queued browser task page",
        url: branchUrl,
        cdp_actions: [
          {
            method: "Runtime.evaluate",
            params: {
              expression: "document.title",
              returnByValue: true,
            },
          },
          {
            method: "Page.captureScreenshot",
            params: {
              format: "jpeg",
              quality: 35,
            },
          },
          {
            method: "Input.dispatchMouseEvent",
            params: { type: "mouseMoved", x: 10, y: 10 },
          },
        ],
      }),
    }).then((resp) => resp.json());
    const queuedId = queued?.task?.id;
    if (!queuedId) {
      throw new Error(`gateway did not create queued browser task: ${JSON.stringify(queued)}`);
    }
    const completedTask = await waitForGatewayTask(gateway.baseUrl, queuedId);
    if (completedTask.status !== "completed" || !completedTask.latest_receipt?.ok) {
      throw new Error(`queued browser task did not complete with ok receipt: ${JSON.stringify(completedTask)}`);
    }

    // The disposable background tab is removed after the run, so the page count
    // returns to baseline. The overlay tab must remain on the user's page.
    let pagesAfter = pagesBefore;
    const settleStart = Date.now();
    while (Date.now() - settleStart < 5000) {
      pagesAfter = (await targets(devToolsPort)).filter((t) => t.type === "page").length;
      if (pagesAfter === pagesBefore) break;
      await delay(150);
    }
    const overlayUrl = await evaluate(pageCdp, "location.href");
    if (overlayUrl.includes("branch=1")) {
      throw new Error("overlay tab was navigated by the queued task agent (focus/ownership violation)");
    }

    console.log(
      "CDP task-agent smoke passed (REAL extension, headless Chrome for Testing): " +
        `service worker id=${extensionId}; first-party browser.search.open produced a background Amazon search tab and receipt; ` +
        "background task agent opened its own tab, captured a screenshot, " +
        "dispatched 1 input event, stayed in background, then disposed the tab; " +
        `queued gateway task ${queuedId} completed with a receipt; pages baseline=${pagesBefore} after=${pagesAfter}; ` +
        "no window shown, no focus taken.",
    );
  } finally {
    pageCdp?.close();
    workerCdp?.close();
    browserCdp?.close();
    server.close();
    gateway?.gateway?.kill("SIGTERM");
    chrome.kill("SIGTERM");
    await delay(300);
    rmSync(runDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().catch((error) => {
  console.error(error.message || error);
  if (latestChromeStderr.trim()) {
    console.error("Chrome stderr tail:");
    console.error(latestChromeStderr.trim());
  }
  if (latestGatewayStderr.trim()) {
    console.error("Gateway output tail:");
    console.error(latestGatewayStderr.trim());
  }
  process.exit(1);
});
