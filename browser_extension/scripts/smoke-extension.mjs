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
import { createHash } from "node:crypto";
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

function sendWsFrame(socket, opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  let header;
  if (body.length < 126) {
    header = Buffer.from([0x80 | opcode, body.length]);
  } else if (body.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  socket.write(Buffer.concat([header, body]));
}

function sendWsText(socket, value) {
  sendWsFrame(socket, 0x1, JSON.stringify(value));
}

function readWsFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const opcode = first & 0x0f;
    const masked = Boolean(second & 0x80);
    let length = second & 0x7f;
    let headerLength = 2;
    if (length === 126) {
      if (offset + 4 > buffer.length) break;
      length = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (length === 127) {
      if (offset + 10 > buffer.length) break;
      length = Number(buffer.readBigUInt64BE(offset + 2));
      headerLength = 10;
    }
    const maskLength = masked ? 4 : 0;
    const frameEnd = offset + headerLength + maskLength + length;
    if (frameEnd > buffer.length) break;
    let payload = buffer.subarray(offset + headerLength + maskLength, frameEnd);
    if (masked) {
      const mask = buffer.subarray(offset + headerLength, offset + headerLength + 4);
      payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
    } else {
      payload = Buffer.from(payload);
    }
    frames.push({ opcode, payload });
    offset = frameEnd;
  }
  return { frames, rest: buffer.subarray(offset) };
}

async function serveVoiceQueueGateway() {
  const state = {
    frames: [],
    binaryFrames: [],
    textFrames: [],
    readySentAt: 0,
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (url.pathname === "/v1/voice/session-ticket") {
      const { port } = server.address();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        ticket: "queue-smoke-ticket",
        ws_url: `ws://localhost:${port}/v1/voice/sessions?ticket=queue-smoke-ticket`,
      }));
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });

  server.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"];
    if (!key) {
      socket.destroy();
      return;
    }
    const accept = createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      "",
    ].join("\r\n"));

    let pending = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      const parsed = readWsFrames(pending);
      pending = parsed.rest;
      for (const frame of parsed.frames) {
        const entry = { opcode: frame.opcode, at: Date.now(), payload: frame.payload };
        state.frames.push(entry);
        if (frame.opcode === 0x1) {
          const text = frame.payload.toString("utf8");
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {}
          entry.text = text;
          entry.json = json;
          state.textFrames.push(entry);
          if (json?.type === "session_start" && !state.readySentAt) {
            setTimeout(() => {
              state.readySentAt = Date.now();
              sendWsText(socket, { type: "session_ready" });
            }, 250);
          }
        } else if (frame.opcode === 0x2) {
          state.binaryFrames.push(entry);
        } else if (frame.opcode === 0x8) {
          socket.end();
        }
      }
    });
  });

  await new Promise((resolveServer) => server.listen(0, "localhost", resolveServer));
  const { port } = server.address();
  return {
    server,
    state,
    baseUrl: `http://localhost:${port}`,
  };
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
  if (
    !/function beginVoiceGesturePress/.test(source) ||
    !/keyboardVoicePress = beginVoiceGesturePress\("keyboard"\)/.test(source) ||
    !/launcherVoicePress = startLauncherPushToTalk\(\);[\s\S]{0,120}setTimeout/.test(source) ||
    !/promoteVoiceGesturePressToHold/.test(source) ||
    !/finishVoiceGesturePress/.test(source) ||
    !/if \(!e\.repeat\) startKeyboardVoicePress\(\);/.test(source)
  ) {
    throw new Error("Cmd/Ctrl+Period and launcher double-click must share press/release voice gesture state");
  }
  if (
    !/MAX_QUEUED_VOICE_AUDIO_BYTES/.test(background) ||
    !/function queueVoiceSessionAudio/.test(background) ||
    !/function flushQueuedVoiceAudio/.test(background) ||
    !/function markVoiceSessionReady/.test(background) ||
    !/startVoiceSessionCapture\(session\)/.test(background) ||
    /parsed\?\.type === "session_ready"[\s\S]{0,160}startOffscreenVoiceCapture/.test(background)
  ) {
    throw new Error("background.js must start offscreen capture before session_ready and queue early PCM");
  }
  if (!/msg\.type === "transcript_partial"[\s\S]{0,520}ensureVoiceCueCard\(state, text/.test(source)) {
    throw new Error("live voice transcript must render in cue cards above the input");
  }
  if (!/playback_policy:\s*\{\s*assistant_overlap:\s*assistantOverlap === true/.test(background)) {
    throw new Error("background.js must send assistant_overlap playback policy to the gateway");
  }
}

function voiceGestureRuntimeFunctionSource() {
  return `
    async (mode) => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const calls = [];
      const originalSendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = (message) => {
        calls.push(JSON.parse(JSON.stringify(message || {})));
        if (message?.cmd === "voiceSessionStart") {
          return Promise.resolve({
            ok: true,
            voiceSessionId: "smoke-" + mode + "-voice-session",
            session_id: "smoke-session",
            conversation_id: "smoke-session",
          });
        }
        if (message?.cmd === "voiceSessionAttach") return Promise.resolve({ ok: true });
        if (message?.cmd === "voiceSessionControl") return Promise.resolve({ ok: true });
        if (message?.cmd === "voiceSessionClose") return Promise.resolve({ ok: true });
        return Promise.resolve({ ok: true });
      };
      const key = (type, keyValue, code, extra = {}) => window.dispatchEvent(new KeyboardEvent(type, {
        key: keyValue,
        code,
        bubbles: true,
        cancelable: true,
        ...extra,
      }));
      try {
        if (mode === "comma") {
          const input = document.querySelector("#agee-input");
          if (input) {
            input.value = "draft survives comma";
            input.dispatchEvent(new Event("input", { bubbles: true }));
          }
          key("keydown", ",", "Comma", { metaKey: true });
          await sleep(80);
          const root = document.querySelector("#agee-root");
          return {
            mode: "comma",
            calls,
            open: root?.classList.contains("agee-open") || false,
            inputValue: document.querySelector("#agee-input")?.value || "",
          };
        }

        key("keydown", ".", "Period", { metaKey: true });
        await sleep(mode === "hold" ? 180 : 40);
        key("keyup", ".", "Period", { metaKey: false });
        await sleep(160);

        if (mode === "tap") {
          key("keydown", ".", "Period", { metaKey: true });
          await sleep(30);
          key("keyup", ".", "Period", { metaKey: false });
          await sleep(120);
        }

        return {
          mode,
          calls,
          open: document.querySelector("#agee-root")?.classList.contains("agee-open") || false,
          listening: document.querySelector("#agee-voice")?.classList.contains("listening") || false,
        };
      } finally {
        chrome.runtime.sendMessage = originalSendMessage;
      }
    }
  `;
}

async function runVoiceGestureSmoke(workerCdp, tabId, mode) {
  const result = await evaluate(workerCdp, `
    (async () => {
      const [injection] = await chrome.scripting.executeScript({
        target: { tabId: ${tabId} },
        func: ${voiceGestureRuntimeFunctionSource()},
        args: [${JSON.stringify(mode)}],
      });
      return injection?.result;
    })()
  `);
  const calls = Array.isArray(result?.calls) ? result.calls : [];
  if (mode === "comma") {
    if (!result?.open || result.inputValue !== "draft survives comma" || calls.length !== 0) {
      throw new Error(`Cmd/Ctrl+Comma smoke failed: ${JSON.stringify(result)}`);
    }
    return result;
  }
  const starts = calls.filter((call) => call.cmd === "voiceSessionStart");
  const controls = calls.filter((call) => call.cmd === "voiceSessionControl");
  const commits = controls.filter((call) => call.message?.type === "commit_turn");
  const setAutoCommit = controls.filter((call) => call.message?.type === "set_auto_commit");
  if (!starts.length || starts[0].autoCommit !== false || starts[0].conversation !== false) {
    throw new Error(`${mode} voice smoke did not start through the manual-candidate path: ${JSON.stringify(result)}`);
  }
  if (mode === "tap") {
    if (!setAutoCommit.some((call) => call.message?.enabled === true) || commits.length !== 1) {
      throw new Error(`Cmd/Ctrl+Period tap smoke did not promote to toggle then commit on next tap: ${JSON.stringify(result)}`);
    }
  } else if (mode === "hold") {
    if (!setAutoCommit.some((call) => call.message?.enabled === false) || commits.length !== 1) {
      throw new Error(`Cmd/Ctrl+Period hold smoke did not commit as push-to-talk: ${JSON.stringify(result)}`);
    }
  }
  return result;
}

async function waitForQueueGateway(state, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const commitFrame = state.textFrames.find((frame) => frame.json?.type === "commit_turn");
    if (state.readySentAt && state.binaryFrames.length >= 2 && commitFrame) {
      return {
        binaryFrames: state.binaryFrames,
        commitFrame,
        textFrames: state.textFrames,
      };
    }
    await delay(50);
  }
  throw new Error(`early-audio queue smoke timed out: ${JSON.stringify({
    readySentAt: state.readySentAt,
    binaryFrames: state.binaryFrames.length,
    textTypes: state.textFrames.map((frame) => frame.json?.type || "raw"),
  })}`);
}

async function runEarlyAudioQueueSmoke(workerCdp, tabId, gateway) {
  await evaluate(workerCdp, `
    chrome.storage.local.set({
      ageeGatewayUrl: ${JSON.stringify(gateway.baseUrl)},
      ageeGatewayToken: "",
      ageeApiKey: "",
    })
  `);
  const started = await evaluate(workerCdp, `
    (async () => {
      const [injection] = await chrome.scripting.executeScript({
        target: { tabId: ${tabId} },
        func: async () => {
          const toBase64 = (bytes) => btoa(String.fromCharCode(...bytes));
          const session = await chrome.runtime.sendMessage({
            cmd: "voiceSessionStart",
            cueId: "queue-smoke-cue",
            turnId: "queue-smoke-turn",
            assistantOverlap: false,
            capture: "content-script",
            autoCommit: false,
            conversation: false,
          });
          if (!session?.ok || !session.voiceSessionId) return { ok: false, stage: "start", session };
          const attached = await chrome.runtime.sendMessage({
            cmd: "voiceSessionAttach",
            voiceSessionId: session.voiceSessionId,
          });
          const audioA = await chrome.runtime.sendMessage({
            cmd: "voiceSessionAudio",
            voiceSessionId: session.voiceSessionId,
            audio: toBase64([1, 2, 3, 4]),
          });
          const audioB = await chrome.runtime.sendMessage({
            cmd: "voiceSessionAudio",
            voiceSessionId: session.voiceSessionId,
            audio: toBase64([5, 6, 7, 8]),
          });
          const commit = await chrome.runtime.sendMessage({
            cmd: "voiceSessionControl",
            voiceSessionId: session.voiceSessionId,
            message: { type: "commit_turn", turn_id: "queue-smoke-turn" },
          });
          return { ok: true, session, attached, audioA, audioB, commit };
        },
      });
      return injection?.result;
    })()
  `);
  if (!started?.ok || started.audioA?.queued !== true || started.audioB?.queued !== true || started.commit?.queued !== true) {
    throw new Error(`early-audio queue smoke did not queue pre-ready audio/control: ${JSON.stringify(started)}`);
  }

  const observed = await waitForQueueGateway(gateway.state);
  const binaryPayloads = observed.binaryFrames.map((frame) => Array.from(frame.payload));
  const frameOrder = gateway.state.frames.map((frame) => {
    if (frame.opcode === 0x2) return "audio";
    return frame.json?.type || "text";
  });
  const firstCommitIndex = frameOrder.indexOf("commit_turn");
  const firstAudioIndex = frameOrder.indexOf("audio");
  if (
    !gateway.state.readySentAt ||
    observed.binaryFrames.some((frame) => frame.at < gateway.state.readySentAt) ||
    JSON.stringify(binaryPayloads.slice(0, 2)) !== JSON.stringify([[1, 2, 3, 4], [5, 6, 7, 8]]) ||
    firstAudioIndex < 0 ||
    firstCommitIndex < 0 ||
    firstCommitIndex < firstAudioIndex
  ) {
    throw new Error(`early-audio queue ordering failed: ${JSON.stringify({
      readySentAt: gateway.state.readySentAt,
      binaryPayloads,
      frameOrder,
    })}`);
  }
  return {
    queuedAudio: binaryPayloads.length,
    frameOrder,
  };
}

async function main() {
  assertVoicePlaybackStopContract();
  const chromePath = resolveChromeForTesting();
  const { server, port: serverPort } = await serve();
  const queueGateway = await serveVoiceQueueGateway();
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

    const commaGesture = await runVoiceGestureSmoke(workerCdp, ping.tabId, "comma");
    const tapGesture = await runVoiceGestureSmoke(workerCdp, ping.tabId, "tap");
    const holdGesture = await runVoiceGestureSmoke(workerCdp, ownershipResult.tabB, "hold");
    const queueGesture = await runEarlyAudioQueueSmoke(workerCdp, ownershipResult.tabB, queueGateway);

    console.log(
      `extension smoke passed (REAL extension, headless Chrome for Testing): ` +
        `service worker loaded id=${extensionId}, text shortcut=${textShortcut}, voice shortcut=${voiceShortcut}, ${workerResult.elements} elements observed via background->content, ` +
        `${workerResult.visibleTextChars} visible text chars observed, ` +
        `compact overlay checked (${overlayMetrics.panelWidth}x${overlayMetrics.panelHeight}), ` +
        `cross-tab owner moved ${ownershipResult.tabA}->${ownershipResult.tabB} with old tab revoked, ` +
        `shortcut gestures checked (comma calls=${commaGesture.calls.length}, tap calls=${tapGesture.calls.length}, hold calls=${holdGesture.calls.length}), ` +
        `early voice queue flushed ${queueGesture.queuedAudio} chunks before commit, ` +
        `type+click executed, demo result "${resultText}", no window shown, no focus taken.`,
    );
    console.log(`screenshot: ${screenshotPath}`);
  } finally {
    pageCdp?.close();
    page2Cdp?.close();
    workerCdp?.close();
    browserCdp?.close();
    server.close();
    queueGateway.server.close();
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
