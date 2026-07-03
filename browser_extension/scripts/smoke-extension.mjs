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

function installRuntimeMessageProbeInPage() {
  window.__ageeSmokeRuntimeMessages = [];
  if (window.__ageeSmokeRuntimeProbeInstalled) return { ok: true, reused: true };
  try {
    const original = chrome?.runtime?.sendMessage;
    if (typeof original !== "function") return { ok: false, error: "chrome.runtime.sendMessage missing" };
    window.__ageeSmokeRuntimeSendMessageOriginal = original.bind(chrome.runtime);
    const wrapped = (...args) => {
      try {
        const message = args[0];
        window.__ageeSmokeRuntimeMessages.push(
          message && typeof message === "object" ? JSON.parse(JSON.stringify(message)) : message,
        );
      } catch {
        window.__ageeSmokeRuntimeMessages.push("[unserializable message]");
      }
      return window.__ageeSmokeRuntimeSendMessageOriginal(...args);
    };
    wrapped.__ageeSmokeProbe = true;
    chrome.runtime.sendMessage = wrapped;
    if (chrome.runtime.sendMessage !== wrapped) {
      return { ok: false, error: "chrome.runtime.sendMessage was not replaceable" };
    }
    window.__ageeSmokeRuntimeProbeInstalled = true;
    return { ok: true, reused: false };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

function readTextSurfaceStateInPage() {
  const root = document.querySelector("#agee-root");
  const launcher = document.querySelector("#agee-launcher");
  const panel = document.querySelector("#agee-panel");
  const input = document.querySelector("#agee-input");
  const voice = document.querySelector("#agee-voice");
  const transcript = document.querySelector("#agee-transcript");
  const messages = Array.isArray(window.__ageeSmokeRuntimeMessages)
    ? window.__ageeSmokeRuntimeMessages
    : [];
  const runtimeVoiceMessages = messages.filter((message) => {
    if (!message || typeof message !== "object") return false;
    const cmd = String(message.cmd || "");
    return /voice/i.test(cmd) || message.capture === "extension-offscreen";
  });
  return {
    rootPresent: !!root,
    launcherPresent: !!launcher,
    panelPresent: !!panel,
    inputPresent: !!input,
    inputTag: input?.tagName?.toLowerCase() || "",
    inputPlaceholder: input?.getAttribute("placeholder") || "",
    inputValue: input?.value || "",
    panelRole: panel?.getAttribute("role") || "",
    open: !!root?.classList.contains("agee-open"),
    activeInput: document.activeElement === input,
    voicing: !!root?.classList.contains("agee-voicing"),
    stateListening: !!root?.classList.contains("agee-state-listening"),
    stateThinking: !!root?.classList.contains("agee-state-thinking"),
    stateSpeaking: !!root?.classList.contains("agee-state-speaking"),
    voiceButtonListening: !!voice?.classList.contains("listening"),
    voiceAria: voice?.getAttribute("aria-label") || "",
    voiceTitle: voice?.getAttribute("title") || "",
    transcriptText: transcript?.textContent || "",
    runtimeProbeInstalled: window.__ageeSmokeRuntimeProbeInstalled === true,
    runtimeMessages: messages,
    runtimeVoiceMessages,
  };
}

async function executeInTab(workerCdp, tabId, func, args = []) {
  return evaluate(workerCdp, `
    (async () => {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: ${JSON.stringify(tabId)} },
        func: ${func.toString()},
        args: ${JSON.stringify(args)},
      });
      return result?.result;
    })()
  `);
}

async function sendTabMessage(workerCdp, tabId, message) {
  return evaluate(workerCdp, `
    chrome.tabs.sendMessage(${JSON.stringify(tabId)}, ${JSON.stringify(message)})
  `);
}

async function resetRuntimeProbe(workerCdp, tabId) {
  return executeInTab(workerCdp, tabId, installRuntimeMessageProbeInPage);
}

async function readTextSurfaceState(workerCdp, tabId) {
  return executeInTab(workerCdp, tabId, readTextSurfaceStateInPage);
}

async function waitForTextSurface(workerCdp, tabId, label, timeoutMs = 3000) {
  const started = Date.now();
  let lastState;
  while (Date.now() - started < timeoutMs) {
    lastState = await readTextSurfaceState(workerCdp, tabId).catch((error) => ({
      error: String(error?.message || error),
    }));
    if (lastState?.open && lastState?.activeInput) return lastState;
    await delay(80);
  }
  throw new Error(`${label} did not open the typed surface: ${JSON.stringify(lastState)}`);
}

async function closeTextSurfaceIfOpen(workerCdp, tabId) {
  const state = await readTextSurfaceState(workerCdp, tabId);
  if (state?.open) {
    await sendTabMessage(workerCdp, tabId, { cmd: "toggle" });
    await delay(100);
  }
  const closed = await readTextSurfaceState(workerCdp, tabId);
  if (closed?.open) throw new Error(`typed surface did not close during smoke reset: ${JSON.stringify(closed)}`);
  await resetRuntimeProbe(workerCdp, tabId);
}

async function clickLauncher(pageCdp) {
  const point = await waitForEval(pageCdp, `
    (() => {
      const launcher = document.querySelector("#agee-launcher");
      if (!launcher) return null;
      const rect = launcher.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()
  `);
  await pageCdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
  });
  await pageCdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
  });
}

async function pressTextHotkey(pageCdp) {
  const event = {
    key: ",",
    code: "Comma",
    windowsVirtualKeyCode: 188,
    nativeVirtualKeyCode: 188,
    modifiers: 2,
  };
  await pageCdp.send("Input.dispatchKeyEvent", { ...event, type: "rawKeyDown" });
  await pageCdp.send("Input.dispatchKeyEvent", { ...event, type: "keyUp" });
}

function comparableTextSurfaceState(state) {
  return {
    rootPresent: state?.rootPresent === true,
    launcherPresent: state?.launcherPresent === true,
    panelPresent: state?.panelPresent === true,
    panelRole: state?.panelRole || "",
    inputPresent: state?.inputPresent === true,
    inputTag: state?.inputTag || "",
    inputPlaceholder: state?.inputPlaceholder || "",
    inputValue: state?.inputValue || "",
    open: state?.open === true,
    activeInput: state?.activeInput === true,
    voicing: state?.voicing === true,
    stateListening: state?.stateListening === true,
    stateThinking: state?.stateThinking === true,
    stateSpeaking: state?.stateSpeaking === true,
    voiceButtonListening: state?.voiceButtonListening === true,
    voiceAria: state?.voiceAria || "",
    voiceTitle: state?.voiceTitle || "",
    transcriptText: state?.transcriptText || "",
  };
}

function assertTextSurfaceOpenWithoutVoice(label, state) {
  const missing = ["rootPresent", "launcherPresent", "panelPresent", "inputPresent"]
    .filter((key) => state?.[key] !== true);
  if (missing.length) throw new Error(`${label} missing typed surface nodes: ${JSON.stringify(state)}`);
  if (state.inputTag !== "textarea" || state.inputPlaceholder !== "Ask Aggie" || state.panelRole !== "dialog") {
    throw new Error(`${label} did not expose the expected typed command surface: ${JSON.stringify(state)}`);
  }
  if (!state.open || !state.activeInput) {
    throw new Error(`${label} did not open and focus #agee-input: ${JSON.stringify(state)}`);
  }
  if (state.voicing || state.stateListening || state.stateThinking || state.stateSpeaking || state.voiceButtonListening) {
    throw new Error(`${label} started voice state instead of text-only open: ${JSON.stringify(state)}`);
  }
  if (state.voiceAria !== "Start voice" || state.voiceTitle !== "Start voice" || state.transcriptText) {
    throw new Error(`${label} left voice controls in a non-idle state: ${JSON.stringify(state)}`);
  }
  if (state.runtimeProbeInstalled && state.runtimeVoiceMessages?.length) {
    throw new Error(`${label} sent voice runtime messages: ${JSON.stringify(state.runtimeVoiceMessages)}`);
  }
}

function assertSameTextSurfaceState(label, expected, actual) {
  const expectedComparable = comparableTextSurfaceState(expected);
  const actualComparable = comparableTextSurfaceState(actual);
  if (JSON.stringify(actualComparable) !== JSON.stringify(expectedComparable)) {
    throw new Error(`${label} did not match single-click text-open state: ${JSON.stringify({
      expected: expectedComparable,
      actual: actualComparable,
    })}`);
  }
}

function assertVoicePlaybackStopContract() {
  const source = readFileSync(join(extensionPath, "content.js"), "utf8");
  const background = readFileSync(join(extensionPath, "background.js"), "utf8");
  const offscreen = readFileSync(join(extensionPath, "offscreen.js"), "utf8");
  const offscreenWorklet = readFileSync(join(extensionPath, "offscreen-audio-worklet.js"), "utf8");
  if (!/assistantPlaybackSources\s*=\s*new Set\(\)/.test(source)) {
    throw new Error("content.js must keep a global assistant PCM playback source registry");
  }
  if (!/function stopSpeaking\(\)\s*\{\s*stopAllAssistantPlayback\(\);/.test(source)) {
    throw new Error("stopSpeaking() must stop queued assistant PCM playback, not only update UI state");
  }
  if (!/assistantPlaybackSources\.add\(source\)/.test(source)) {
    throw new Error("assistant PCM buffer sources must register with the global playback stop path");
  }
  if (/mediaDevices\.getUserMedia/.test(source)) {
    throw new Error("content.js must not request page-owned microphone access");
  }
  if (!/capture:\s*"extension-offscreen"/.test(source)) {
    throw new Error("content.js must request extension-owned offscreen microphone capture");
  }
  if (!/chrome\.offscreen\.createDocument/.test(background) || !/USER_MEDIA/.test(background)) {
    throw new Error("background.js must create an offscreen USER_MEDIA document for voice capture");
  }
  if (!/navigator\.mediaDevices\.getUserMedia/.test(offscreen) || !/offscreenVoiceAudio/.test(offscreen)) {
    throw new Error("offscreen.js must own getUserMedia and forward PCM audio to background.js");
  }
  if (
    !/audioWorklet\.addModule/.test(offscreen) ||
    !/new\s+AudioWorkletNode/.test(offscreen) ||
    /createScriptProcessor|ScriptProcessorNode/.test(offscreen) ||
    !/registerProcessor\("aggie-voice-capture"/.test(offscreenWorklet)
  ) {
    throw new Error("offscreen microphone capture must use AudioWorklet, not deprecated ScriptProcessorNode capture");
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
  if (!/function safeRuntimeSendMessage/.test(source) || !/function safeStorageLocalGet/.test(source) || !/function safeStorageLocalSet/.test(source)) {
    throw new Error("content.js must guard runtime and storage calls against stale extension contexts");
  }
  if (!/voiceButton\.addEventListener\("click"[\s\S]{0,220}openTextSurface\(\{\s*fresh:\s*false\s*\}\);[\s\S]{0,120}primeAudio\(\);[\s\S]{0,120}toggleVoice\(\);/.test(source)) {
    throw new Error("voice button click must open the input surface and prime audio before starting live voice");
  }
  if (!/msg\.type === "transcript_partial"[\s\S]{0,520}ensureVoiceCueCard\(state, text/.test(source)) {
    throw new Error("live voice transcript must render in cue cards above the input");
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
  let page2Cdp;
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

    const { targetId: secondTargetId } = await browserCdp.send("Target.createTarget", { url: "about:blank" });
    const secondPageTarget = await waitForTarget(devToolsPort, (target) => target.type === "page" && target.id === secondTargetId);
    page2Cdp = new Cdp(secondPageTarget.webSocketDebuggerUrl);
    await page2Cdp.send("Runtime.enable");
    await page2Cdp.send("Page.enable");
    await page2Cdp.send("Page.navigate", { url: `${demoUrl}?owner=2` });
    await waitForEval(page2Cdp, `location.href.includes(${JSON.stringify("/fixtures/demo.html?owner=2")}) && document.readyState === "complete"`);

    // Drive the real background -> content path from the service worker, exactly
    // as production does (background.js uses chrome.tabs.sendMessage). A reply
    // proves the real content script auto-injected on the localhost match.
    workerCdp = new Cdp(workerTarget.webSocketDebuggerUrl);
    await workerCdp.send("Runtime.enable");

    const commands = await evaluate(workerCdp, "chrome.commands.getAll()");
    const textCommand = commands.find((command) => command.name === "toggle-agee");
    if (!textCommand) throw new Error(`text command was not registered: ${JSON.stringify(commands)}`);
    const textShortcut = textCommand.shortcut || "page-level listener";
    const voiceCommand = commands.find((command) => command.name === "toggle-agee-voice");
    if (!voiceCommand) throw new Error(`voice command was not registered: ${JSON.stringify(commands)}`);
    const voiceShortcut = voiceCommand.shortcut || "page-level listener";

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

    const singleRootResult = await evaluate(workerCdp, `
      (async () => {
        const tabId = ${ping.tabId};
        await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            const duplicate = document.createElement("div");
            duplicate.id = "agee-root";
            duplicate.dataset.stale = "true";
            document.body.appendChild(duplicate);
          },
        });
        await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
        const [result] = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => ({
            rootCount: document.querySelectorAll("#agee-root").length,
            staleCount: document.querySelectorAll('#agee-root[data-stale="true"]').length,
          }),
        });
        return result?.result;
      })()
    `);
    if (singleRootResult?.rootCount !== 1 || singleRootResult?.staleCount !== 0) {
      throw new Error(`content reinjection did not collapse duplicate Aggie roots: ${JSON.stringify(singleRootResult)}`);
    }

    await browserCdp.send("Target.activateTarget", { targetId });
    await closeTextSurfaceIfOpen(workerCdp, ping.tabId);

    await clickLauncher(pageCdp);
    const launcherOpenState = await waitForTextSurface(workerCdp, ping.tabId, "launcher single click/tap");
    assertTextSurfaceOpenWithoutVoice("launcher single click/tap", launcherOpenState);

    await closeTextSurfaceIfOpen(workerCdp, ping.tabId);
    await pressTextHotkey(pageCdp);
    const textHotkeyOpenState = await waitForTextSurface(workerCdp, ping.tabId, "Cmd/Ctrl+, page hotkey");
    assertTextSurfaceOpenWithoutVoice("Cmd/Ctrl+, page hotkey", textHotkeyOpenState);
    assertSameTextSurfaceState("Cmd/Ctrl+, page hotkey", launcherOpenState, textHotkeyOpenState);

    await resetRuntimeProbe(workerCdp, ping.tabId);
    await pressTextHotkey(pageCdp);
    const repeatedTextHotkeyState = await waitForTextSurface(workerCdp, ping.tabId, "repeated Cmd/Ctrl+, page hotkey");
    assertTextSurfaceOpenWithoutVoice("repeated Cmd/Ctrl+, page hotkey", repeatedTextHotkeyState);
    assertSameTextSurfaceState("repeated Cmd/Ctrl+, page hotkey", launcherOpenState, repeatedTextHotkeyState);

    await closeTextSurfaceIfOpen(workerCdp, ping.tabId);
    await sendTabMessage(workerCdp, ping.tabId, { cmd: "open" });
    const serviceWorkerOpenState = await waitForTextSurface(workerCdp, ping.tabId, "service-worker open command");
    assertTextSurfaceOpenWithoutVoice("service-worker open command", serviceWorkerOpenState);
    assertSameTextSurfaceState("service-worker open command", launcherOpenState, serviceWorkerOpenState);

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
            root.classList.add("agee-voicing", "agee-state-listening");
            const voiceStateDisplayWhenVoicing = getComputedStyle(voiceState).display;
            root.classList.remove("agee-voicing", "agee-state-listening");
            return {
              ok: true,
              rootCount: document.querySelectorAll("#agee-root").length,
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
              voiceStateDisplayWhenVoicing,
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
    if (overlayMetrics.rootCount !== 1) throw new Error(`expected one Aggie root, got: ${JSON.stringify(overlayMetrics)}`);
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
    if (overlayMetrics.voiceStateDisplayWhenVoicing !== "none") {
      throw new Error(`overlay exposed separate top voice strip during voice: ${JSON.stringify(overlayMetrics)}`);
    }

    const resultPlacement = await evaluate(workerCdp, `
      (async () => {
        const tabId = ${ping.tabId};
        await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            const input = document.querySelector("#agee-input");
            if (input) {
              input.value = "draft must stay";
              input.dispatchEvent(new Event("input", { bubbles: true }));
            }
          },
        });
        await chrome.tabs.sendMessage(tabId, { cmd: "done", cueId: "smoke-result-placement", summary: "Smoke reply stays above the input." });
        await new Promise((resolve) => setTimeout(resolve, 80));
        const [result] = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            const input = document.querySelector("#agee-input");
            const log = document.querySelector("#agee-log");
            const cue = log ? log.querySelector(".agee-cue, .agee-row") : null;
            const inputRect = input?.getBoundingClientRect();
            const cueRect = cue?.getBoundingClientRect();
            return {
              inputValue: input ? input.value : null,
              logText: log ? log.textContent : "",
              cueAboveInput: !!(inputRect && cueRect && cueRect.bottom <= inputRect.top + 1),
            };
          },
        });
        return result?.result;
      })()
    `);
    if (resultPlacement?.inputValue !== "draft must stay" || !String(resultPlacement?.logText || "").includes("Smoke reply stays above the input.")) {
      throw new Error(`reply changed the command input draft: ${JSON.stringify(resultPlacement)}`);
    }
    if (!resultPlacement?.cueAboveInput) {
      throw new Error(`result cue did not render above the command input: ${JSON.stringify(resultPlacement)}`);
    }

    const workerResult = await evaluate(workerCdp, `
      (async () => {
        const tabId = ${ping.tabId};
        const snapshot = await chrome.tabs.sendMessage(tabId, { cmd: "snapshot" });
        const input = snapshot.elements.find((el) => el.tag === "input" && el.label.includes("Type something"));
        const button = snapshot.elements.find((el) => el.tag === "button" && el.label === "Search");
        if (!input || !button) return { ok: false, error: "expected demo controls missing", snapshot };
        const pageText = String(snapshot.pageText || "");
        if (!pageText.includes("Use this page for a low-risk extension smoke test") || !pageText.includes("Search query")) {
          return { ok: false, error: "expected visible page text missing", snapshot };
        }
        await chrome.tabs.sendMessage(tabId, { cmd: "act", action: "type", index: input.i, text: "browser agent" });
        await chrome.tabs.sendMessage(tabId, { cmd: "act", action: "click", index: button.i });
        return { ok: true, elements: snapshot.elements.length, visibleTextChars: pageText.length, url: snapshot.url, title: snapshot.title };
      })()
    `);
    if (!workerResult?.ok) throw new Error(workerResult?.error || "service-worker smoke failed");

    const ownershipResult = await evaluate(workerCdp, `
      (async () => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const readOwner = async () => {
          const stored = await chrome.storage.local.get("ageeActiveBrowserAgentOwner");
          return stored.ageeActiveBrowserAgentOwner || null;
        };
        const waitForOwner = async (tabId) => {
          let last = null;
          for (let i = 0; i < 60; i += 1) {
            last = await readOwner();
            if (last && last.tab_id === tabId) return last;
            await sleep(100);
          }
          return last;
        };
        const tabs = await chrome.tabs.query({ url: "http://localhost:*/*" });
        const demoTabs = tabs.filter((tab) => String(tab.url || "").includes("/fixtures/demo.html"));
        const tabA = demoTabs.find((tab) => !String(tab.url || "").includes("owner=2"));
        const tabB = demoTabs.find((tab) => String(tab.url || "").includes("owner=2"));
        if (!tabA || !tabB) return { ok: false, error: "two demo tabs missing", demoTabs };

        await chrome.storage.local.remove("ageeActiveBrowserAgentOwner");
        await chrome.tabs.sendMessage(tabA.id, { cmd: "open" });
        await chrome.tabs.sendMessage(tabB.id, { cmd: "open" });
        await chrome.scripting.executeScript({
          target: { tabId: tabA.id },
          func: () => {
            window.__ageeLastAgentRevoked = null;
            window.__ageeBrowserAgentOwner = null;
            window.__ageeBrowserAgentOwnerState = "unknown";
          },
        });
        await chrome.scripting.executeScript({
          target: { tabId: tabB.id },
          func: () => {
            window.__ageeLastAgentRevoked = null;
            window.__ageeBrowserAgentOwner = null;
            window.__ageeBrowserAgentOwnerState = "unknown";
          },
        });

        await chrome.scripting.executeScript({
          target: { tabId: tabA.id },
          args: [tabA.url],
          func: (url) => {
            chrome.runtime.sendMessage({
              cmd: "branch",
              cueId: "owner-a",
              instruction: "cross-tab ownership smoke A",
              url,
            }).catch(() => {});
          },
        });
        const ownerA = await waitForOwner(tabA.id);

        await chrome.scripting.executeScript({
          target: { tabId: tabB.id },
          func: () => {
            chrome.runtime.sendMessage({
              cmd: "run",
              cueId: "owner-b",
              instruction: "cross-tab ownership smoke B",
            }).catch(() => {});
          },
        });
        const ownerB = await waitForOwner(tabB.id);
        await sleep(350);

        const [stateA] = await chrome.scripting.executeScript({
          target: { tabId: tabA.id },
          func: () => {
            const root = document.querySelector("#agee-root");
            return {
              ownerState: window.__ageeBrowserAgentOwnerState || null,
              owner: window.__ageeBrowserAgentOwner || null,
              revoked: window.__ageeLastAgentRevoked || null,
              rootOwner: root?.dataset?.ageeOwner || null,
              lastRevokedReason: root?.dataset?.ageeLastRevokedReason || "",
            };
          },
        });
        const [stateB] = await chrome.scripting.executeScript({
          target: { tabId: tabB.id },
          func: () => {
            const root = document.querySelector("#agee-root");
            return {
              ownerState: window.__ageeBrowserAgentOwnerState || null,
              owner: window.__ageeBrowserAgentOwner || null,
              revoked: window.__ageeLastAgentRevoked || null,
              rootOwner: root?.dataset?.ageeOwner || null,
              ownerStatus: root?.dataset?.ageeOwnerStatus || "",
              ownerCue: root?.dataset?.ageeOwnerCue || "",
            };
          },
        });

        const a = stateA?.result || {};
        const b = stateB?.result || {};
        const ok =
          ownerA?.tab_id === tabA.id &&
          ownerB?.tab_id === tabB.id &&
          b.ownerState === "active" &&
          b.rootOwner === "active" &&
          a.ownerState !== "active" &&
          a.rootOwner !== "active" &&
          Array.isArray(a.revoked?.cueIds) &&
          a.revoked.cueIds.includes("owner-a");
        return {
          ok,
          tabA: tabA.id,
          tabB: tabB.id,
          ownerA,
          ownerB,
          stateA: a,
          stateB: b,
        };
      })()
    `);
    if (!ownershipResult?.ok) {
      throw new Error(`cross-tab browser agent ownership smoke failed: ${JSON.stringify(ownershipResult)}`);
    }

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
        `service worker loaded id=${extensionId}, text shortcut=${textShortcut}, voice shortcut=${voiceShortcut}, ${workerResult.elements} elements observed via background->content, ` +
        `basic open paths checked (launcher click/tap, Cmd/Ctrl+, service-worker open), ` +
        `${workerResult.visibleTextChars} visible text chars observed, ` +
        `compact overlay checked (${overlayMetrics.panelWidth}x${overlayMetrics.panelHeight}), ` +
        `cross-tab owner moved ${ownershipResult.tabA}->${ownershipResult.tabB} with old tab revoked, ` +
        `type+click executed, demo result "${resultText}", no window shown, no focus taken.`,
    );
    console.log(`screenshot: ${screenshotPath}`);
  } finally {
    pageCdp?.close();
    page2Cdp?.close();
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
