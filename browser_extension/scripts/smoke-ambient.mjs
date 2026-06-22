// Quiet headless smoke for the 200 ms ambient frame loop.
//
// It boots a throwaway gateway with a throwaway token, loads the real unpacked
// extension into Chrome for Testing, starts {cmd:"ambientStart", intervalMs:200}
// from the content script, and proves the service worker posts repeated
// /v1/voice/frames messages that the gateway stores. No real .env, no API key.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
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
const runDir = join(root, ".gstack", "background-qa", `ambient-${runId}`);
const profilePath = join(runDir, "chrome-profile");
const GATEWAY_TOKEN = "ambient-smoke-token";
const AMBIENT_INTERVAL_MS = 200;
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

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
    server.on("error", reject);
  });
}

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
    MODEL_ID: "ambient-smoke-model",
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
    return new Promise((resolveCall, rejectCall) => {
      this.pending.set(id, { resolveCall, rejectCall });
    });
  }

  close() {
    this.ws.close();
  }
}

function targets(port) {
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
  await waitForEval(pageCdp, `Boolean(document.getElementById("agee-root"))`);

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

const INSTALL_FETCH_RECORDER = `
  (() => {
    if (globalThis.__ageeFetchLog) return globalThis.__ageeFetchLog.length;
    const log = [];
    globalThis.__ageeFetchLog = log;
    const orig = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : (input && input.url) || String(input);
      let seq = null;
      let sessionId = null;
      try {
        const body = JSON.parse((init && init.body) || "null");
        seq = Number.isFinite(body && body.seq) ? body.seq : null;
        sessionId = body && body.session_id ? String(body.session_id) : null;
      } catch {}
      const entry = {
        url,
        method: (init && init.method) || "GET",
        status: null,
        ok: null,
        error: null,
        at: performance.now(),
        seq,
        sessionId,
      };
      log.push(entry);
      try {
        const resp = await orig(input, init);
        entry.status = resp.status;
        entry.ok = resp.ok;
        return resp;
      } catch (err) {
        entry.error = String((err && err.message) || err);
        throw err;
      }
    };
    return 0;
  })()
`;

function ambientCallsExpr(minCount = 1) {
  return `
    (() => {
      const calls = (globalThis.__ageeFetchLog || []).filter((entry) => {
        try { return new URL(entry.url).pathname === "/v1/voice/frames"; }
        catch { return false; }
      });
      if (calls.length < ${minCount}) return null;
      return calls.map((entry) => ({
        status: entry.status,
        ok: entry.ok,
        at: entry.at,
        seq: entry.seq,
        sessionId: entry.sessionId,
      }));
    })()
  `;
}

function readStoredFrames(dataDir, sessionId) {
  const framesRoot = join(dataDir, "voice-frames");
  if (!existsSync(framesRoot)) return [];
  const sessionDirs = existsSync(join(framesRoot, sessionId)) ? [sessionId] : readdirSync(framesRoot);
  const records = [];
  for (const dir of sessionDirs) {
    const fullDir = join(framesRoot, dir);
    if (!existsSync(fullDir)) continue;
    for (const file of readdirSync(fullDir).filter((name) => name.endsWith(".json")).sort()) {
      try {
        records.push(JSON.parse(readFileSync(join(fullDir, file), "utf8")));
      } catch {}
    }
  }
  return records;
}

async function main() {
  const chromePath = resolveChromeForTesting();
  const tempDir = mkdtempSync(join(tmpdir(), "moa-ambient-smoke-"));
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
      (target) => target.type === "service_worker" && /^chrome-extension:\/\/[a-p]+\/background\.js$/.test(target.url || ""),
    );
    if (latestChromeStderr.includes("--load-extension is not allowed")) {
      throw new Error("Resolved Chrome refused --load-extension; point AGEE_CHROME_PATH at Chrome for Testing.");
    }
    const extensionId = workerTarget.url.match(/^chrome-extension:\/\/([a-p]+)\//)[1];

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
    await evaluate(workerCdp, INSTALL_FETCH_RECORDER);

    const browserInfo = await fetch(`http://127.0.0.1:${devToolsPort}/json/version`).then((resp) => resp.json());
    browserCdp = new Cdp(browserInfo.webSocketDebuggerUrl);
    const { targetId } = await browserCdp.send("Target.createTarget", { url: "about:blank" });
    const pageTarget = await waitForTarget(devToolsPort, (target) => target.type === "page" && target.id === targetId);
    pageCdp = new Cdp(pageTarget.webSocketDebuggerUrl);
    const contentCtx = await openPageAndResolveContext(pageCdp, demoUrl);

    const start = await evaluate(
      pageCdp,
      `chrome.runtime.sendMessage({ cmd: "ambientStart", intervalMs: ${AMBIENT_INTERVAL_MS} }).then((r) => r || null)`,
      { contextId: contentCtx },
    );
    if (!start?.ok || start.intervalMs !== AMBIENT_INTERVAL_MS || !start.sessionId) {
      throw new Error(`ambientStart returned unexpected response: ${JSON.stringify(start)}`);
    }

    await waitForEval(
      pageCdp,
      `Boolean(document.getElementById("agee-root")?.classList.contains("agee-ambient"))`,
      3000,
      { contextId: contentCtx },
    );

    const calls = await waitForEval(workerCdp, ambientCallsExpr(4), 5000);
    const bad = calls.filter((call) => call.status !== 202 || call.ok !== true);
    if (bad.length) {
      throw new Error(`ambient frame posts did not all return 202: ${JSON.stringify(calls)}`);
    }

    const seqs = calls.map((call) => call.seq);
    if (seqs[0] !== 0 || !seqs.every((seq, index) => seq === index)) {
      throw new Error(`ambient seqs should be contiguous from zero, got ${JSON.stringify(seqs)}`);
    }
    const intervals = calls.slice(1).map((call, index) => Math.round(call.at - calls[index].at));
    const nearCadence = intervals.filter((ms) => ms >= 80 && ms <= 500).length;
    if (nearCadence < 2) {
      throw new Error(`ambient posts did not show a 200 ms cadence; intervals=${JSON.stringify(intervals)}`);
    }

    const stop = await evaluate(
      pageCdp,
      `chrome.runtime.sendMessage({ cmd: "ambientStop" }).then((r) => r || null)`,
      { contextId: contentCtx },
    );
    if (!stop?.ok) throw new Error(`ambientStop returned unexpected response: ${JSON.stringify(stop)}`);
    await waitForEval(
      pageCdp,
      `!document.getElementById("agee-root")?.classList.contains("agee-ambient")`,
      3000,
      { contextId: contentCtx },
    );

    await delay(200);
    const stored = readStoredFrames(dataDir, start.sessionId);
    if (stored.length < calls.length) {
      throw new Error(`gateway stored fewer ambient frames than posted: stored=${stored.length}, posted=${calls.length}`);
    }
    const storedSeqs = stored.map((record) => record.seq).filter((seq) => Number.isFinite(seq)).sort((a, b) => a - b);
    const storedHasPostedSeqs = seqs.every((seq) => storedSeqs.includes(seq));
    if (!storedHasPostedSeqs || stored.some((record) => record.session_id !== start.sessionId)) {
      throw new Error(`stored ambient frames are wrong: posted=${JSON.stringify(seqs)}, stored=${JSON.stringify(storedSeqs)}`);
    }

    console.log(
      "Ambient 200 ms smoke passed (REAL extension + throwaway gateway, headless Chrome for Testing):\n" +
        `  service worker id=${extensionId}; gateway=${baseUrl}\n` +
        `  ambientStart returned intervalMs=${start.intervalMs}, session=${start.sessionId}\n` +
        `  observed ${calls.length} POST /v1/voice/frames calls with seqs ${seqs.join(", ")}\n` +
        `  observed intervals: ${intervals.join(" ms, ")} ms; gateway stored ${stored.length} frame record(s).`,
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
