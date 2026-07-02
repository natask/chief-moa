// Quiet smoke for the browser extension's live voice WebSocket proxy against the
// main-machine gateway. This does not request a real microphone: it loads the
// real extension in headless Chrome for Testing, starts a voice session through
// background.js, streams generated PCM16 chunks through the same background
// proxy the offscreen microphone uses, and waits for gateway transcript/text/audio
// events to arrive back in the content script.
//
// Secret boundary: the bearer token is read only from AGEE_GATEWAY_TOKEN and is
// never printed. The run uses a throwaway Chrome profile and removes it after.

import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mkdtempSync, rmSync as rmDirSync, readFileSync as readFile } from "node:fs";
import { resolveChromeForTesting, quietChromeArgs } from "./chrome-for-testing.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const extensionPath = join(root, "extension");
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const runDir = join(root, ".gstack", "background-qa", `live-voice-main-${runId}`);
const profilePath = join(runDir, "chrome-profile");
const GATEWAY_URL = (process.env.AGEE_GATEWAY_URL || "http://10.147.17.6:8787").replace(/\/+$/, "");
const GATEWAY_TOKEN = process.env.AGEE_GATEWAY_TOKEN || "";

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

function configureStorageExpr(url, token) {
  return `
    (async () => {
      await chrome.storage.local.set({
        ageeGatewayUrl: ${JSON.stringify(url)},
        ageeGatewayToken: ${JSON.stringify(token)},
        ageeApiKey: "",
      });
      const got = await chrome.storage.local.get(["ageeGatewayUrl", "ageeGatewayToken"]);
      return { url: got.ageeGatewayUrl, tokenSet: Boolean(got.ageeGatewayToken) };
    })()
  `;
}

function installVoiceRecorderExpr() {
  return `
    (() => {
      globalThis.__ageeVoiceEvents = [];
      globalThis.__ageeVoiceAudioBytes = 0;
      chrome.runtime.onMessage.addListener((msg) => {
        if (!msg || msg.cmd !== "voiceSessionEvent") return;
        if (msg.audio) {
          globalThis.__ageeVoiceAudioBytes += Math.floor(String(msg.audio).length * 3 / 4);
          globalThis.__ageeVoiceEvents.push({ type: "audio", audio: true });
          return;
        }
        const event = msg.event || {};
        globalThis.__ageeVoiceEvents.push({
          type: event.type || "unknown",
          text: event.text || "",
          message: event.message || "",
        });
      });
      return true;
    })()
  `;
}

function startVoiceSessionExpr(cueId, turnId) {
  return `
    (async () => {
      const session = await chrome.runtime.sendMessage({
        cmd: "voiceSessionStart",
        cueId: ${JSON.stringify(cueId)},
        turnId: ${JSON.stringify(turnId)},
        assistantOverlap: false,
        capture: "content-script",
      });
      if (!session || !session.voiceSessionId) return { ok: false, error: session && session.error };
      const attached = await chrome.runtime.sendMessage({
        cmd: "voiceSessionAttach",
        voiceSessionId: session.voiceSessionId,
      });
      return { ok: Boolean(attached && attached.ok), voiceSessionId: session.voiceSessionId, attached };
    })()
  `;
}

function sendAudioExpr(voiceSessionId, base64) {
  return `
    chrome.runtime.sendMessage({
      cmd: "voiceSessionAudio",
      voiceSessionId: ${JSON.stringify(voiceSessionId)},
      audio: ${JSON.stringify(base64)},
    })
  `;
}

function closeVoiceSessionExpr(voiceSessionId) {
  return `
    chrome.runtime.sendMessage({
      cmd: "voiceSessionClose",
      voiceSessionId: ${JSON.stringify(voiceSessionId)},
      reason: "smoke complete",
    }).catch(() => {})
  `;
}

function eventSummaryExpr() {
  return `
    (() => {
      const events = globalThis.__ageeVoiceEvents || [];
      const types = events.map((event) => event.type);
      return {
        types,
        transcript: events.filter((event) => /transcript_/.test(event.type)).map((event) => event.text).filter(Boolean).pop() || "",
        assistantText: events.filter((event) => event.type === "assistant_text").map((event) => event.text).filter(Boolean).join(" ").trim(),
        audioBytes: globalThis.__ageeVoiceAudioBytes || 0,
        turnDone: types.includes("turn_done"),
        errors: events.filter((event) => event.type === "error" || event.message),
      };
    })()
  `;
}

function generateVoiceSmokePcm16() {
  const phrase = process.env.AGEE_LIVE_VOICE_PHRASE || "Can you hear me clearly? This is an Aggie browser extension smoke test.";
  const tempDir = mkdtempSync(join(tmpdir(), "agee-live-voice-"));
  const aiffPath = join(tempDir, "speech.aiff");
  const pcmPath = join(tempDir, "speech.pcm");
  try {
    execFileSync("say", ["-v", process.env.AGEE_LIVE_VOICE_SAY_VOICE || "Samantha", "-r", process.env.AGEE_LIVE_VOICE_SAY_RATE || "135", "-o", aiffPath, phrase], {
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 10000,
    });
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", aiffPath, "-ac", "1", "-ar", "16000", "-f", "s16le", pcmPath], {
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 10000,
    });
    return { source: "macos-say-ffmpeg", audio: readFile(pcmPath) };
  } catch {
    return { source: "fallback-tone", audio: generatePcm16Tone(16000, 220, 0.2, 1200) };
  } finally {
    rmDirSync(tempDir, { recursive: true, force: true });
  }
}

function generatePcm16Tone(sampleRate, frequencyHz, volume, durationMs) {
  const sampleCount = Math.floor(sampleRate * durationMs / 1000);
  const buffer = Buffer.alloc(sampleCount * 2);
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = Math.round(Math.sin(2 * Math.PI * frequencyHz * index / sampleRate) * volume * 32767);
    buffer.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), index * 2);
  }
  return buffer;
}

async function streamPcmViaExtension(pageCdp, contentCtx, voiceSessionId, audio) {
  const chunkBytes = 3200;
  for (let offset = 0; offset < audio.length; offset += chunkBytes) {
    const chunk = audio.subarray(offset, Math.min(offset + chunkBytes, audio.length));
    await evaluate(pageCdp, sendAudioExpr(voiceSessionId, chunk.toString("base64")), { contextId: contentCtx });
    await delay(20);
  }
  const silence = Buffer.alloc(chunkBytes);
  for (let index = 0; index < 14; index += 1) {
    await evaluate(pageCdp, sendAudioExpr(voiceSessionId, silence.toString("base64")), { contextId: contentCtx });
    await delay(110);
  }
}

async function main() {
  if (!GATEWAY_TOKEN) {
    throw new Error("AGEE_GATEWAY_TOKEN is required for browser live voice proxy smoke");
  }

  const chromePath = resolveChromeForTesting();
  const { server, port: serverPort } = await serve();
  mkdirSync(profilePath, { recursive: true });

  console.log("agee browser live-voice proxy smoke (REAL extension, headless Chrome for Testing)");
  console.log(`  gateway: ${GATEWAY_URL}`);
  console.log("  token:   supplied via AGEE_GATEWAY_TOKEN");

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
  let voiceSessionId = "";
  try {
    const devToolsPort = Number((await waitForFile(join(profilePath, "DevToolsActivePort"))).split("\n")[0]);
    const workerTarget = await waitForTarget(
      devToolsPort,
      (target) => target.type === "service_worker" && /^chrome-extension:\/\/[a-p]+\/background\.js$/.test(target.url || ""),
    );
    const extensionId = workerTarget.url.match(/^chrome-extension:\/\/([a-p]+)\//)[1];
    if (latestChromeStderr.includes("--load-extension is not allowed")) {
      throw new Error("The resolved Chrome refused --load-extension; use Chrome for Testing.");
    }

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
    await evaluate(workerCdp, configureStorageExpr(GATEWAY_URL, GATEWAY_TOKEN));

    const tabId = await waitForEval(workerCdp, `
      (async () => {
        const [tab] = await chrome.tabs.query({ url: "http://localhost/*" });
        if (!tab) return null;
        try {
          const res = await chrome.tabs.sendMessage(tab.id, { cmd: "ping" });
          return res && res.ok ? tab.id : null;
        } catch { return null; }
      })()
    `);
    if (!tabId) throw new Error("real content script did not answer ping via the service worker");

    let contentCtx = null;
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
    if (contentCtx == null) {
      throw new Error(`could not resolve the overlay isolated execution context (candidates: ${isolatedContexts.length})`);
    }

    await evaluate(pageCdp, installVoiceRecorderExpr(), { contextId: contentCtx });

    const cueId = `smoke_cue_${Date.now().toString(36)}`;
    const turnId = `smoke_turn_${Date.now().toString(36)}`;
    const started = await evaluate(pageCdp, startVoiceSessionExpr(cueId, turnId), { contextId: contentCtx });
    if (!started?.ok || !started.voiceSessionId) {
      throw new Error(`voice session did not start: ${JSON.stringify(started)}`);
    }
    voiceSessionId = started.voiceSessionId;

    await waitForEval(pageCdp, `((globalThis.__ageeVoiceEvents || []).some((event) => event.type === "session_ready"))`, 20000, { contextId: contentCtx });
    const speech = generateVoiceSmokePcm16();
    await streamPcmViaExtension(pageCdp, contentCtx, voiceSessionId, speech.audio);

    const summary = await waitForEval(pageCdp, `
      (() => {
        const s = (${eventSummaryExpr()});
        return s.turnDone && s.audioBytes > 0 ? s : null;
      })()
    `, 60000, { contextId: contentCtx });

    const hasTranscript = summary.types.includes("transcript_final") || summary.types.includes("transcript_partial");
    const hasAssistantText = summary.types.includes("assistant_text") && summary.assistantText.length > 0;
    if (!hasTranscript || !hasAssistantText || summary.audioBytes <= 0 || summary.errors.length) {
      throw new Error(`live voice proxy returned incomplete events: ${JSON.stringify(summary)}`);
    }

    console.log(
      `browser live-voice proxy smoke passed: id=${extensionId}, source=${speech.source}, ` +
        `events=${summary.types.join(",")}, assistant_audio_bytes=${summary.audioBytes}, ` +
        `transcript="${summary.transcript.slice(0, 120)}", assistant="${summary.assistantText.slice(0, 120)}"`,
    );
  } finally {
    if (voiceSessionId && pageCdp) {
      try {
        // Best-effort cleanup; no token or audio details are printed.
        await evaluate(pageCdp, closeVoiceSessionExpr(voiceSessionId));
      } catch {}
    }
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
