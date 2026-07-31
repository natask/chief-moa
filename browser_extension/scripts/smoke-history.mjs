// Canonical History persistence smoke for the REAL agee extension.
//
// Proves the headline fix: a conversational turn typed into the overlay is
// persisted server-side under a STABLE session id, and when the overlay is
// left behind, the durable side-panel workspace RELOADS that prior turn from
// canonical History instead of relying on transient overlay state.
//
// Flow:
//   1. Boot a throwaway gateway with `node server.js` directly (own port/token/
//      DATA_DIR, real .env NEVER loaded). No model key -> the gateway's
//      deterministic fallback stands in for a model reply, so a conversational
//      turn still produces and stores a reply.
//   2. Load the REAL unpacked extension into headless Chrome for Testing, point
//      it at the throwaway gateway via chrome.storage.local (URL + token only —
//      never .env, never printed, no API key in the browser).
//   3. Open the overlay, send ONE conversational turn, and wait for its reply.
//   4. Close that page and open sidepanel.html. Assert one newest-first outer
//      turn card nests the exact user transcript and assistant reply.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveChromeForTesting, quietChromeArgs } from "./chrome-for-testing.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const extensionPath = join(root, "extension");
const gatewayDir = resolve(root, "..", "gateway");
const nodeBin = process.env.NODE_BINARY || "node";
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const runDir = join(root, ".gstack", "background-qa", `smoke-history-${runId}`);
const profilePath = join(runDir, "chrome-profile");
const GATEWAY_TOKEN = "history-smoke-token";
const TRANSCRIPT = "tell me about voice capture";
let latestChromeStderr = "";

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
      resolveServer({ server, port: server.address().port });
    });
  });
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForFile(path, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (existsSync(path)) return readFileSync(path, "utf8");
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${path}`);
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolvePort(port));
    });
    srv.on("error", reject);
  });
}

// Throwaway gateway: node server.js directly, real .env NOT loaded, NO model key
// (deterministic fallback reply). Same boot contract as smoke-integration.mjs.
async function startGateway(dataDir, port) {
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = {
    PATH: process.env.PATH || "",
    HOME: process.env.HOME || "",
    TMPDIR: process.env.TMPDIR || tmpdir(),
    HOST: "127.0.0.1",
    PORT: String(port),
    DATA_DIR: dataDir,
    ANDROID_OTA_DIR: join(dataDir, "android-ota"),
    MOA_GATEWAY_TOKEN: GATEWAY_TOKEN,
    MODEL_PROVIDER: "openai-compatible",
    MODEL_ID: "history-smoke-model",
    MODEL_API_KEY: "",
    OPENAI_API_KEY: "",
    GOOGLE_API_KEY: "",
    GEMINI_API_KEY: "",
  };
  const server = spawn(nodeBin, ["server.js"], {
    cwd: gatewayDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  let exited = false;
  const append = (chunk) => {
    logs += chunk.toString("utf8");
    if (logs.length > 12000) logs = logs.slice(-12000);
  };
  server.stdout.on("data", append);
  server.stderr.on("data", append);
  server.on("exit", () => {
    exited = true;
  });

  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`${baseUrl}/health`);
      if (resp.ok) return { server, baseUrl };
    } catch {
      // still starting
    }
    if (exited) throw new Error(`gateway exited before health was ready\n${logs}`);
    await delay(100);
  }
  throw new Error(`timed out waiting for gateway health\n${logs}`);
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
    return new Promise((resolveCall, rejectCall) => this.pending.set(id, { resolveCall, rejectCall }));
  }
  close() {
    this.ws.close();
  }
}

function targets(port) {
  return fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
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
  throw new Error(`Timed out waiting for Chrome target. Last: ${JSON.stringify(
    lastTargets.map((t) => ({ type: t.type, url: t.url })), null, 2)}`);
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

async function waitForEval(cdp, expression, timeoutMs = 20000, opts = {}) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    last = await evaluate(cdp, expression, opts).catch(() => undefined);
    if (last) return last;
    await delay(150);
  }
  throw new Error(`Timed out waiting for expression: ${expression}; last=${JSON.stringify(last)}`);
}

// Resolve the content script's ISOLATED world (where chrome.runtime.sendMessage
// reaches the background). Navigate first, then probe captured contexts.
async function openPageAndResolveContext(pageCdp, demoUrl) {
  const isolatedContexts = [];
  pageCdp.on("Runtime.executionContextCreated", ({ context }) => {
    const aux = context.auxData || {};
    if (aux.type === "isolated" || context.name) isolatedContexts.push(context.id);
  });
  await pageCdp.send("Runtime.enable");
  await pageCdp.send("Page.enable");
  await pageCdp.send("Page.navigate", { url: demoUrl });
  await waitForEval(pageCdp, `location.href.startsWith(${JSON.stringify(demoUrl)}) && document.readyState === "complete"`);
  // The content script auto-injects on http://localhost/* and builds #agee-root.
  // Wait for that DOM marker from the page main world (it is visible there even
  // though window.__ageeLoaded lives only in the content script's isolated world).
  await waitForEval(pageCdp, `Boolean(document.getElementById("agee-root"))`);

  // Resolve the content script's isolated world by probing each candidate for the
  // overlay marker (window.__ageeLoaded) plus chrome.runtime messaging.
  const deadline = Date.now() + 10000;
  let contentCtx = null;
  while (Date.now() < deadline && contentCtx == null) {
    for (const candidate of isolatedContexts) {
      const isOverlay = await evaluate(
        pageCdp,
        `Boolean(window.__ageeLoaded && typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage)`,
        { contextId: candidate },
      ).catch(() => false);
      if (isOverlay) {
        contentCtx = candidate;
        break;
      }
    }
    if (contentCtx == null) await delay(150);
  }
  if (contentCtx == null) {
    throw new Error(`could not resolve the overlay's isolated execution context (candidates: ${isolatedContexts.length})`);
  }
  return contentCtx;
}

async function main() {
  const chromePath = resolveChromeForTesting();
  const tempDir = mkdtempSync(join(tmpdir(), "moa-history-smoke-"));
  const dataDir = join(tempDir, "data");
  const { server: gateway, baseUrl } = await startGateway(dataDir, await freePort());
  const { server, port: serverPort } = await serve();
  mkdirSync(profilePath, { recursive: true });

  const demoUrl = `http://localhost:${serverPort}/fixtures/demo.html`;
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
      (t) => t.type === "service_worker" && /^chrome-extension:\/\/[a-p]+\/background\.js$/.test(t.url || ""),
    );
    if (latestChromeStderr.includes("--load-extension is not allowed")) {
      throw new Error("Resolved Chrome refused --load-extension; point AGEE_CHROME_PATH at Chrome for Testing.");
    }
    const extensionId = workerTarget.url.match(/^chrome-extension:\/\/([a-p]+)\//)[1];

    // Point the REAL extension at the throwaway gateway via storage — never .env,
    // never an API key in the browser. Token only from this storage write.
    workerCdp = new Cdp(workerTarget.webSocketDebuggerUrl);
    await workerCdp.send("Runtime.enable");
    await evaluate(
      workerCdp,
      `chrome.storage.local.set(${JSON.stringify({
        ageeGatewayUrl: baseUrl,
        ageeGatewayToken: GATEWAY_TOKEN,
        ageeApiKey: "",
      })}).then(() => true)`,
    );

    // ---- Open the overlay tab (page #1) and send ONE conversational turn ----
    const browserInfo = await fetch(`http://127.0.0.1:${devToolsPort}/json/version`).then((r) => r.json());
    browserCdp = new Cdp(browserInfo.webSocketDebuggerUrl);
    const { targetId } = await browserCdp.send("Target.createTarget", { url: "about:blank" });
    const pageTarget = await waitForTarget(devToolsPort, (t) => t.type === "page" && t.id === targetId);

    pageCdp = new Cdp(pageTarget.webSocketDebuggerUrl);
    const contentCtx = await openPageAndResolveContext(pageCdp, demoUrl);

    // Drive the REAL overlay submit path: the worker sends `open` to the content
    // script, which starts composition in the user ribbon. Type a conversational
    // instruction and press Enter; submitInstruction then routes it through the
    // background while the overlay remains current-turn-only.
    await waitForEval(
      workerCdp,
      `(async () => {
        const [tab] = await chrome.tabs.query({ url: "http://localhost/*" });
        if (!tab) return null;
        try {
          const result = await chrome.tabs.sendMessage(tab.id, { cmd: "open" });
          return result?.ok ? tab.id : null;
        } catch { return null; }
      })()`,
      10000,
    );
    await waitForEval(
      pageCdp,
      `document.querySelector("#agee-ribbon-you .agee-ribbon-text")?.getAttribute("contenteditable") === "plaintext-only"`,
      10000,
      { contextId: contentCtx },
    );
    await evaluate(
      pageCdp,
      `(() => {
        const input = document.querySelector("#agee-ribbon-you .agee-ribbon-text");
        input.textContent = ${JSON.stringify(TRANSCRIPT)};
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        return true;
      })()`,
      { contextId: contentCtx },
    );

    // Wait for the live turn's reply. It reads in the lower ribbon; the recorded
    // value covers the window between the reply landing and the ribbon's linger
    // timer retiring it.
    const liveReply = await waitForEval(
      pageCdp,
      `(() => {
        const live = document.querySelector("#agee-ribbon-reply.agee-ribbon-live .agee-ribbon-text");
        return (live && live.textContent) || (window.__ageeLastReply && window.__ageeLastReply.text) || null;
      })()`,
      30000,
      { contextId: contentCtx },
    );
    if (!liveReply || !String(liveReply).trim()) {
      throw new Error("live conversational turn did not produce a reply in the overlay");
    }

    // Confirm the turn actually persisted in canonical History under the stable
    // session id. Typed overlay turns use the browser-turn path, so the legacy
    // paired `/turns` endpoint is not their storage authority.
    const sessionId = await evaluate(
      workerCdp,
      `chrome.storage.local.get("ageeSessionId").then((g) => g.ageeSessionId || null)`,
    );
    if (!sessionId) throw new Error("extension did not persist a stable ageeSessionId");
    const persisted = await fetch(`${baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/messages`, {
      headers: { authorization: `Bearer ${GATEWAY_TOKEN}` },
    }).then((r) => r.json());
    if (!Array.isArray(persisted.messages) || persisted.messages.length !== 2) {
      throw new Error(`gateway should project exactly 2 messages for one turn, got ${JSON.stringify(persisted.messages)}`);
    }
    const persistedUser = persisted.messages.find((message) => message.speaker === "user");
    const persistedAssistant = persisted.messages.find((message) => message.speaker === "assistant");
    const serverReply = String(persistedAssistant?.text || "").trim();
    if (persistedUser?.text !== TRANSCRIPT || !serverReply
        || persistedUser?.turn_id !== persistedAssistant?.turn_id) {
      throw new Error(`canonical History missing one complete turn: ${JSON.stringify(persisted.messages)}`);
    }

    // ---- LEAVE THE OVERLAY, OPEN HISTORY: reload from the gateway ------------
    // The overlay is intentionally current-turn-only. Durable scrollback lives
    // in the extension side panel and must reconstruct from gateway state.
    pageCdp.close();
    await browserCdp.send("Target.closeTarget", { targetId }).catch(() => {});
    await delay(300);
    const panelUrl = `chrome-extension://${extensionId}/sidepanel.html`;
    const { targetId: targetId2 } = await browserCdp.send("Target.createTarget", { url: panelUrl });
    const pageTarget2 = await waitForTarget(
      devToolsPort,
      (t) => t.type === "page" && t.id === targetId2 && t.url === panelUrl,
    );
    pageCdp = new Cdp(pageTarget2.webSocketDebuggerUrl);
    await pageCdp.send("Runtime.enable");
    await waitForEval(pageCdp, `document.readyState === "complete" && Boolean(document.getElementById("history"))`);

    const restored = await waitForEval(
      pageCdp,
      `(() => {
        const cards = [...document.querySelectorAll("#history > .history-turn")];
        if (cards.length !== 1) return null;
        const rows = [...cards[0].querySelectorAll(":scope > .history-message")];
        const user = rows.find((row) => row.dataset.speaker === "user");
        const assistant = rows.find((row) => row.dataset.speaker === "assistant");
        const userText = user?.querySelector(":scope > .body")?.textContent || "";
        const assistantText = assistant?.querySelector(":scope > .body")?.textContent || "";
        return userText === ${JSON.stringify(TRANSCRIPT)} && assistantText
          ? {
              cards: cards.length,
              speakers: rows.map((row) => row.dataset.speaker),
              userText,
              assistantText,
              turnId: cards[0].dataset.turnId,
            }
          : null;
      })()`,
      20000,
    );
    if (!restored) {
      const dump = await evaluate(
        pageCdp,
        `(() => { const history = document.getElementById("history"); return history ? history.innerText : "(no History)"; })()`,
      ).catch(() => "(unavailable)");
      throw new Error(`side panel did not reload canonical History. Dump:\n${dump}`);
    }
    if (JSON.stringify(restored.speakers) !== JSON.stringify(["user", "assistant"])
        || restored.turnId !== persistedUser.turn_id) {
      throw new Error(`restored outer turn grouping drifted: ${JSON.stringify(restored)}`);
    }

    console.log(
      "History smoke passed (REAL extension + throwaway gateway, headless Chrome for Testing):\n" +
        `  service worker id=${extensionId}; gateway=${baseUrl}\n` +
        `  stable session id persisted; one conversational turn projected as user + assistant messages;\n` +
        `  side panel RELOADED ${restored.cards} newest-first outer turn card with nested user + assistant content;\n` +
        `  transient overlay state was not used as History authority; no API key in browser, token only from storage.`,
    );
  } finally {
    pageCdp?.close();
    workerCdp?.close();
    browserCdp?.close();
    server.close();
    chrome.kill("SIGTERM");
    await delay(300);
    try {
      gateway.kill("SIGTERM");
    } catch {}
    await delay(300);
    rmSync(runDir, { recursive: true, force: true });
    rmSync(tempDir, { recursive: true, force: true });
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
