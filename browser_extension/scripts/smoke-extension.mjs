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
  const extensionApi = readFileSync(join(extensionPath, "content-extension-api-runtime.js"), "utf8");
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
  if (
    !/function safeRuntimeSendMessage/.test(extensionApi) ||
    !/function safeStorageLocalGet/.test(extensionApi) ||
    !/function safeStorageLocalSet/.test(extensionApi) ||
    !/AgeeContentExtensionApiRuntime\.createContentExtensionApiRuntime\(\{/.test(source)
  ) {
    throw new Error("content.js must delegate runtime and storage calls to the stale-context safety runtime");
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
    // Fresh installs intentionally have no implicit hosted gateway. This smoke
    // explicitly configures a fake origin before exercising intercepted voice
    // transport; no real request is expected to succeed at this hostname.
    await evaluate(workerCdp, `chrome.storage.local.set({
      ageeGatewayUrl: "http://agee-smoke.local",
      ageeGatewayToken: "",
      ageeGatewayUserSet: true
    })`);

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
