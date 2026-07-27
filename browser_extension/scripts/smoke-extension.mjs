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
const CDP_CALL_TIMEOUT_MS = 15000;
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
      const timer = setTimeout(
        () => rejectReady(new Error(`Timed out after ${CDP_CALL_TIMEOUT_MS} ms opening CDP connection`)),
        CDP_CALL_TIMEOUT_MS,
      );
      this.ws.onopen = () => {
        clearTimeout(timer);
        resolveReady();
      };
      this.ws.onerror = (error) => {
        clearTimeout(timer);
        rejectReady(error);
      };
    });
    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (!msg.id || !this.pending.has(msg.id)) return;
      const { resolveCall, rejectCall, timer } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(timer);
      if (msg.error) rejectCall(new Error(`${msg.error.message}: ${msg.error.data || ""}`));
      else resolveCall(msg.result);
    };
    this.ws.onclose = () => {
      for (const [id, { rejectCall, timer }] of this.pending) {
        clearTimeout(timer);
        rejectCall(new Error(`CDP connection closed while waiting for call ${id}`));
      }
      this.pending.clear();
    };
  }

  async send(method, params = {}, timeoutMs = CDP_CALL_TIMEOUT_MS) {
    await this.ready;
    const id = this.nextId++;
    return new Promise((resolveCall, rejectCall) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectCall(new Error(`Timed out after ${timeoutMs} ms waiting for CDP ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolveCall, rejectCall, timer });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        rejectCall(error);
      }
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
  let result;
  try {
    result = await cdp.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
  } catch (error) {
    const summary = String(expression || "").replace(/\s+/g, " ").trim().slice(0, 180);
    throw new Error(`${String(error?.message || error)}; expression=${summary}`);
  }
  if (result.exceptionDetails) {
    // Newer Chrome puts the useful message in exception.description and leaves
    // text as a bare "Uncaught".
    const description = result.exceptionDetails.exception?.description;
    const text = result.exceptionDetails.text;
    const detail = [text, description].filter(Boolean).join(": ");
    throw new Error(detail || "Runtime evaluation failed");
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
  const overlayCss = readFileSync(join(extensionPath, "overlay.css"), "utf8");
  const sidepanelHtml = readFileSync(join(extensionPath, "sidepanel.html"), "utf8");
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
  if (!/voiceButton\.addEventListener\("click"[\s\S]{0,220}openTextSurface\(\{\s*fresh:\s*false\s*\}\);[\s\S]{0,120}primeAudio\(\);[\s\S]{0,180}toggleVoice\(\{\s*warmCaptureId: takeGestureVoiceWarmup\(\)\s*\}\);/.test(source)) {
    throw new Error("voice button click must open the input surface and prime audio before starting live voice");
  }
  if (!/origin === "single"\) beginCurrentThreadSteeringCapture\(replacement\)/.test(source)) {
    throw new Error("single-click current-thread capture must use an explicit steering boundary");
  }
  if (!/if \(state\.assistantSpeechSuppressed\) return;/.test(source)) {
    throw new Error("steered stale turns must suppress later assistant PCM locally");
  }
  if (!/formatSteeredAssistantText\(text, state\.steeringBoundaryText\)/.test(source)) {
    throw new Error("steered stale turns must retain a visible accepted-text boundary");
  }
  const steeringBody = source.match(/function beginCurrentThreadSteeringCapture\(replacement\)[\s\S]*?return silencedTurns;/)?.[0] || "";
  if (!/sendLiveVoiceControl/.test(steeringBody) || !/closeLiveVoiceSession/.test(steeringBody)
      || !/message\.next_turn_id = replacement\.turnId/.test(source)
      || !/message\.boundary_id = replacement\.boundaryId/.test(source)) {
    throw new Error("steering must cancel immediately with durable replacement identity");
  }
  if (!/state\?\.steeredAtGeneration && state\.steeredAtGeneration <= steeringGeneration/.test(source)) {
    throw new Error("late stale voice events must fail closed at the steering generation boundary");
  }
  if (!/msg\.type === "transcript_partial"[\s\S]{0,520}ensureVoiceCueCard\(state, text/.test(source)) {
    throw new Error("live voice transcript must render in cue cards above the input");
  }
  if (
    !/createCue\(cueId, "Starting microphone…", \{ presentation: "card", statusText: "starting…" \}\)/.test(source) ||
    !/capture_ready === false[\s\S]{0,220}ensureVoiceCueCard\(state, "Listening…", "listening…"\)/.test(source)
  ) {
    throw new Error("live voice turns must materialize a visible startup card and invite speech only after microphone readiness");
  }
  if (!/openTextSurface\(\{ fresh: false \}\);[\s\S]{0,180}if \(voiceFirstGestures\) \{\s*handleVoiceFirstTap/.test(source)) {
    throw new Error("mascot taps must open the writable surface before voice-first routing");
  }
  if (!/\.agee-cue-dot\s*\{[\s\S]{0,260}animation:\s*agee-cue-pulse/.test(overlayCss)) {
    throw new Error("in-page cue cards must expose animated progress state");
  }
  if (!/\.turn \.ag\.pending::after\s*\{[\s\S]{0,260}animation:\s*pending-pulse/.test(sidepanelHtml)) {
    throw new Error("side panel pending turns must expose animated progress state");
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
    // Fresh installs intentionally have no implicit hosted gateway. This smoke
    // explicitly configures a fake origin before exercising intercepted voice
    // transport; no real request is expected to succeed at this hostname.
    await evaluate(workerCdp, `chrome.storage.local.set({
      ageeGatewayUrl: "http://agee-smoke.local",
      ageeGatewayToken: "",
      ageeGatewayUserSet: true
    })`);

    const offscreenReady = await evaluate(workerCdp, `
      (async () => {
        const url = chrome.runtime.getURL("offscreen.html");
        const contexts = await chrome.runtime.getContexts({
          contextTypes: ["OFFSCREEN_DOCUMENT"],
          documentUrls: [url],
        });
        if (!contexts.length) {
          await chrome.offscreen.createDocument({
            url: "offscreen.html",
            reasons: ["USER_MEDIA"],
            justification: "Verify the packaged offscreen voice receiver loads.",
          });
        }
        const response = await chrome.runtime.sendMessage({ cmd: "offscreenVoiceReady" });
        const captureStatus = await chrome.runtime.sendMessage({ cmd: "offscreenVoiceCaptureStatus" });
        await chrome.offscreen.closeDocument();
        return { response, captureStatus };
      })()
    `);
    if (
      offscreenReady?.response?.ok !== true ||
      offscreenReady?.response?.context !== "offscreen" ||
      offscreenReady?.captureStatus?.ok !== true ||
      offscreenReady?.captureStatus?.active !== false
    ) {
      throw new Error(`packaged offscreen voice receiver did not become ready: ${JSON.stringify(offscreenReady)}`);
    }

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

    const overlayMetrics = await evaluate(workerCdp, `
      (async () => {
        const tabId = ${ping.tabId};
        await chrome.tabs.sendMessage(tabId, { cmd: "open" });
        await new Promise((resolve) => setTimeout(resolve, 80));
        const [result] = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            const root = document.querySelector("#agee-root");
            const launcher = document.querySelector("#agee-launcher");
            const bird = document.querySelector("#agee-launcher .agee-bird");
            const panel = document.querySelector("#agee-panel");
            const input = document.querySelector("#agee-input");
            const voice = document.querySelector("#agee-voice");
            const stop = document.querySelector("#agee-stop");
            const log = document.querySelector("#agee-log");
            const voiceState = document.querySelector("#agee-voice-state");
            const pageIdentity = document.querySelector("#agee-page-identity");
            const historyButton = document.querySelector("#agee-history-button");
            if (!root || !launcher || !bird || !panel || !input || !voice || !stop || !log || !voiceState || !pageIdentity || !historyButton) {
              return { ok: false, error: "overlay nodes missing" };
            }
            const launcherRect = launcher.getBoundingClientRect();
            const birdRect = bird.getBoundingClientRect();
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
              launcherWidth: Math.round(launcherRect.width),
              launcherHeight: Math.round(launcherRect.height),
              launcherFontSize: getComputedStyle(launcher).fontSize,
              birdWidth: Math.round(birdRect.width),
              birdHeight: Math.round(birdRect.height),
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
              pageIdentity: pageIdentity.textContent || "",
              historyLabel: historyButton.textContent || "",
            };
          },
        });
        return result?.result;
      })()
    `);
    if (!overlayMetrics?.ok) throw new Error(overlayMetrics?.error || "overlay metrics missing");
    if (overlayMetrics.rootCount !== 1) throw new Error(`expected one Aggie root, got: ${JSON.stringify(overlayMetrics)}`);
    if (
      overlayMetrics.launcherFontSize !== "22px" ||
      overlayMetrics.launcherWidth !== 55 ||
      overlayMetrics.launcherHeight !== 55 ||
      overlayMetrics.birdWidth !== 44 ||
      overlayMetrics.birdHeight !== 44
    ) {
      throw new Error(`desktop mascot is not compact: ${JSON.stringify(overlayMetrics)}`);
    }
    if (!overlayMetrics.open || !overlayMetrics.activeInput) throw new Error(`overlay did not open and focus input: ${JSON.stringify(overlayMetrics)}`);
    if (!overlayMetrics.pageIdentity.includes("localhost") || overlayMetrics.historyLabel.trim() !== "History") {
      throw new Error(`overlay did not visibly ground the current page and history path: ${JSON.stringify(overlayMetrics)}`);
    }
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

    await pageCdp.send("Emulation.setDeviceMetricsOverride", {
      width: 375,
      height: 667,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const narrowMascotMetrics = await waitForEval(pageCdp, `
      (() => {
        const launcher = document.querySelector("#agee-launcher");
        const bird = document.querySelector("#agee-launcher .agee-bird");
        if (!launcher || !bird || !matchMedia("(max-width: 480px)").matches) return null;
        const launcherRect = launcher.getBoundingClientRect();
        const birdRect = bird.getBoundingClientRect();
        return {
          fontSize: getComputedStyle(launcher).fontSize,
          launcherWidth: Math.round(launcherRect.width),
          launcherHeight: Math.round(launcherRect.height),
          birdWidth: Math.round(birdRect.width),
          birdHeight: Math.round(birdRect.height),
        };
      })()
    `);
    await pageCdp.send("Emulation.clearDeviceMetricsOverride");
    if (
      narrowMascotMetrics?.fontSize !== "18px" ||
      narrowMascotMetrics?.launcherWidth !== 45 ||
      narrowMascotMetrics?.launcherHeight !== 45 ||
      narrowMascotMetrics?.birdWidth !== 36 ||
      narrowMascotMetrics?.birdHeight !== 36
    ) {
      throw new Error(`phone-sized browser mascot is not compact and usable: ${JSON.stringify(narrowMascotMetrics)}`);
    }

    // Prove an ordinary typed product-search request reaches the first-party
    // browser command runtime before the fake gateway and opens real results.
    await evaluate(pageCdp, `
      (() => {
        const input = document.querySelector("#agee-input");
        input.value = "find me an ergonomic red chair on Amazon";
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
        return true;
      })()
    `);
    const typedSearchTab = await waitForEval(workerCdp, `
      chrome.tabs.query({}).then(tabs => tabs.find(tab =>
        String(tab.pendingUrl || tab.url || "").startsWith("https://www.amazon.com/s?k=ergonomic+red+chair")
      ) || null)
    `);
    if (!typedSearchTab?.id || !typedSearchTab.active) {
      throw new Error(`typed Amazon search did not open an active result tab: ${JSON.stringify(typedSearchTab)}`);
    }
    const typedSearchSummary = await waitForEval(pageCdp, `
      (() => {
        const card = [...document.querySelectorAll("#agee-log .agee-cue")].pop();
        if (!card || !card.classList.contains("agee-cue-done")) return null;
        return card.querySelector(".agee-cue-status")?.textContent || null;
      })()
    `);
    if (!/opened amazon results for ergonomic red chair/i.test(typedSearchSummary)) {
      throw new Error(`typed Amazon search did not render its local receipt: ${JSON.stringify(typedSearchSummary)}`);
    }
    await evaluate(workerCdp, `chrome.tabs.update(${ping.tabId}, { active: true }).then(() => chrome.tabs.remove(${Number(typedSearchTab.id)}))`);

    const shortcutVoice = await evaluate(workerCdp, `
      (async () => {
        const tabId = ${ping.tabId};
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        await chrome.tabs.sendMessage(tabId, { cmd: "open" });
        await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            const input = document.querySelector("#agee-input");
            if (input) {
              input.value = "shortcut draft";
              input.dispatchEvent(new Event("input", { bubbles: true }));
            }
            window.__ageeShortcutSmoke = { calls: [], seq: 0 };
            window.__ageeShortcutSmokeOrig = chrome.runtime.sendMessage.bind(chrome.runtime);
            chrome.runtime.sendMessage = (message, ...rest) => {
              const clean = JSON.parse(JSON.stringify(message || {}));
              window.__ageeShortcutSmoke.calls.push(clean);
              if (clean.cmd === "voiceSessionStart") {
                window.__ageeShortcutSmoke.seq += 1;
                return Promise.resolve({
                  ok: true,
                  voiceSessionId: "shortcut-smoke-" + window.__ageeShortcutSmoke.seq,
                });
              }
              if (clean.cmd === "voiceSessionAttach" || clean.cmd === "voiceSessionControl" || clean.cmd === "voiceSessionClose") {
                return Promise.resolve({ ok: true });
              }
              return window.__ageeShortcutSmokeOrig(message, ...rest);
            };
          },
        });
        const dispatch = async (type, key, code, holdMs = 0) => {
          await chrome.scripting.executeScript({
            target: { tabId },
            args: [type, key, code],
            func: (eventType, eventKey, eventCode) => {
              window.dispatchEvent(new KeyboardEvent(eventType, {
                key: eventKey,
                code: eventCode,
                metaKey: true,
                bubbles: true,
                cancelable: true,
              }));
            },
          });
          if (holdMs) await sleep(holdMs);
        };
	        const dispatchTap = async (key, code) => {
	          await chrome.scripting.executeScript({
	            target: { tabId },
	            args: [key, code],
	            func: (eventKey, eventCode) => {
	              for (const eventType of ["keydown", "keyup"]) {
	                window.dispatchEvent(new KeyboardEvent(eventType, {
	                  key: eventKey,
	                  code: eventCode,
	                  metaKey: true,
	                  bubbles: true,
	                  cancelable: true,
	                }));
	              }
	            },
	          });
	        };
	        const read = async () => {
	          const [result] = await chrome.scripting.executeScript({
	            target: { tabId },
	            func: () => {
              const root = document.querySelector("#agee-root");
              const input = document.querySelector("#agee-input");
              const calls = window.__ageeShortcutSmoke?.calls || [];
              return {
                open: root?.classList.contains("agee-open") || false,
                focusedInput: document.activeElement === input,
                inputValue: input?.value || "",
                listening: document.querySelector("#agee-voice")?.classList.contains("listening") || false,
                calls,
              };
            },
	          });
	          return result?.result || {};
	        };
	        const resetVoiceCalls = async () => {
	          await chrome.scripting.executeScript({
	            target: { tabId },
	            func: () => {
	              if (window.__ageeShortcutSmoke) {
	                window.__ageeShortcutSmoke.calls = [];
	                window.__ageeShortcutSmoke.seq = 0;
	              }
	            },
	          });
	        };
	        const finishLastAttachedVoiceTurn = async () => {
	          const snapshot = await read();
	          const attaches = (snapshot.calls || []).filter((call) => call.cmd === "voiceSessionAttach");
	          const voiceSessionId = attaches[attaches.length - 1]?.voiceSessionId;
	          if (!voiceSessionId) return;
	          await chrome.tabs.sendMessage(tabId, {
	            cmd: "voiceSessionEvent",
	            voiceSessionId,
	            event: { type: "turn_done" },
	          }).catch(() => {});
	          await sleep(120);
	        };

	        await dispatch("keydown", ",", "Comma");
	        await sleep(80);
	        const comma = await read();

        await dispatchTap(".", "Period");
        await sleep(120);
        const tapStarted = await read();

        await dispatchTap(".", "Period");
        await sleep(120);
        const tapCommitted = await read();
        const attach = tapCommitted.calls.find((call) => call.cmd === "voiceSessionAttach");
        if (attach?.voiceSessionId) {
	          await chrome.tabs.sendMessage(tabId, {
	            cmd: "voiceSessionEvent",
	            voiceSessionId: attach.voiceSessionId,
	            event: { type: "turn_done" },
	          }).catch(() => {});
	          await sleep(120);
	        }

	        await dispatch("keydown", ".", "Period");
	        await sleep(340);
	        const holdBeforeRelease = await read();
	        await dispatch("keyup", ".", "Period");
	        await sleep(120);
	        const holdReleased = await read();
	        await finishLastAttachedVoiceTurn();

	        await resetVoiceCalls();
	        await chrome.tabs.sendMessage(tabId, { cmd: "toggleVoice", source: "command" });
	        await sleep(340);
	        const commandHoldBeforeRelease = await read();
	        await dispatch("keyup", ".", "Period");
	        await sleep(120);
	        const commandHoldReleased = await read();

	        await chrome.scripting.executeScript({
	          target: { tabId },
	          func: () => {
            if (window.__ageeShortcutSmokeOrig) {
              chrome.runtime.sendMessage = window.__ageeShortcutSmokeOrig;
            }
	          },
	        });

	        return { comma, tapStarted, tapCommitted, holdBeforeRelease, holdReleased, commandHoldBeforeRelease, commandHoldReleased };
	      })()
	    `);
	    const tapStarts = shortcutVoice?.tapStarted?.calls?.filter((call) => call.cmd === "voiceSessionStart") || [];
	    const tapControls = shortcutVoice?.tapCommitted?.calls?.filter((call) => call.cmd === "voiceSessionControl" && call.message?.type === "commit_turn") || [];
	    const holdStarts = shortcutVoice?.holdBeforeRelease?.calls?.filter((call) => call.cmd === "voiceSessionStart") || [];
	    const holdControlsBefore = shortcutVoice?.holdBeforeRelease?.calls?.filter((call) => call.cmd === "voiceSessionControl" && call.message?.type === "commit_turn") || [];
	    const holdControlsAfter = shortcutVoice?.holdReleased?.calls?.filter((call) => call.cmd === "voiceSessionControl" && call.message?.type === "commit_turn") || [];
	    const commandStarts = shortcutVoice?.commandHoldBeforeRelease?.calls?.filter((call) => call.cmd === "voiceSessionStart") || [];
	    const commandControlsBefore = shortcutVoice?.commandHoldBeforeRelease?.calls?.filter((call) => call.cmd === "voiceSessionControl" && call.message?.type === "commit_turn") || [];
	    const commandControlsAfter = shortcutVoice?.commandHoldReleased?.calls?.filter((call) => call.cmd === "voiceSessionControl" && call.message?.type === "commit_turn") || [];
	    if (
	      !shortcutVoice?.comma?.open ||
	      !shortcutVoice?.comma?.focusedInput ||
	      shortcutVoice?.comma?.inputValue !== "shortcut draft" ||
      (shortcutVoice?.comma?.calls || []).some((call) => call.cmd === "voiceSessionStart") ||
      tapStarts.length !== 1 ||
      tapStarts[0]?.autoCommit !== false ||
      !shortcutVoice?.tapStarted?.listening ||
      tapControls.length !== 1 ||
	      holdStarts.length !== 2 ||
	      holdStarts[1]?.autoCommit !== false ||
	      holdControlsBefore.length !== 1 ||
	      holdControlsAfter.length !== 2 ||
	      commandStarts.length !== 1 ||
	      commandStarts[0]?.autoCommit !== false ||
	      commandControlsBefore.length !== 0 ||
	      commandControlsAfter.length !== 1
	    ) {
	      throw new Error(`shortcut voice/text smoke failed: ${JSON.stringify(shortcutVoice)}`);
	    }

    // Overlay ribbons: the companion between two single-line streams.
    // Contract: reference/design/overlay-2026-07/spec.md. This drives the real
    // worker-owned presentation broadcast (the same path that carries a turn
    // across tabs) and then asserts the properties the whole redesign rests on:
    // the unit renders both streams, truncates instead of growing, paints
    // nothing while ambient, and reveals the copy affordance on a tap.
    const ribbons = await evaluate(workerCdp, `
      (async () => {
        const tabId = ${ping.tabId};
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const userText = "How much is the flight to Addis Ababa in early November " +
          "if I leave from JFK and come back before the twenty second ".repeat(6);
        const replyText = "Around 780 dollars round trip if you leave on the fourth " +
          "and come back on the nineteenth and take the one-stop through Frankfurt ".repeat(8);
        await chrome.tabs.sendMessage(tabId, { cmd: "open" }).catch(() => {});
        await chrome.tabs.sendMessage(tabId, {
          cmd: "browserAgentOwnerChanged",
          owner: { tab_id: tabId, cue_id: "ribbon-smoke-cue", status: "responding" },
          isOwner: true,
          presentation: {
            cue_id: "ribbon-smoke-cue",
            user_text: userText,
            response_text: replyText,
            status: "responding",
            // Only the corrected revision is supplied, so the rail must default
            // to it (polished outranks it but does not exist) and must show
            // polished as an explicitly unavailable row rather than faking it.
            user_variants: { edited: "corrected revision of what you said" },
          },
        }).catch(() => {});
        await sleep(160);

        const measure = await chrome.scripting.executeScript({
          target: { tabId },
          func: (expectedUser, expectedReply) => {
            const root = document.querySelector("#agee-root");
            const you = document.querySelector("#agee-ribbon-you");
            const reply = document.querySelector("#agee-ribbon-reply");
            if (!root || !you || !reply) return { ok: false, error: "ribbon nodes missing" };
            const read = (ribbon) => {
              const line = ribbon.querySelector(".agee-ribbon-line");
              const text = ribbon.querySelector(".agee-ribbon-text");
              const viewport = ribbon.querySelector(".agee-ribbon-viewport");
              const style = getComputedStyle(ribbon);
              const rect = ribbon.getBoundingClientRect();
              return {
                live: ribbon.classList.contains("agee-ribbon-live"),
                bottom: Math.round(rect.bottom),
                clipped: ribbon.classList.contains("agee-ribbon-clipped"),
                rendered: (text.textContent || "").length,
                height: Math.round(rect.height),
                width: Math.round(rect.width),
                // Ambient must paint nothing: no plate, no border, no shadow.
                background: style.backgroundColor,
                boxShadow: style.boxShadow,
                pointerEvents: style.pointerEvents,
                // The line slides; the box never grows.
                translateX: line.style.transform,
                lineWraps: line.scrollHeight > viewport.clientHeight + 1,
                copyOpacity: getComputedStyle(ribbon.querySelector(".agee-ribbon-copy")).opacity,
              };
            };
            return {
              ok: true,
              unitState: root.dataset.ageeUnit || "",
              launcherOpacity: getComputedStyle(document.querySelector("#agee-launcher")).opacity,
              launcherTop: Math.round(document.querySelector("#agee-launcher").getBoundingClientRect().top),
              replyTop: Math.round(reply.getBoundingClientRect().top),
              you: read(you),
              reply: read(reply),
              expectedUserLength: expectedUser.length,
              expectedReplyLength: expectedReply.length,
              // The page itself must not be pushed around by overlay text.
              docScrollHeight: document.documentElement.scrollHeight,
              docScrollWidth: document.documentElement.scrollWidth,
              // Only the glyph run is hittable while ambient, so an empty
              // ribbon lets a click through to the page underneath.
              glyphHittable: getComputedStyle(you.querySelector(".agee-ribbon-text")).pointerEvents,
            };
          },
          args: [userText, replyText],
        });
        const before = measure?.[0]?.result || {};

        // Tap the upper ribbon: solidify and reveal the copy rail.
        const tapped = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            const you = document.querySelector("#agee-ribbon-you");
            const rect = you.getBoundingClientRect();
            const opts = {
              bubbles: true,
              cancelable: true,
              pointerId: 41,
              pointerType: "mouse",
              button: 0,
              clientX: Math.round(rect.left + rect.width / 2),
              clientY: Math.round(rect.top + rect.height / 2),
            };
            you.querySelector(".agee-ribbon-text").dispatchEvent(new PointerEvent("pointerdown", opts));
            you.dispatchEvent(new PointerEvent("pointerup", opts));
            return true;
          },
        });
        await sleep(420);
        const after = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            const root = document.querySelector("#agee-root");
            const you = document.querySelector("#agee-ribbon-you");
            const rect = you.getBoundingClientRect();
            const style = getComputedStyle(you);
            return {
              unitState: root.dataset.ageeUnit || "",
              copyOpacity: getComputedStyle(you.querySelector(".agee-ribbon-copy")).opacity,
              copyPointerEvents: getComputedStyle(you.querySelector(".agee-ribbon-copy")).pointerEvents,
              background: style.backgroundColor,
              height: Math.round(rect.height),
              width: Math.round(rect.width),
              docScrollHeight: document.documentElement.scrollHeight,
            };
          },
        });
        return { tapped: tapped?.[0]?.result === true, before, after: after?.[0]?.result || {} };
      })()
    `);
    const ribbonBefore = ribbons?.before || {};
    const ribbonAfter = ribbons?.after || {};
    if (ribbonBefore.ok !== true) {
      throw new Error(`overlay ribbon smoke failed to read the unit: ${JSON.stringify(ribbons)}`);
    }
    // Both streams render, from the worker-owned presentation alone.
    if (!ribbonBefore.you?.live || !ribbonBefore.reply?.live) {
      throw new Error(`ribbons did not render the worker presentation: ${JSON.stringify(ribbonBefore)}`);
    }
    // The sliding window truncates instead of growing: the rendered node holds
    // a bounded tail, the line is translated left, and nothing wraps.
    for (const key of ["you", "reply"]) {
      const ribbon = ribbonBefore[key];
      const sourceLength = key === "you" ? ribbonBefore.expectedUserLength : ribbonBefore.expectedReplyLength;
      if (
        ribbon.rendered > 140 ||
        ribbon.rendered >= sourceLength ||
        ribbon.clipped !== true ||
        ribbon.lineWraps !== false ||
        ribbon.height !== 28 ||
        !/^translateX\(-\d/.test(ribbon.translateX || "")
      ) {
        throw new Error(`${key} ribbon must slide a bounded window, not grow: ${JSON.stringify(ribbon)}`);
      }
    }
    // Ambient paints nothing and intercepts nothing.
    if (
      ribbonBefore.unitState !== "ambient" ||
      ribbonBefore.you.background !== "rgba(0, 0, 0, 0)" ||
      ribbonBefore.reply.background !== "rgba(0, 0, 0, 0)" ||
      ribbonBefore.you.boxShadow !== "none" ||
      ribbonBefore.you.pointerEvents !== "none" ||
      ribbonBefore.glyphHittable !== "auto" ||
      Number(ribbonBefore.launcherOpacity) !== 0.92 ||
      Number(ribbonBefore.you.copyOpacity) !== 0
    ) {
      throw new Error(`ambient overlay must paint no plate and take no page clicks: ${JSON.stringify(ribbonBefore)}`);
    }
    // A tap solidifies the ribbon and reveals the copy affordance. The ribbon
    // itself expands (that is the point of the gesture), but its width is fixed
    // and the page must not reflow. The geometry of the expand — which edge it
    // grows from, and what stays still — is asserted in the next block.
    if (
      ribbons.tapped !== true ||
      ribbonAfter.unitState !== "engaged" ||
      Number(ribbonAfter.copyOpacity) !== 1 ||
      ribbonAfter.copyPointerEvents !== "auto" ||
      ribbonAfter.background === "rgba(0, 0, 0, 0)" ||
      ribbonAfter.width !== ribbonBefore.you.width ||
      ribbonAfter.docScrollHeight !== ribbonBefore.docScrollHeight
    ) {
      throw new Error(`tap must solidify the ribbon and reveal copy without reflowing the page: ${JSON.stringify({ ribbonBefore, ribbonAfter })}`);
    }

    // The tap that revealed the rail also expanded the bounded bar: the full
    // text is now rendered, wrapped, and the bar grew AWAY from the companion.
    const expand = await evaluate(workerCdp, `
      (async () => {
        const tabId = ${ping.tabId};
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const read = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            const you = document.querySelector("#agee-ribbon-you");
            const launcher = document.querySelector("#agee-launcher");
            const rect = you.getBoundingClientRect();
            const line = you.querySelector(".agee-ribbon-line");
            return {
              expanded: you.classList.contains("agee-ribbon-expanded"),
              rendered: (you.querySelector(".agee-ribbon-text").textContent || "").length,
              height: Math.round(rect.height),
              bottom: Math.round(rect.bottom),
              whiteSpace: getComputedStyle(line).whiteSpace,
              maxHeight: getComputedStyle(you).maxHeight,
              launcherTop: Math.round(launcher.getBoundingClientRect().top),
              replyTop: Math.round(document.querySelector("#agee-ribbon-reply").getBoundingClientRect().top),
              docScrollHeight: document.documentElement.scrollHeight,
            };
          },
        });
        // Open the copy chooser from the rail's chevron.
        await chrome.scripting.executeScript({
          target: { tabId },
          func: () => document.querySelector("#agee-ribbon-you .agee-ribbon-chevron")?.click(),
        });
        await sleep(140);
        const menu = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            const rows = [...document.querySelectorAll("#agee-copy-menu button")];
            return {
              open: document.querySelector("#agee-copy-menu").classList.contains("agee-ribbon-menu-open"),
              rows: rows.map((row) => ({
                label: row.querySelector(".agee-copy-row-head").textContent.trim(),
                why: row.querySelector(".agee-copy-why").textContent,
                disabled: row.disabled === true,
                isDefault: row.classList.contains("agee-copy-default"),
              })),
            };
          },
        });
        return { expanded: read?.[0]?.result || {}, menu: menu?.[0]?.result || {} };
      })()
    `);
    const expanded = expand?.expanded || {};
    const copyMenu = expand?.menu || {};
    if (
      expanded.expanded !== true ||
      expanded.rendered <= 140 ||
      expanded.whiteSpace !== "pre-wrap" ||
      expanded.height <= ribbonBefore.you.height ||
      expanded.maxHeight === "none"
    ) {
      throw new Error(`tap must expand the bar to the full text within a height cap: ${JSON.stringify(expanded)}`);
    }
    // Grew away from the companion: the bottom edge, the companion, the other
    // ribbon, and the page are all exactly where they were.
    if (
      expanded.bottom !== ribbonBefore.you.bottom ||
      expanded.launcherTop !== ribbonBefore.launcherTop ||
      expanded.replyTop !== ribbonBefore.replyTop ||
      expanded.docScrollHeight !== ribbonBefore.docScrollHeight
    ) {
      throw new Error(`expanding must not move the companion, the other ribbon, or the page: ${JSON.stringify({ ribbonBefore, expanded })}`);
    }
    // Three variants, ranked, with the highest AVAILABLE one defaulted and the
    // missing one shown as unavailable rather than silently substituted.
    if (
      copyMenu.open !== true ||
      copyMenu.rows?.length !== 3 ||
      !copyMenu.rows[0].label.startsWith("Polished") ||
      copyMenu.rows[0].disabled !== true ||
      copyMenu.rows[0].why !== "not generated for this turn" ||
      copyMenu.rows[1].label !== "Corrected" ||
      copyMenu.rows[1].disabled !== false ||
      copyMenu.rows[1].isDefault !== true ||
      copyMenu.rows[2].label !== "Literal transcript" ||
      copyMenu.rows[2].disabled !== false
    ) {
      throw new Error(`copy rail must rank three variants and default to the highest available: ${JSON.stringify(copyMenu)}`);
    }

    const dictationCopy = await evaluate(workerCdp, `
      (async () => {
        const tabId = ${ping.tabId};
        const transcript = "Ship the exact final text — ይህን ጽሑፍ ቅዳ።";
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        await chrome.tabs.sendMessage(tabId, { cmd: "stop" }).catch(() => {});
        await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            const input = document.querySelector("#agee-input");
            if (input) {
              input.value = "dictation copy must preserve this draft";
              input.dispatchEvent(new Event("input", { bubbles: true }));
            }
            window.__ageeDictationCopySmoke = {
              calls: [],
              copies: [],
              originalSendMessage: chrome.runtime.sendMessage.bind(chrome.runtime),
              clipboardDescriptor: Object.getOwnPropertyDescriptor(navigator, "clipboard"),
            };
            Object.defineProperty(navigator, "clipboard", {
              configurable: true,
              value: {
                writeText: async (value) => {
                  window.__ageeDictationCopySmoke.copies.push(String(value));
                },
              },
            });
            chrome.runtime.sendMessage = (message, ...rest) => {
              const clean = JSON.parse(JSON.stringify(message || {}));
              window.__ageeDictationCopySmoke.calls.push(clean);
              if (clean.cmd === "voiceSessionStart") {
                return Promise.resolve({ ok: true, voiceSessionId: "dictation-copy-smoke" });
              }
              if (
                clean.cmd === "voiceSessionAttach" ||
                clean.cmd === "voiceSessionControl" ||
                clean.cmd === "voiceSessionClose"
              ) {
                return Promise.resolve({ ok: true });
              }
              return window.__ageeDictationCopySmoke.originalSendMessage(message, ...rest);
            };
          },
        });

        await chrome.tabs.sendMessage(tabId, {
          cmd: "startDictation",
          dictationLeaseId: "dictation-copy-lease",
        });
        await sleep(120);
        await chrome.tabs.sendMessage(tabId, {
          cmd: "voiceSessionEvent",
          voiceSessionId: "dictation-copy-smoke",
          event: { type: "transcript_final", text: transcript },
        });
        await chrome.tabs.sendMessage(tabId, {
          cmd: "voiceSessionEvent",
          voiceSessionId: "dictation-copy-smoke",
          event: {
            type: "turn_done",
            status: "completed",
            transcription_only: true,
            clipboard_copied: false,
            turn_id: "dictation-copy-turn",
          },
        });
        await sleep(180);

        const beforeClick = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            const buttons = [...document.querySelectorAll(".agee-dictation-copy")];
            return {
              count: buttons.length,
              label: buttons[0]?.textContent || "",
              receipt: buttons[0]?.closest(".agee-cue")?.querySelector(".agee-cue-status")?.textContent || "",
              draft: document.querySelector("#agee-input")?.value || "",
              copies: [...(window.__ageeDictationCopySmoke?.copies || [])],
              runCalls: (window.__ageeDictationCopySmoke?.calls || []).filter((call) =>
                call.cmd === "run" || call.cmd === "branch" || call.cmd === "branchFanout"
              ).length,
            };
          },
        });
        await chrome.scripting.executeScript({
          target: { tabId },
          func: () => document.querySelector(".agee-dictation-copy")?.click(),
        });
        await sleep(80);
        const afterClick = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            const button = document.querySelector(".agee-dictation-copy");
            const card = button?.closest(".agee-cue-dictation");
            return {
              label: button?.textContent || "",
              receipt: card?.querySelector(".agee-cue-status")?.textContent || "",
              copies: [...(window.__ageeDictationCopySmoke?.copies || [])],
              retireTimerHeld: !card?.dataset.retireAfterMs,
            };
          },
        });
        await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            const smoke = window.__ageeDictationCopySmoke;
            if (!smoke) return;
            chrome.runtime.sendMessage = smoke.originalSendMessage;
            if (smoke.clipboardDescriptor) {
              Object.defineProperty(navigator, "clipboard", smoke.clipboardDescriptor);
            } else {
              delete navigator.clipboard;
            }
          },
        });
        return {
          transcript,
          beforeClick: beforeClick?.[0]?.result || {},
          afterClick: afterClick?.[0]?.result || {},
        };
      })()
    `);
    if (
      dictationCopy?.beforeClick?.count !== 1 ||
      dictationCopy?.beforeClick?.draft !== "dictation copy must preserve this draft" ||
      dictationCopy?.beforeClick?.copies?.length !== 1 ||
      dictationCopy?.beforeClick?.copies?.[0] !== dictationCopy?.transcript ||
      dictationCopy?.beforeClick?.runCalls !== 0 ||
      dictationCopy?.afterClick?.copies?.length !== 2 ||
      dictationCopy?.afterClick?.copies?.[1] !== dictationCopy?.transcript ||
      dictationCopy?.afterClick?.label !== "Copied" ||
      dictationCopy?.afterClick?.receipt !== "Copied — clipboard replaced." ||
      dictationCopy?.afterClick?.retireTimerHeld !== true
    ) {
      throw new Error(`dictation copy control smoke failed: ${JSON.stringify(dictationCopy)}`);
    }

    const earlyVoiceQueue = await evaluate(workerCdp, `
      (async () => {
        const tabId = ${ping.tabId};
        const originalFetch = globalThis.fetch;
        const originalWebSocket = globalThis.WebSocket;
        const state = {
          sent: [],
          ready: false,
          ws: null,
        };
        globalThis.__ageeEarlyVoiceQueueSmoke = state;
        globalThis.fetch = async (input, init) => {
          const url = typeof input === "string" ? input : input?.url || String(input);
          try {
            const parsed = new URL(url);
            if (parsed.pathname === "/v1/voice/session-ticket") {
              return new Response(JSON.stringify({
                ws_url: "ws://agee-smoke.local/voice",
                session_id: "queue-session",
                conversation_id: "queue-session",
                device_id: "queue-device",
              }), {
                status: 200,
                headers: { "content-type": "application/json" },
              });
            }
          } catch {}
          return originalFetch(input, init);
        };
        class SmokeWebSocket {
          static CONNECTING = 0;
          static OPEN = 1;
          static CLOSING = 2;
          static CLOSED = 3;
          constructor(url) {
            this.url = url;
            this.readyState = SmokeWebSocket.CONNECTING;
            state.ws = this;
            setTimeout(() => {
              this.readyState = SmokeWebSocket.OPEN;
              this.onopen?.({});
            }, 0);
          }
          send(data) {
            if (data instanceof ArrayBuffer) {
              state.sent.push({ kind: "audio", ready: state.ready, bytes: Array.from(new Uint8Array(data)) });
              return;
            }
            let parsed = null;
            try { parsed = JSON.parse(String(data || "{}")); } catch {}
            state.sent.push({ kind: "json", ready: state.ready, type: parsed?.type || "", message: parsed || null });
          }
          close() {
            this.readyState = SmokeWebSocket.CLOSED;
            this.onclose?.({});
          }
        }
        globalThis.WebSocket = SmokeWebSocket;
        try {
          const [result] = await chrome.scripting.executeScript({
            target: { tabId },
            func: async () => {
              const bytesToBase64 = (values) => {
                const bytes = new Uint8Array(values);
                let binary = "";
                for (const byte of bytes) binary += String.fromCharCode(byte);
                return btoa(binary);
              };
              const start = await chrome.runtime.sendMessage({
                cmd: "voiceSessionStart",
                cueId: "queue-smoke",
                turnId: "queue-turn",
                capture: "content-script",
                autoCommit: false,
              });
              const audio = await chrome.runtime.sendMessage({
                cmd: "voiceSessionAudio",
                voiceSessionId: start.voiceSessionId,
                audio: bytesToBase64([1, 0, 2, 0]),
              });
              const commit = await chrome.runtime.sendMessage({
                cmd: "voiceSessionControl",
                voiceSessionId: start.voiceSessionId,
                message: { type: "commit_turn", turn_id: "queue-turn" },
              });
              return { start, audio, commit };
            },
          });
          const beforeReady = state.sent.slice();
          state.ready = true;
          state.ws?.onmessage?.({ data: JSON.stringify({ type: "session_ready" }) });
          await new Promise((resolve) => setTimeout(resolve, 80));
          const afterReady = state.sent.slice();
          const start = result?.result?.start || {};
          const audio = result?.result?.audio || {};
          const commit = result?.result?.commit || {};
          const audioRecords = afterReady.filter((entry) => entry.kind === "audio");
          const commitRecords = afterReady.filter((entry) => entry.kind === "json" && entry.type === "commit_turn");
          return {
            ok:
              start.ok === true &&
              audio.ok === true &&
              audio.queued === true &&
              commit.ok === true &&
              commit.queued === true &&
              beforeReady.every((entry) => entry.kind !== "audio" && entry.type !== "commit_turn") &&
              audioRecords.length === 1 &&
              audioRecords[0].ready === true &&
              audioRecords[0].bytes.join(",") === "1,0,2,0" &&
              commitRecords.length === 1 &&
              commitRecords[0].ready === true &&
              afterReady.findIndex((entry) => entry.kind === "audio") < afterReady.findIndex((entry) => entry.type === "commit_turn"),
            start,
            audio,
            commit,
            beforeReady,
            afterReady,
          };
        } finally {
          globalThis.fetch = originalFetch;
          globalThis.WebSocket = originalWebSocket;
          delete globalThis.__ageeEarlyVoiceQueueSmoke;
        }
      })()
    `);
    if (!earlyVoiceQueue?.ok) {
      throw new Error(`early voice audio queue smoke failed: ${JSON.stringify(earlyVoiceQueue)}`);
    }

    const resultPlacement = await evaluate(workerCdp, `
      (async () => {
        const tabId = ${ping.tabId};
        await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            document.querySelector("#agee-log")?.replaceChildren();
            const input = document.querySelector("#agee-input");
            if (input) {
              input.value = "draft must stay";
              input.dispatchEvent(new Event("input", { bubbles: true }));
            }
          },
        });
        await chrome.tabs.sendMessage(tabId, { cmd: "done", cueId: null, summary: "Smoke reply stays above the input." });
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

    // Fast local stop path (typed): named smoke:stop-local contract. A whole
    // utterance "stop" must (1) halt locally, (2) send zero runs to the gateway,
    // and (3) produce no spoken or written acknowledgment beyond the echoed
    // command and the minimal cue. The overlay records __ageeLastStopHalt; a
    // model reply would leave assistant text in the log, which this asserts is
    // absent. Each stop phrase in the local matcher is exercised so a rewording
    // of the matcher that drops a phrase fails here, not silently in production.
    const stopPhrases = ["stop", "shut up", "be quiet", "stop please", "shut up now"];
    const controlText = "what is the weather";
    const typedStop = await evaluate(workerCdp, `
      (async () => {
        const tabId = ${ping.tabId};
        const stopPhrases = ${JSON.stringify(stopPhrases)};
        const controlText = ${JSON.stringify(controlText)};
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        await chrome.tabs.sendMessage(tabId, { cmd: "open" });
        await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            window.__ageeSmokeRunCount = 0;
            window.__ageeSmokeStopSeen = window.__ageeSmokeStopSeen || null;
            if (!window.__ageeSmokeRunWrapped) {
              const orig = chrome.runtime.sendMessage.bind(chrome.runtime);
              chrome.runtime.sendMessage = (message, ...rest) => {
                if (message && message.cmd === "run") window.__ageeSmokeRunCount += 1;
                return orig(message, ...rest);
              };
              window.__ageeSmokeRunWrapped = true;
            }
          },
        });

        const submit = async (text, approveDelegation = false) => {
          await chrome.scripting.executeScript({
            target: { tabId },
            args: [text],
            func: (value) => {
              window.__ageeLastStopHalt = null;
              const input = document.querySelector("#agee-input");
              if (input) {
                input.value = value;
                input.dispatchEvent(new Event("input", { bubbles: true }));
                input.focus();
                input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
              }
            },
          });
          if (approveDelegation) {
            await sleep(40);
            await chrome.scripting.executeScript({
              target: { tabId },
              func: () => document.querySelector('[data-agee-confirm="yes"]')?.click(),
            });
          }
          await sleep(120);
          const [snap] = await chrome.scripting.executeScript({
            target: { tabId },
            func: () => {
              const log = document.querySelector("#agee-log");
              return {
                halt: window.__ageeLastStopHalt || null,
                runCount: window.__ageeSmokeRunCount || 0,
                logText: log ? log.textContent : "",
              };
            },
          });
          return snap?.result || {};
        };

        // Every stop phrase halts locally with zero runs.
        const perPhrase = {};
        for (const phrase of stopPhrases) {
          const before = await submit(phrase);
          perPhrase[phrase] = { halt: before.halt, runCount: before.runCount };
        }
        const afterStops = perPhrase[stopPhrases[stopPhrases.length - 1]].runCount;

        // A non-stop instruction is NOT swallowed: it does reach the gateway,
        // proving the stop path is scoped and not a blanket "swallow all input".
        const control = await submit(controlText, true);

        const [final] = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            const log = document.querySelector("#agee-log");
            return { logText: log ? log.textContent : "" };
          },
        });

        return {
          perPhrase,
          afterStops,
          control: { runCount: control.runCount, afterStops },
          logText: final?.result?.logText || "",
        };
      })()
    `);
    for (const phrase of stopPhrases) {
      const entry = typedStop?.perPhrase?.[phrase];
      if (entry?.halt?.source !== "typed") {
        throw new Error(`typed stop "${phrase}" did not halt locally: ${JSON.stringify(typedStop)}`);
      }
    }
    if (typedStop?.afterStops !== 0) {
      throw new Error(`typed stop must not send any run to the gateway: ${JSON.stringify(typedStop)}`);
    }
    // Acknowledgment check: after all stops, the log carries the echoed commands
    // but no assistant reply text. A model acknowledgment ("stopping", "okay")
    // would appear here; the stop path must stay silent.
    const stopLog = String(typedStop?.logText || "").toLowerCase();
    for (const ack of ["stopping", "i'll stop", "okay", "sure", "done stopping"]) {
      if (stopLog.includes(ack)) {
        throw new Error(`typed stop produced a spoken/written acknowledgment "${ack}": ${JSON.stringify(typedStop)}`);
      }
    }
    // Scope proof: the non-stop control instruction DID reach the gateway, so
    // the stop matcher is not swallowing ordinary input.
    if (!(typedStop?.control?.runCount > typedStop?.control?.afterStops)) {
      throw new Error(`non-stop instruction was wrongly swallowed by the stop path: ${JSON.stringify(typedStop)}`);
    }

    // Record mode: the #agee-record control must exist, and stopping with no
    // active recording must return a structured failure from the background
    // record handler. Deterministic: no capture starts, no microphone is
    // touched, and no gateway is contacted.
    const recordIdle = await evaluate(workerCdp, `
      (async () => {
        const tabId = ${ping.tabId};
        const [result] = await chrome.scripting.executeScript({
          target: { tabId },
          func: async () => {
            const record = document.querySelector("#agee-record");
            const stop = await chrome.runtime.sendMessage({ cmd: "recordSessionStop" });
            return { hasRecordButton: !!record, recordingClass: record?.classList.contains("recording") || false, stop };
          },
        });
        return result?.result;
      })()
    `);
    if (!recordIdle?.hasRecordButton || recordIdle?.recordingClass) {
      throw new Error(`record control missing or wrongly active while idle: ${JSON.stringify(recordIdle)}`);
    }
    if (recordIdle?.stop?.stored !== false || !recordIdle?.stop?.error) {
      throw new Error(`idle record stop must return a structured {stored:false} error: ${JSON.stringify(recordIdle)}`);
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
          !Object.hasOwn(ownerB || {}, "page_url") &&
          !Object.hasOwn(ownerB || {}, "page_title") &&
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
        `${workerResult.visibleTextChars} visible text chars observed, ` +
        `compact overlay checked (${overlayMetrics.panelWidth}x${overlayMetrics.panelHeight}), ` +
        `ribbons rendered the worker presentation and slid a bounded window ` +
        `(you ${ribbonBefore.you.rendered}/${ribbonBefore.expectedUserLength} chars, ` +
        `reply ${ribbonBefore.reply.rendered}/${ribbonBefore.expectedReplyLength} chars, ` +
        `${ribbonBefore.you.height}px tall, ambient background ${ribbonBefore.you.background}, ` +
        `tap -> ${ribbonAfter.unitState}, expanded to ${expanded.rendered} chars in ${expanded.height}px ` +
        `without moving the companion, copy rail offers ` +
        `${copyMenu.rows.map((r) => r.label.split(" ")[0] + (r.disabled ? "(unavailable)" : r.isDefault ? "(default)" : "")).join("/")}), ` +
        `typed Amazon command opened results and rendered "${typedSearchSummary}", ` +
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
