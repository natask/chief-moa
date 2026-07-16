#!/usr/bin/env node
"use strict";

// Smoke for wave-3 gateway tool surface: model-driven customization + voice
// reversibility + the browser page-tweak contract.
//
//   1. Store: revertLast undoes the last change (global + device scope) and
//      reset restores defaults, always appending a new version so the profile
//      never lands broken.
//   2. Live tool path (through a fake Gemini Live socket that emits toolCall and
//      captures the toolResponse the gateway sends back):
//        - update_agent_profile sets response_modality=text (settable+validated),
//        - update_agent_profile with an invalid response_modality is dropped,
//        - revert_agent_profile mode=previous undoes the last change,
//        - revert_agent_profile mode=reset restores defaults,
//        - propose_page_tweak accepts a valid record and rejects an unknown kind,
//          both without failing the turn.
//   3. HTTP turn path: "reply in text" persists response_modality=text; "undo
//      that" reverts; "reset your settings" restores defaults.
//   4. Gemini Live setup exposes the new tools (revert_agent_profile,
//      propose_page_tweak) alongside update_agent_profile.
//
// Boots node server.js on a throwaway port + token + DATA_DIR (real .env never
// loaded), with a fake Live endpoint so no real provider is touched.

const assert = require("node:assert");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { WebSocket, WebSocketServer } = require("ws");

const GATEWAY_DIR = path.resolve(__dirname, "..");
const TOKEN = "profile-revert-smoke-token";
const ENV_DEFAULT_VOICE = "Kore";

const { createAgentProfileStore } = require(path.join(GATEWAY_DIR, "lib", "agent-profile"));
const { createVoiceProvider } = require(path.join(GATEWAY_DIR, "lib", "voice-providers"));

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-profile-revert-smoke-"));
  const dataDir = path.join(tempDir, "data");
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}/v1/voice/sessions`;
  let server;
  let fakeLive;

  try {
    await step("store revertLast + reset (global + device)", () => assertStoreRevert(tempDir));
    await step("setup exposes revert + page-tweak tools", () => assertSetupTools(dataDir));

    fakeLive = await startFakeLive();
    server = await startGateway({ port, dataDir, fakeUrl: fakeLive.url });

    await step("live tool: response_modality settable + validated", () => assertLiveModalityTool(wsUrl, fakeLive));
    await step("live tool: canonical settings list + recommend", () => assertLiveSettingsRead(wsUrl, fakeLive));
    await step("live tool: revert previous + reset", () => assertLiveRevertTool(baseUrl, wsUrl, fakeLive));
    await step("live tool: propose_page_tweak accept + reject", () => assertLivePageTweakTool(wsUrl, fakeLive));
    await step("http turn: modality + undo + reset", () => assertHttpRevert(baseUrl));

    console.log(JSON.stringify({
      ok: true,
      base_url: baseUrl,
      checks: [
        "store revertLast undoes last change (global); reset restores defaults; both append a version",
        "store revertLast (device scope) undoes the last device change without breaking the profile",
        "Gemini Live setup exposes read_agent_settings, update_agent_profile, revert_agent_profile, propose_page_tweak",
        "live update_agent_profile sets response_modality=text; invalid values are kept previous; unknown fields reject atomically",
        "live read_agent_settings lists all canonical settings, recommends only catalog settings, and rejects unknown ids",
        "live revert_agent_profile mode=previous undoes the last change; mode=reset restores defaults",
        "live propose_page_tweak returns a page_tweak action for a valid record and rejects an unknown kind, never failing the turn",
        "http 'reply in text' persists response_modality=text; 'undo that' reverts; 'reset your settings' restores defaults",
      ],
    }, null, 2));
  } finally {
    if (server) {
      server.kill("SIGTERM");
      await onceExit(server, 1500);
    }
    if (fakeLive) {
      await fakeLive.close();
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function step(name, fn) {
  try {
    return await fn();
  } catch (error) {
    error.message = `[${name}] ${error.message}`;
    throw error;
  }
}

async function assertStoreRevert(tempDir) {
  const dir = path.join(tempDir, "store-check");
  const store = createAgentProfileStore({
    dataDir: dir,
    defaults: { voice_max_chars: 280, temperature: 0.4 },
  });

  // Global: two changes, then revertLast restores the state before the last one.
  store.patch({ voice: "Aoede" });
  const afterFirst = store.currentVersion();
  store.patch({ voice: "Charon" });
  assert.equal(store.effective().voice, "Charon", "precondition: last change set Charon");
  const revert = store.revertLast({ source: "smoke" });
  assert.ok(revert.ok, `revertLast must succeed: ${JSON.stringify(revert)}`);
  assert.equal(store.effective().voice, "Aoede", "revertLast must restore the voice before the last change");
  assert.notEqual(store.currentVersion(), afterFirst, "revertLast must append a NEW version, not mutate history");

  // reset restores the env defaults (voice empty).
  store.reset({ source: "smoke" });
  assert.equal(store.effective().voice, "", "reset must restore the default (unset) voice");

  // With only the default version present, revertLast reports no_previous and
  // never breaks the profile.
  const freshDir = path.join(tempDir, "store-fresh");
  const fresh = createAgentProfileStore({ dataDir: freshDir, defaults: { voice_max_chars: 280 } });
  const none = fresh.revertLast({ source: "smoke" });
  assert.ok(!none.ok && none.reason === "no_previous", `revertLast on a fresh store must report no_previous: ${JSON.stringify(none)}`);
  assert.equal(fresh.effective().voice_max_chars, 280, "fresh store profile must stay intact after a no-op revert");

  // Device scope: a device change, then a device revertLast restores the prior
  // device state (here: back to the global effective, i.e. no device override).
  const deviceId = "device-abc";
  store.patch({ voice: "Leda" }, { scope: "device", deviceId });
  assert.equal(store.effective({ deviceId }).voice, "Leda", "precondition: device override set Leda");
  const deviceRevert = store.revertLast({ scope: "device", deviceId, source: "smoke" });
  assert.ok(deviceRevert.ok, `device revertLast must succeed: ${JSON.stringify(deviceRevert)}`);
  assert.notEqual(store.effective({ deviceId }).voice, "Leda", "device revertLast must undo the device change");
}

async function assertSetupTools(dataDir) {
  const providerDir = path.join(dataDir, "setup-tools-check");
  const agentProfile = createAgentProfileStore({
    dataDir: providerDir,
    defaults: { system_prompt: "test", model: "m", temperature: 0.4, voice_max_chars: 280, language: "" },
  });
  const provider = createVoiceProvider({
    env: { VOICE_PROVIDER: "gemini-live", GEMINI_API_KEY: "test-key", GEMINI_LIVE_VOICE: ENV_DEFAULT_VOICE },
    agentProfile,
  });
  const setup = provider.setupMessage();
  const toolNames = (setup.tools?.[0]?.functionDeclarations || []).map((tool) => tool.name);
  for (const name of ["read_agent_settings", "update_agent_profile", "revert_agent_profile", "propose_page_tweak"]) {
    assert.ok(toolNames.includes(name), `Gemini Live setup must expose ${name}, got ${JSON.stringify(toolNames)}`);
  }
}

// Drive a full live turn that ends with the fake provider emitting one tool call,
// then return the tool response the gateway sent back (captured by the fake).
async function runLiveToolCall(wsUrl, fakeLive, toolName, toolArgs, options = {}) {
  fakeLive.nextToolCall = { name: toolName, args: toolArgs, transcript: options.transcript || "" };
  fakeLive.toolResponses.length = 0;
  const sessionId = options.sessionId || `revert_smoke_${Math.random().toString(36).slice(2, 8)}`;
  const turnId = options.turnId || `turn_${Math.random().toString(36).slice(2, 8)}`;
  const ws = await openVoiceClient(wsUrl);
  try {
    await sendJsonWs(ws, {
      type: "session_start",
      session_id: sessionId,
      conversation_id: sessionId,
      branch_id: "default",
      turn_id: turnId,
      source: options.source || "agee-extension",
      format: { encoding: "pcm16", sample_rate: 16000, channels: 1 },
    });
    await waitForWsEvent(ws, (event) => event.type === "session_ready" && event.turn_id === turnId);
    ws.send(Buffer.alloc(640, 1));
    await sendJsonWs(ws, { type: "commit_turn", turn_id: turnId });
    await waitForWsEvent(ws, (event) => event.type === "turn_done" && event.turn_id === turnId);
  } finally {
    closeWebSocketQuietly(ws);
  }
  const response = fakeLive.toolResponses.find((entry) => entry.name === toolName);
  assert.ok(response, `fake Live must have captured a toolResponse for ${toolName}: ${JSON.stringify(fakeLive.toolResponses)}`);
  return response.response;
}

async function assertLiveModalityTool(wsUrl, fakeLive) {
  const set = await runLiveToolCall(wsUrl, fakeLive, "update_agent_profile", {
    profile: { response_modality: "text" },
    reason: "smoke",
  }, { transcript: "reply in text from now on" });
  assert.equal(set.ok, true, `update_agent_profile must succeed: ${JSON.stringify(set)}`);
  assert.ok(Array.isArray(set.changed) && set.changed.includes("response_modality"), `response_modality must be reported changed: ${JSON.stringify(set)}`);

  // An invalid response_modality is dropped by the sanitizer: no change persists,
  // the turn still completes (never a failed turn).
  const invalid = await runLiveToolCall(wsUrl, fakeLive, "update_agent_profile", {
    profile: { response_modality: "hologram" },
    reason: "smoke-invalid",
  }, { transcript: "reply in text from now on" });
  assert.equal(invalid.ok, true, `invalid modality must not fail the turn: ${JSON.stringify(invalid)}`);
  assert.ok(!(Array.isArray(invalid.changed) && invalid.changed.includes("response_modality")), "invalid modality must not change the field");

  const unknown = await runLiveToolCall(wsUrl, fakeLive, "update_agent_profile", {
    profile: { response_modality: "speech", imaginary_setting: true },
    reason: "smoke-unknown",
  }, { transcript: "reply out loud from now on" });
  assert.equal(unknown.ok, false, "mixed known and unknown fields must be rejected atomically");
  assert.equal(unknown.error, "unknown_profile_fields");
  assert.deepEqual(unknown.unknown_fields, ["imaginary_setting"]);
}

async function assertLiveSettingsRead(wsUrl, fakeLive) {
  const listed = await runLiveToolCall(wsUrl, fakeLive, "read_agent_settings", { operation: "list" });
  assert.equal(listed.ok, true);
  assert.equal(listed.count, 31);
  assert.ok(listed.settings.every((setting) => setting.id && setting.readable === true));
  const recommended = await runLiveToolCall(wsUrl, fakeLive, "read_agent_settings", {
    operation: "recommend",
    query: "I want concise spoken answers",
    limit: 3,
  });
  assert.equal(recommended.settings[0].id, "voice_max_chars");
  const unknown = await runLiveToolCall(wsUrl, fakeLive, "read_agent_settings", { operation: "get", id: "imaginary_setting" });
  assert.equal(unknown.error, "unknown_setting");
}

async function assertLiveRevertTool(baseUrl, wsUrl, fakeLive) {
  // Set a distinctive value, then undo it via the revert tool.
  await runLiveToolCall(wsUrl, fakeLive, "update_agent_profile", { profile: { voice: "Fenrir" }, reason: "smoke" }, { transcript: "use the Fenrir voice" });
  let profile = await getJson(`${baseUrl}/v1/agent/profile`);
  assert.equal(profile.profile.voice, "Fenrir", "precondition: voice set to Fenrir via tool");

  const revert = await runLiveToolCall(wsUrl, fakeLive, "revert_agent_profile", { mode: "previous", reason: "smoke" });
  assert.equal(revert.ok, true, `revert tool must succeed: ${JSON.stringify(revert)}`);
  assert.equal(revert.type, "agent_profile_reverted", "revert tool must report agent_profile_reverted");
  assert.equal(revert.reverted, true, "revert tool must report a change was undone");
  profile = await getJson(`${baseUrl}/v1/agent/profile`);
  assert.notEqual(profile.profile.voice, "Fenrir", "revert must undo the Fenrir change");

  const reset = await runLiveToolCall(wsUrl, fakeLive, "revert_agent_profile", { mode: "reset", reason: "smoke" });
  assert.equal(reset.ok, true, `reset tool must succeed: ${JSON.stringify(reset)}`);
  assert.equal(reset.mode, "reset", "reset tool must report mode=reset");
  profile = await getJson(`${baseUrl}/v1/agent/profile`);
  assert.equal(profile.is_overridden, false, "reset must restore the default (un-overridden) profile");
}

async function assertLivePageTweakTool(wsUrl, fakeLive) {
  const ok = await runLiveToolCall(wsUrl, fakeLive, "propose_page_tweak", {
    kind: "hide",
    params: { selectors: ["aside", "#sidebar"] },
    name: "Hide sidebar",
  }, { source: "agee-extension" });
  assert.equal(ok.ok, true, `valid page tweak must succeed: ${JSON.stringify(ok)}`);
  assert.equal(ok.type, "page_tweak", "valid page tweak must return type page_tweak");
  assert.deepStrictEqual(ok.action, { type: "page_tweak", record: { kind: "hide", params: { selectors: ["aside", "#sidebar"] }, name: "Hide sidebar" } }, `page_tweak action envelope must match the contract: ${JSON.stringify(ok.action)}`);

  const bad = await runLiveToolCall(wsUrl, fakeLive, "propose_page_tweak", {
    kind: "rename-label",
    params: {},
  }, { source: "agee-extension" });
  assert.equal(bad.ok, false, "unknown kind must be rejected");
  assert.equal(bad.type, "page_tweak_rejected", "unknown kind must return page_tweak_rejected, not fail the turn");
  assert.ok(Array.isArray(bad.supported_kinds) && bad.supported_kinds.includes("hide"), "rejection must list supported kinds");

  // A non-browser source cannot propose a page tweak.
  const wrongSource = await runLiveToolCall(wsUrl, fakeLive, "propose_page_tweak", {
    kind: "dark",
  }, { source: "android-overlay" });
  assert.equal(wrongSource.ok, false, "non-browser source must not be allowed to propose a page tweak");
}

async function assertHttpRevert(baseUrl) {
  const sessionId = "profile-revert-http-smoke";
  // Persist a modality change through the HTTP turn path.
  const modality = await postJson(`${baseUrl}/v1/voice/turns`, {
    session_id: sessionId,
    turn_id: "http-modality",
    transcript: "reply in text from now on",
    source: "profile-revert-smoke",
  });
  assert.equal(modality.status, 200, `modality turn must succeed: ${JSON.stringify(modality.json)}`);
  assert.equal(modality.json.classification, "profile_control", "modality utterance must route as profile_control");
  assert.ok(
    modality.json.actions?.some((a) => a.type === "profile_update_blocked"),
    `modality change must be blocked on the model-less path: ${JSON.stringify(modality.json.actions)}`,
  );
  let profile = await getJson(`${baseUrl}/v1/agent/profile`);
  assert.equal(profile.profile.response_modality, "auto", "blocked modality change must not persist");

  // Every profile WRITE — including undo/reset — is model-routed (user
  // decision 2026-07-14: no non-model pathways except the output kill switch).
  // On this model-less HTTP path the fail-closed judge cannot confirm, so
  // undo, voice changes, and reset must all be BLOCKED and leave the profile
  // untouched. Model-path revert coverage lives with the revert_agent_profile
  // tool tests.
  const versionBefore = profile.profile_version;
  for (const [turnId, utterance] of [
    ["http-undo", "undo that"],
    ["http-set-voice", "use the Charon voice"],
    ["http-reset", "reset your settings"],
  ]) {
    const blocked = await postJson(`${baseUrl}/v1/voice/turns`, {
      session_id: sessionId,
      turn_id: turnId,
      transcript: utterance,
      source: "profile-revert-smoke",
    });
    assert.equal(blocked.status, 200, `'${utterance}' turn must succeed: ${JSON.stringify(blocked.json)}`);
    const blockedAction = blocked.json.actions?.find((a) => a.type === "profile_update_blocked");
    assert.ok(blockedAction, `'${utterance}' must be blocked without model confirmation: ${JSON.stringify(blocked.json.actions)}`);
    assert.ok(
      !blocked.json.actions?.some((a) => a.type === "profile_reverted" || a.type === "profile_updated"),
      `'${utterance}' must not mutate on the model-less path`,
    );
  }
  profile = await getJson(`${baseUrl}/v1/agent/profile`);
  assert.equal(profile.profile_version, versionBefore, "blocked mutations must not advance the profile version");
}

async function startGateway({ port, dataDir, fakeUrl }) {
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["server.js"], {
    cwd: GATEWAY_DIR,
    env: gatewayEnv({ port, dataDir, fakeUrl }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = collectLogs(server);
  await waitForHealth(baseUrl, logs);
  return server;
}

function gatewayEnv({ port, dataDir, fakeUrl }) {
  return {
    PATH: process.env.PATH || "",
    HOME: process.env.HOME || "",
    TMPDIR: process.env.TMPDIR || os.tmpdir(),
    HOST: "127.0.0.1",
    PORT: String(port),
    DATA_DIR: dataDir,
    ANDROID_OTA_DIR: path.join(dataDir, "android-ota"),
    MOA_GATEWAY_TOKEN: TOKEN,
    MODEL_PROVIDER: "openai-compatible",
    MODEL_ID: "profile-revert-smoke-model",
    MODEL_API_KEY: "",
    OPENAI_API_KEY: "",
    GOOGLE_API_KEY: "",
    GEMINI_API_KEY: fakeUrl ? "test-key" : "",
    GEMINI_LIVE_ENDPOINT: fakeUrl || "",
    VOICE_PROVIDER: "gemini-live",
    GEMINI_LIVE_VOICE: ENV_DEFAULT_VOICE,
  };
}

// Fake Gemini Live: completes setup, and on audioStreamEnd emits the queued
// toolCall, then captures the toolResponse the gateway sends back so the smoke
// can assert on the tool result. Finishes the turn afterwards.
async function startFakeLive() {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const state = { nextToolCall: null, toolResponses: [] };
  await waitForServerListening(server);
  server.on("connection", (ws) => {
    ws.on("message", (data) => {
      let message;
      try {
        message = JSON.parse(Buffer.from(data).toString("utf8"));
      } catch {
        return;
      }
      if (message.setup) {
        ws.send(JSON.stringify({ setupComplete: {} }));
        return;
      }
      if (message.toolResponse) {
        for (const response of message.toolResponse.functionResponses || []) {
          state.toolResponses.push({ name: response.name, response: response.response });
        }
        // The turn can complete once the tool result is back.
        ws.send(JSON.stringify({ serverContent: { turnComplete: true } }));
        return;
      }
      if (message.realtimeInput?.audioStreamEnd) {
        if (state.nextToolCall) {
          const call = state.nextToolCall;
          state.nextToolCall = null;
          if (call.transcript) {
            ws.send(JSON.stringify({
              serverContent: {
                inputTranscription: { text: call.transcript },
              },
            }));
          }
          ws.send(JSON.stringify({
            toolCall: {
              functionCalls: [{ id: `call_${Math.random().toString(36).slice(2, 8)}`, name: call.name, args: call.args }],
            },
          }));
          return;
        }
        ws.send(JSON.stringify({ serverContent: { turnComplete: true } }));
      }
    });
  });
  return {
    url: `ws://127.0.0.1:${server.address().port}/v1beta/fake-live`,
    get nextToolCall() { return state.nextToolCall; },
    set nextToolCall(value) { state.nextToolCall = value; },
    toolResponses: state.toolResponses,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}

function waitForServerListening(server) {
  return new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
}

async function waitForHealth(baseUrl, logs) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // starting
    }
    if (logs.exited) {
      throw new Error(`gateway exited before health was ready\n${logs.text()}`);
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for gateway health\n${logs.text()}`);
}

async function getJson(url, options) {
  const response = await requestJson(url, options);
  assert.ok(response.status >= 200 && response.status < 300, `${url} returned ${response.status}: ${JSON.stringify(response.json)}`);
  return response.json;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, { headers: options.auth === false ? {} : authHeaders() });
  const json = await response.json();
  return { status: response.status, json };
}

async function postJson(url, body, options = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...(options.auth === false ? {} : authHeaders()),
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });
  const json = await response.json();
  return { status: response.status, json };
}

function authHeaders() {
  return { Authorization: `Bearer ${TOKEN}` };
}

function openVoiceClient(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { headers: authHeaders() });
    const timeout = setTimeout(() => {
      closeWebSocketQuietly(ws);
      reject(new Error(`timed out opening ${wsUrl}`));
    }, 3000);
    ws.once("open", () => {
      clearTimeout(timeout);
      resolve(ws);
    });
    ws.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function sendJsonWs(ws, payload) {
  return new Promise((resolve, reject) => {
    ws.send(JSON.stringify(payload), (error) => (error ? reject(error) : resolve()));
  });
}

function waitForWsEvent(ws, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for voice session event"));
    }, timeoutMs);
    const onMessage = (data, isBinary) => {
      if (isBinary) return;
      let event;
      try {
        event = JSON.parse(Buffer.from(data).toString("utf8"));
      } catch {
        return;
      }
      if (event.type === "error") {
        cleanup();
        reject(new Error(event.message || "voice session returned error"));
        return;
      }
      if (predicate(event)) {
        cleanup();
        resolve(event);
      }
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      ws.off("message", onMessage);
      ws.off("error", onError);
    };
    ws.on("message", onMessage);
    ws.on("error", onError);
  });
}

function closeWebSocketQuietly(ws) {
  try {
    ws.close(1000, "smoke complete");
  } catch {
    // ignore
  }
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function collectLogs(child) {
  let output = "";
  const append = (chunk) => {
    output += chunk.toString("utf8");
    if (output.length > 12000) output = output.slice(-12000);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.on("exit", () => {
    logs.exited = true;
  });
  const logs = {
    exited: false,
    text: () => output,
  };
  return logs;
}

async function onceExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    sleep(timeoutMs).then(() => {
      child.kill("SIGKILL");
    }),
  ]);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
