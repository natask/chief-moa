// Visual + numeric QA for the two complaints from 2026-07-29:
//   1. "why is it so far away" — the words floated ~340px from the companion
//      because the box hugged the seam while its text sat at the far end.
//   2. "I don't see it streaming" — the reply appeared to land whole.
//
// Reproduces the reported situation (wide window, companion near the right
// edge, a long Amharic reply), then measures the gap between the rendered words
// and the companion, and samples the reply length over time to prove the reveal
// is progressive. Writes screenshots next to the numbers so the layout can be
// looked at, not just asserted.
//
// Run: npm run qa:seam

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { resolveChromeForTesting, quietChromeArgs } from "./chrome-for-testing.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const extensionPath = join(root, "extension");
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const runDir = join(root, ".gstack", "background-qa", `seam-${runId}`);
const profilePath = join(runDir, "chrome-profile");
const shotDir = join(runDir, "shots");

const USER_TEXT = "Hello, can you hear me? Why is it not located in the right place?";
const REPLY_TEXT = "በትክክል እንዲታይምት እያስተካከልኩት ነው። ይህ ጽሑፍ አሁን በንባብ ፍጥነት ይመጣል፣ ስለዚህ መስመሩ ሁልጊዜ ይንቀሳቀሳል።";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function serve() {
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const path = url.pathname === "/" ? "/fixtures/demo.html" : url.pathname;
    try {
      const body = readFileSync(join(root, path.replace(/^\/+/, "")));
      res.writeHead(200, { "content-type": path.endsWith(".html") ? "text/html" : "text/plain" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  });
  return new Promise((done) => server.listen(0, "localhost", () => done({ server, port: server.address().port })));
}

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.ready = new Promise((ok, fail) => {
      this.ws.onopen = ok;
      this.ws.onerror = fail;
    });
    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.method) {
        for (const handler of this.listeners.get(msg.method) || []) handler(msg.params);
        return;
      }
      if (!msg.id || !this.pending.has(msg.id)) return;
      const { ok, fail } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) fail(new Error(msg.error.message));
      else ok(msg.result);
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
    return new Promise((ok, fail) => this.pending.set(id, { ok, fail }));
  }
  close() {
    this.ws.close();
  }
}

async function evaluate(cdp, expression, contextId) {
  const params = { expression, awaitPromise: true, returnByValue: true };
  if (contextId != null) params.contextId = contextId;
  let result;
  try {
    result = await cdp.send("Runtime.evaluate", params);
  } catch (error) {
    const summary = String(expression || "").replace(/\s+/g, " ").trim().slice(0, 180);
    throw new Error(`${String(error?.message || error)}; expression=${summary}`);
  }
  if (result.exceptionDetails) {
    const description = result.exceptionDetails.exception?.description;
    const text = result.exceptionDetails.text;
    const detail = [text, description].filter(Boolean).join(": ");
    throw new Error(detail || "evaluation failed");
  }
  return result.result.value;
}

async function waitFor(cdp, expression, timeoutMs = 12000, contextId) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    last = await evaluate(cdp, expression, contextId);
    if (last) return last;
    await delay(120);
  }
  throw new Error(`timed out: ${expression} (last=${JSON.stringify(last)})`);
}

async function shot(cdp, name) {
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
  const file = join(shotDir, `${name}.png`);
  writeFileSync(file, Buffer.from(data, "base64"));
  return file;
}

// Where the rendered words actually are, relative to the companion. This is the
// number the user was reacting to: not where the box is, where the text is.
const MEASURE = `
  (() => {
    const launcher = document.querySelector("#agee-launcher");
    const centre = launcher.getBoundingClientRect().left + launcher.getBoundingClientRect().width / 2;
    const read = (id) => {
      const el = document.querySelector(id);
      const text = el.querySelector(".agee-ribbon-text");
      const box = el.getBoundingClientRect();
      const words = text.getBoundingClientRect();
      return {
        seam: el.dataset.ageeSeam || "",
        live: el.classList.contains("agee-ribbon-live"),
        rendered: (text.textContent || "").length,
        boxLeft: Math.round(box.left),
        boxRight: Math.round(box.right),
        // Distance from the companion's centre line to the nearest edge of the
        // painted words.
        wordGap: Math.round(Math.min(Math.abs(words.left - centre), Math.abs(words.right - centre))),
      };
    };
    return { centre: Math.round(centre), you: read("#agee-ribbon-you"), reply: read("#agee-ribbon-reply") };
  })()
`;

async function main() {
  mkdirSync(shotDir, { recursive: true });
  let server;
  let chrome;
  let pageCdp;
  let workerCdp;
  try {
    const served = await serve();
    server = served.server;
    const demoUrl = `http://localhost:${served.port}/fixtures/demo.html`;
    const chromePath = resolveChromeForTesting();
    chrome = spawn(chromePath, [
      ...quietChromeArgs({ extensionPath, profilePath }),
      "--window-size=1280,820",
    ], { stdio: ["ignore", "pipe", "pipe"] });

  let stderr = "";
  chrome.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  const wsMatch = await new Promise((ok, fail) => {
    const timer = setTimeout(() => fail(new Error(`chrome did not report a debug port\n${stderr}`)), 20000);
    chrome.stderr.on("data", () => {
      const found = stderr.match(/ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (found) {
        clearTimeout(timer);
        ok(found[1]);
      }
    });
  });

  const list = await fetch(`http://127.0.0.1:${wsMatch}/json/new?${encodeURIComponent(demoUrl)}`, { method: "PUT" })
    .then((r) => r.json());
  pageCdp = new Cdp(list.webSocketDebuggerUrl);
  await pageCdp.send("Runtime.enable");
  await pageCdp.send("Page.enable");
  await waitFor(pageCdp, `document.readyState === "complete" && Boolean(document.getElementById("agee-root"))`);
  await pageCdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1280, height: 820, deviceScaleFactor: 1, mobile: false,
  });

  // Put the companion where the user had it: near the right edge, where the
  // you-box cannot fit to the right of the seam and has to mirror.
  await evaluate(pageCdp, `
    (() => {
      const launcher = document.querySelector("#agee-launcher");
      launcher.style.left = "1150px";
      launcher.style.top = "380px";
      window.dispatchEvent(new Event("resize"));
      return true;
    })()
  `);
  await delay(200);

  // Drive the unit through the service worker, exactly as a real turn does:
  // the worker owns the active-turn presentation and broadcasts it to the tab.
  const workerTarget = await (async () => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const list = await fetch(`http://127.0.0.1:${wsMatch}/json/list`).then((r) => r.json());
      const found = list.find((t) => t.type === "service_worker" && t.url.includes("background.js"));
      if (found) return found;
      await delay(200);
    }
    throw new Error("service worker target never appeared");
  })();
  workerCdp = new Cdp(workerTarget.webSocketDebuggerUrl);
  await workerCdp.send("Runtime.enable");
  const tabId = await waitFor(workerCdp, `
    typeof globalThis.chrome?.tabs?.query !== "function"
      ? null
      : chrome.tabs.query({}).then((tabs) => (tabs.find((t) => t.url && t.url.includes("demo.html")) || {}).id || null)
  `);

  await evaluate(workerCdp, `
    chrome.tabs.sendMessage(${tabId}, {
      cmd: "browserAgentOwnerChanged",
      owner: { tab_id: ${tabId}, cue_id: "seam-qa", status: "listening" },
      isOwner: true,
      presentation: { cue_id: "seam-qa", user_text: ${JSON.stringify(USER_TEXT)}, status: "listening" },
    }).then(() => true).catch(() => false)
  `);
  await delay(250);
  const placed = await evaluate(pageCdp, MEASURE);
  const beforeShot = await shot(pageCdp, "01-user-line");

  // Now the reply, sampled while it reveals.
  const samples = [];
  await evaluate(pageCdp, `
    (() => {
      const el = document.querySelector("#agee-ribbon-reply .agee-ribbon-text");
      window.__seamSamples = [];
      window.__seamTimer = setInterval(() => {
        window.__seamSamples.push({ at: Math.round(performance.now()), len: (el.textContent || "").length });
      }, 60);
      return true;
    })()
  `);
  await evaluate(workerCdp, `
    chrome.tabs.sendMessage(${tabId}, {
      cmd: "browserAgentOwnerChanged",
      owner: { tab_id: ${tabId}, cue_id: "seam-qa", status: "responding" },
      isOwner: true,
      presentation: {
        cue_id: "seam-qa",
        user_text: ${JSON.stringify(USER_TEXT)},
        response_text: ${JSON.stringify(REPLY_TEXT)},
        status: "responding",
      },
    }).then(() => true).catch(() => false)
  `);
  await delay(700);
  const midShot = await shot(pageCdp, "02-reply-revealing");
  await delay(2400);
  const samplesOut = await evaluate(pageCdp, `
    (() => { clearInterval(window.__seamTimer); return window.__seamSamples || []; })()
  `);
  samples.push(...(samplesOut || []));
  const afterShot = await shot(pageCdp, "03-reply-settled");
  const settled = await evaluate(pageCdp, MEASURE);

  console.log(JSON.stringify({ placed, settled, samples: samples.slice(0, 40) }, null, 2));
  console.log(`shots: ${beforeShot}\n       ${midShot}\n       ${afterShot}`);

  } finally {
    for (const cdp of [pageCdp, workerCdp]) {
      try { cdp?.close(); } catch {}
    }
    try {
      if (chrome && chrome.exitCode == null) chrome.kill();
    } catch {}
    if (server?.listening) {
      await new Promise((resolveClose) => server.close(resolveClose));
    }
  }
}

main().catch((error) => {
  console.error(String(error?.stack || error));
  process.exit(1);
});
