// Quiet headless smoke for the REAL agee extension.
//
// Launches Chrome for Testing with --headless=new and a throwaway profile under
// .gstack/background-qa/<run>/, loads the unpacked extension/, and drives the
// real background service worker -> content script message path against the demo
// page. No visible window, no focus steal, no prompts, never the daily profile.
//
// Branded Google Chrome hard-blocks --load-extension. If the resolved binary
// ever refuses it we fail loudly instead of silently falling back to a
// content-script harness — the whole point is to exercise the real extension.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { resolveChromeForTesting, quietChromeArgs } from "./chrome-for-testing.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const extensionPath = join(root, "extension");
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const runDir = join(root, ".gstack", "background-qa", `smoke-${runId}`);
const profilePath = join(runDir, "chrome-profile");
const artifactsDir = join(runDir, "artifacts");
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
      const address = server.address();
      resolveServer({ server, port: address.port });
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

async function waitForEval(cdp, expression, timeoutMs = 12000) {
  const started = Date.now();
  let lastValue;
  while (Date.now() - started < timeoutMs) {
    lastValue = await evaluate(cdp, expression).catch(() => undefined);
    if (lastValue) return lastValue;
    await delay(150);
  }
  throw new Error(`Timed out waiting for expression: ${expression}; last=${JSON.stringify(lastValue)}`);
}

function assertVoicePlaybackStopContract() {
  const source = readFileSync(join(extensionPath, "content.js"), "utf8");
  const background = readFileSync(join(extensionPath, "background.js"), "utf8");
  if (!/assistantPlaybackSources\s*=\s*new Set\(\)/.test(source)) {
    throw new Error("content.js must keep a global assistant PCM playback source registry");
  }
  if (!/function stopSpeaking\(\)\s*\{\s*stopAllAssistantPlayback\(\);/.test(source)) {
    throw new Error("stopSpeaking() must stop queued assistant PCM playback, not only update UI state");
  }
  if (!/assistantPlaybackSources\.add\(source\)/.test(source)) {
    throw new Error("assistant PCM buffer sources must register with the global playback stop path");
  }
  if (!/if \(liveVoice !== state \|\| !state\.sessionReady \|\| state\.committed\) return;/.test(source)) {
    throw new Error("the active microphone pump must stop when a different live voice turn becomes current");
  }
  if (!/liveVoiceBySessionId\s*=\s*new Map\(\)/.test(source)) {
    throw new Error("content.js must keep active voice sessions addressable by voiceSessionId");
  }
  if (!/if \(!preserveAssistantPlayback\)\s*\{\s*stopSpeaking\(\);/.test(source)) {
    throw new Error("live voice startup must not always stop assistant playback");
  }
  if (!/liveVoiceBySessionId\.get\(msg\.voiceSessionId\)/.test(source)) {
    throw new Error("voice-session events must route to their owning state, not only the newest liveVoice");
  }
  if (!/playback_policy:\s*\{\s*assistant_overlap:\s*assistantOverlap === true/.test(background)) {
    throw new Error("background.js must send assistant_overlap playback policy to the gateway");
  }
}

async function main() {
  assertVoicePlaybackStopContract();
  const chromePath = resolveChromeForTesting();
  const { server, port: serverPort } = await serve();
  mkdirSync(profilePath, { recursive: true });
  mkdirSync(artifactsDir, { recursive: true });

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

    // Create a page target explicitly: --headless=new does not auto-open one.
    const browserInfo = await fetch(`http://127.0.0.1:${devToolsPort}/json/version`).then((resp) => resp.json());
    browserCdp = new Cdp(browserInfo.webSocketDebuggerUrl);
    const { targetId } = await browserCdp.send("Target.createTarget", { url: "about:blank" });
    const pageTarget = await waitForTarget(devToolsPort, (target) => target.type === "page" && target.id === targetId);

    pageCdp = new Cdp(pageTarget.webSocketDebuggerUrl);
    await pageCdp.send("Runtime.enable");
    await pageCdp.send("Page.enable");
    await pageCdp.send("Page.navigate", { url: demoUrl });
    await waitForEval(pageCdp, `location.href.startsWith(${JSON.stringify(demoUrl)}) && document.readyState === "complete"`);

    // Drive the real background -> content path from the service worker, exactly
    // as production does (background.js uses chrome.tabs.sendMessage). A reply
    // proves the real content script auto-injected on the localhost match.
    workerCdp = new Cdp(workerTarget.webSocketDebuggerUrl);
    await workerCdp.send("Runtime.enable");

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

    const overlayMetrics = await evaluate(workerCdp, `
      (async () => {
        const tabId = ${ping.tabId};
        await chrome.tabs.sendMessage(tabId, { cmd: "open" });
        await new Promise((resolve) => setTimeout(resolve, 80));
        const [result] = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            const root = document.querySelector("#agee-root");
            const panel = document.querySelector("#agee-panel");
            const input = document.querySelector("#agee-input");
            const voice = document.querySelector("#agee-voice");
            const stop = document.querySelector("#agee-stop");
            const log = document.querySelector("#agee-log");
            const voiceState = document.querySelector("#agee-voice-state");
            if (!root || !panel || !input || !voice || !stop || !log || !voiceState) {
              return { ok: false, error: "overlay nodes missing" };
            }
            const panelRect = panel.getBoundingClientRect();
            const voiceRect = voice.getBoundingClientRect();
            const stopStyle = getComputedStyle(stop);
            const logStyle = getComputedStyle(log);
            const voiceStateStyle = getComputedStyle(voiceState);
            const voiceStyle = getComputedStyle(voice);
            return {
              ok: true,
              open: root.classList.contains("agee-open"),
              panelWidth: Math.round(panelRect.width),
              panelHeight: Math.round(panelRect.height),
              viewportWidth: window.innerWidth,
              voiceWidth: Math.round(voiceRect.width),
              voiceHeight: Math.round(voiceRect.height),
              voiceFontSize: voiceStyle.fontSize,
              stopDisplayWhenIdle: stopStyle.display,
              logDisplay: logStyle.display,
              voiceStateDisplay: voiceStateStyle.display,
              panelOverflowX: panel.scrollWidth > panel.clientWidth + 1,
              inputOverflowX: input.scrollWidth > input.clientWidth + 1,
              activeInput: document.activeElement === input,
            };
          },
        });
        return result?.result;
      })()
    `);
    if (!overlayMetrics?.ok) throw new Error(overlayMetrics?.error || "overlay metrics missing");
    if (!overlayMetrics.open || !overlayMetrics.activeInput) throw new Error(`overlay did not open and focus input: ${JSON.stringify(overlayMetrics)}`);
    if (overlayMetrics.panelWidth > Math.min(540, overlayMetrics.viewportWidth - 24) + 1) {
      throw new Error(`overlay panel exceeded compact width: ${JSON.stringify(overlayMetrics)}`);
    }
    if (overlayMetrics.panelHeight > 120 || overlayMetrics.panelOverflowX || overlayMetrics.inputOverflowX) {
      throw new Error(`overlay compact layout overflowed: ${JSON.stringify(overlayMetrics)}`);
    }
    if (overlayMetrics.voiceWidth < 30 || overlayMetrics.voiceHeight < 30 || overlayMetrics.voiceFontSize !== "0px") {
      throw new Error(`voice control is not stable icon-only UI: ${JSON.stringify(overlayMetrics)}`);
    }
    if (overlayMetrics.stopDisplayWhenIdle !== "none" || overlayMetrics.logDisplay !== "none" || overlayMetrics.voiceStateDisplay !== "none") {
      throw new Error(`overlay exposed hidden history/voice surfaces while idle: ${JSON.stringify(overlayMetrics)}`);
    }

    const workerResult = await evaluate(workerCdp, `
      (async () => {
        const tabId = ${ping.tabId};
        const snapshot = await chrome.tabs.sendMessage(tabId, { cmd: "snapshot" });
        const input = snapshot.elements.find((el) => el.tag === "input" && el.label.includes("Type something"));
        const button = snapshot.elements.find((el) => el.tag === "button" && el.label === "Search");
        if (!input || !button) return { ok: false, error: "expected demo controls missing", snapshot };
        await chrome.tabs.sendMessage(tabId, { cmd: "act", action: "type", index: input.i, text: "browser agent" });
        await chrome.tabs.sendMessage(tabId, { cmd: "act", action: "click", index: button.i });
        return { ok: true, elements: snapshot.elements.length, url: snapshot.url, title: snapshot.title };
      })()
    `);
    if (!workerResult?.ok) throw new Error(workerResult?.error || "service-worker smoke failed");

    const screenshot = await pageCdp.send("Page.captureScreenshot", { format: "jpeg", quality: 40 });
    if (!screenshot?.data) throw new Error("page screenshot capture failed");
    const screenshotPath = join(artifactsDir, "demo.jpg");
    writeFileSync(screenshotPath, Buffer.from(screenshot.data, "base64"));

    const resultText = await evaluate(pageCdp, "document.querySelector('#results').textContent");
    if (resultText !== "Searched Docs: browser agent") {
      throw new Error(`unexpected demo result: ${resultText}`);
    }

    console.log(
      `extension smoke passed (REAL extension, headless Chrome for Testing): ` +
        `service worker loaded id=${extensionId}, ${workerResult.elements} elements observed via background->content, ` +
        `compact overlay checked (${overlayMetrics.panelWidth}x${overlayMetrics.panelHeight}), ` +
        `type+click executed, demo result "${resultText}", no window shown, no focus taken.`,
    );
    console.log(`screenshot: ${screenshotPath}`);
  } finally {
    pageCdp?.close();
    workerCdp?.close();
    browserCdp?.close();
    server.close();
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
