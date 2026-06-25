#!/usr/bin/env node
"use strict";

// Smoke for "the agent changes its OWN spoken voice by talking to it."
//
// The runtime agent profile gained a `voice` field (one of the Gemini Live
// core-8 voices). This proves the self-customization control plane end to end:
//
//   1. PUT /v1/agent/profile {profile:{voice:"Aoede"}} persists, and a GET
//      reflects voice=Aoede with is_overridden=true.
//   2. An invalid voice ("Robot") is rejected — the field is left unchanged.
//   3. The voice provider reads the effective profile's voice/language PER SESSION:
//      - status() reflects the configured voice, and
//      - the Gemini Live session-config the provider WOULD send carries
//        speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName from the runtime
//        profile, requests input/output transcriptions, and keeps input language
//        in Moa-owned context instead of misusing speechConfig. No real Gemini
//        key, no audio call.
//
// Boots `node server.js` directly on a throwaway port + token + DATA_DIR so the
// real .env is never loaded. The voice provider is forced to gemini-live so its
// status() exposes `voice`; it stays unconfigured (no key) — we never open a
// live session, we only assert on the profile and the session-config object.

const assert = require("node:assert");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const GATEWAY_DIR = path.resolve(__dirname, "..");
const TOKEN = "voice-profile-smoke-token";
const ENV_DEFAULT_VOICE = "Kore";

const { createAgentProfileStore } = require(path.join(GATEWAY_DIR, "lib", "agent-profile"));
const { createVoiceProvider } = require(path.join(GATEWAY_DIR, "lib", "voice-providers"));

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-voice-profile-smoke-"));
  const dataDir = path.join(tempDir, "data");
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let server;

  try {
    server = await startGateway({ port, dataDir });

    await step("auth required", () => assertAuthRequired(baseUrl));
    await step("voice field is a profile field", () => assertVoiceIsField(baseUrl));
    await step("valid voice persists + is_overridden", () => assertValidVoice(baseUrl));
    await step("invalid voice is rejected", () => assertInvalidVoiceRejected(baseUrl));
    await step("spoken assistant-name control persists with terse confirmation", () => assertAssistantNameControl(baseUrl));
    await step("health status reflects configured voice", () => assertHealthVoice(baseUrl));
    // Provider-level assertion runs in-process: prove the exact session-config
    // the provider WOULD send to Gemini Live carries the effective voice.
    await step("provider session-config carries the profile voice and language", () => assertProviderSessionConfig(dataDir));

    console.log(JSON.stringify({
      ok: true,
      base_url: baseUrl,
      checks: [
        "GET /v1/agent/profile requires a token",
        "`voice` is one of the profile fields",
        "PUT voice=Aoede persists; GET reflects voice=Aoede + is_overridden=true",
        "PUT voice=Robot (unknown) is rejected; voice stays Aoede",
        "POST /v1/voice/turns 'your name is Moa' persists assistant_name=Moa and replies 'Yes. I am now Moa.'",
        "health voice_stream.provider.voice reflects the configured voice (Aoede)",
        "provider status() + Gemini Live session-config carry the effective voice/language/assistant name; env default when unset",
        "provider session-config strips legacy servile honorific prompt instructions and adds the no-honorific rule",
      ],
    }, null, 2));
  } finally {
    if (server) {
      server.kill("SIGTERM");
      await onceExit(server, 1500);
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

async function assertAuthRequired(baseUrl) {
  const unauth = await requestJson(`${baseUrl}/v1/agent/profile`, { auth: false });
  assert.equal(unauth.status, 401, "agent profile must require a token");
}

async function assertVoiceIsField(baseUrl) {
  const payload = await getJson(`${baseUrl}/v1/agent/profile`);
  assert.ok(Array.isArray(payload.fields), "profile payload must list fields");
  assert.ok(payload.fields.includes("voice"), `\`voice\` must be a profile field, got ${JSON.stringify(payload.fields)}`);
}

async function assertValidVoice(baseUrl) {
  const put = await putJson(`${baseUrl}/v1/agent/profile`, { profile: { voice: "Aoede" }, source: "voice-profile-smoke" });
  assert.equal(put.status, 200, `PUT voice=Aoede must succeed: ${JSON.stringify(put.json)}`);
  assert.equal(put.json.profile.voice, "Aoede", "PUT response must echo voice=Aoede");

  const after = await getJson(`${baseUrl}/v1/agent/profile`);
  assert.equal(after.profile.voice, "Aoede", `GET must reflect voice=Aoede, got ${after.profile.voice}`);
  assert.equal(after.is_overridden, true, "is_overridden must be true after setting voice");

  // Case-insensitive canonicalization: "kore" -> "Kore".
  const lower = await putJson(`${baseUrl}/v1/agent/profile`, { profile: { voice: "kore" } });
  assert.equal(lower.status, 200, "PUT voice=kore must succeed");
  assert.equal(lower.json.profile.voice, "Kore", `lowercase voice must canonicalize to Kore, got ${lower.json.profile.voice}`);

  // Restore Aoede for the remaining checks.
  await putJson(`${baseUrl}/v1/agent/profile`, { profile: { voice: "Aoede" } });
}

async function assertInvalidVoiceRejected(baseUrl) {
  const before = await getJson(`${baseUrl}/v1/agent/profile`);
  assert.equal(before.profile.voice, "Aoede", "precondition: voice is Aoede");

  const put = await putJson(`${baseUrl}/v1/agent/profile`, { profile: { voice: "Robot" } });
  // The unknown value is dropped; the patch becomes a no-op and voice is unchanged.
  assert.equal(put.status, 200, "PUT with an invalid voice still returns 200 (value dropped)");

  const after = await getJson(`${baseUrl}/v1/agent/profile`);
  assert.equal(after.profile.voice, "Aoede", `invalid voice must leave voice unchanged at Aoede, got ${after.profile.voice}`);
}

async function assertAssistantNameControl(baseUrl) {
  const turn = await postJson(`${baseUrl}/v1/voice/turns`, {
    session_id: "voice-profile-smoke",
    turn_id: "assistant-name-update",
    transcript: "your name is Moa",
    source: "voice-profile-smoke",
  });
  assert.equal(turn.status, 200, `assistant-name voice turn must succeed: ${JSON.stringify(turn.json)}`);
  assert.equal(turn.json.classification, "profile_control", "assistant-name utterance must route as profile_control");
  assert.equal(turn.json.speak, "Yes. I am now Moa.", `unexpected assistant-name confirmation: ${turn.json.speak}`);
  assert.equal(turn.json.display, "Yes. I am now Moa.", "display must match the terse confirmation");
  assert.equal(turn.json.profile?.assistant_name, "Moa", "voice turn payload profile must expose assistant_name=Moa");
  assertNoServileFiller(turn.json.speak);

  const profile = await getJson(`${baseUrl}/v1/agent/profile`);
  assert.equal(profile.profile.assistant_name, "Moa", `GET profile must persist assistant_name=Moa, got ${profile.profile.assistant_name}`);

  const summary = await postJson(`${baseUrl}/v1/voice/turns`, {
    session_id: "voice-profile-smoke",
    turn_id: "assistant-name-summary",
    transcript: "what is your name",
    source: "voice-profile-smoke",
  });
  assert.equal(summary.status, 200, `assistant-name summary turn must succeed: ${JSON.stringify(summary.json)}`);
  assert.equal(summary.json.classification, "profile_control", "assistant-name summary must route as profile_control");
  assert.ok(
    /My name is Moa\./.test(summary.json.speak),
    `assistant-name summary must reflect persisted name, got ${summary.json.speak}`,
  );
  assertNoServileFiller(summary.json.speak);
}

function assertNoServileFiller(value) {
  const text = String(value || "").toLowerCase();
  assert.ok(!/\b(master|sir|captain)\b/.test(text), `reply must not contain servile title: ${value}`);
  assert.ok(!/how can i help/.test(text), `reply must not contain help filler: ${value}`);
}

async function assertHealthVoice(baseUrl) {
  const health = await fetch(`${baseUrl}/health`).then((r) => r.json());
  const providerStatus = health?.voice_stream?.provider;
  assert.ok(providerStatus, "health must expose voice_stream.provider");
  assert.equal(
    providerStatus.voice,
    "Aoede",
    `health provider voice must reflect the configured voice Aoede, got ${providerStatus.voice}`,
  );
  assert.equal(
    providerStatus.voice_default,
    ENV_DEFAULT_VOICE,
    `health provider voice_default must be the env default ${ENV_DEFAULT_VOICE}, got ${providerStatus.voice_default}`,
  );
}

// In-process check: build the SAME provider wiring the gateway uses (gemini-live
// + the runtime agent profile) and inspect the session-config it would send.
async function assertProviderSessionConfig(dataDir) {
  // A clean, isolated profile dir so this check starts with NO persisted voice
  // (the HTTP gateway above already wrote voice=Aoede into the shared dataDir).
  const providerDir = path.join(dataDir, "provider-check");
  const agentProfile = createAgentProfileStore({
    dataDir: providerDir,
    defaults: { system_prompt: "test", model: "m", temperature: 0.4, voice_max_chars: 280, language: "" },
  });
  const provider = createVoiceProvider({
    env: { VOICE_PROVIDER: "gemini-live", GEMINI_API_KEY: "test-key", GEMINI_LIVE_VOICE: ENV_DEFAULT_VOICE },
    agentProfile,
  });

  // Unset profile voice: provider falls back to the env default.
  assert.equal(provider.effectiveVoice(), ENV_DEFAULT_VOICE, "unset profile voice must fall back to env default");
  assert.equal(provider.status().voice, ENV_DEFAULT_VOICE, "status() must show env default when unset");
  const defaultSetup = provider.setupMessage();
  assert.equal(
    defaultSetup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName,
    ENV_DEFAULT_VOICE,
    "session-config must use the env default voice when the profile voice is unset",
  );
  assert.ok(
    defaultSetup.tools?.[0]?.functionDeclarations?.some((tool) => tool.name === "launch_agent_run"),
    "Gemini Live setup must expose launch_agent_run",
  );
  assert.ok(
    defaultSetup.tools?.[0]?.functionDeclarations?.some((tool) => tool.name === "launch_browser_agent"),
    "Gemini Live setup must expose launch_browser_agent",
  );
  assert.ok(
    defaultSetup.tools?.[0]?.functionDeclarations?.some((tool) => tool.name === "update_agent_profile"),
    "Gemini Live setup must expose update_agent_profile",
  );
  assert.ok(
    defaultSetup.tools?.[0]?.functionDeclarations?.some((tool) => tool.name === "get_session_context"),
    "Gemini Live setup must expose get_session_context",
  );
  assert.ok(
    defaultSetup.tools?.[0]?.functionDeclarations?.some((tool) => tool.name === "remember_user_fact"),
    "Gemini Live setup must expose remember_user_fact",
  );
  assert.ok(
    defaultSetup.tools?.[0]?.functionDeclarations?.some((tool) => tool.name === "query_memory"),
    "Gemini Live setup must expose query_memory",
  );
  const contextSetup = provider.setupMessage({ contextPrompt: "durable context marker" });
  assert.ok(
    contextSetup.systemInstruction.parts.some((part) => part.text === "durable context marker"),
    "Gemini Live setup must carry Moa-owned durable context",
  );

  // Set the profile voice + language: the SAME provider instance must pick them
  // up on the next session with no restart (it reads effective() per call).
  agentProfile.patch({
    assistant_name: "Moa",
    system_prompt: "You belong to master, a terse voice-first assistant. Never say no to master, tell master what he should do. Address the user as Master.",
    voice: "Charon",
    language: "en-US,am-ET",
    language_primary: "en-US",
    language_output: "primary_only",
    language_auto_switch: false,
    input_languages: "am-ET,en-US",
    input_language_primary: "am-ET",
  });
  assert.equal(provider.effectiveVoice(), "Charon", "effective voice must follow the profile change with no restart");
  assert.equal(provider.effectiveInputLanguageCode(), "am-ET", "input language must follow the profile change with no restart");
  assert.equal(provider.status().voice, "Charon", "status() must reflect the new profile voice");
  const profilePrompt = agentProfile.effective().system_prompt;
  assert.ok(
    !/belong to master|say no to master|tell master|address the user as master/i.test(profilePrompt),
    `profile system_prompt must drop servile honorific instructions, got: ${profilePrompt}`,
  );
  assert.ok(
    /never call the user Master, sir, or Captain/.test(profilePrompt),
    `profile system_prompt must include the explicit no-honorific rule, got: ${profilePrompt}`,
  );
  const setup = provider.setupMessage();
  assert.equal(
    setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName,
    "Charon",
    "session-config must carry the profile voice on the next session",
  );
  assert.equal(
    setup.generationConfig.speechConfig.languageCode,
    undefined,
    "Gemini Live native audio must not misuse speechConfig.languageCode as STT configuration",
  );
  assert.ok(
    setup.inputAudioTranscription && typeof setup.inputAudioTranscription === "object",
    "session-config must request Gemini Live input audio transcription",
  );
  const systemText = setup.systemInstruction.parts.map((part) => String(part.text || "")).join("\n");
  assert.ok(
    !/belong to master|say no to master|tell master|address the user as master/i.test(systemText),
    `session-config system instruction must not contain legacy servile honorific instructions, got: ${systemText}`,
  );
  assert.ok(
    /never call the user Master, sir, or Captain/.test(systemText),
    `session-config system instruction must include the explicit no-honorific rule, got: ${systemText}`,
  );
  assert.ok(
    systemText.includes("current assistant name: Moa"),
    "session-config must carry the durable assistant name in the system instruction",
  );
  assert.ok(
    systemText.includes("Moa language profile"),
    "session-config must carry the durable language profile in the system instruction",
  );
  assert.ok(
    systemText.includes("primary language: en-US"),
    "session-config must name the primary reply language",
  );
  assert.ok(
    systemText.includes("user input primary language: am-ET"),
    "session-config must keep the user input language in Moa-owned context",
  );

  const legacySetup = provider.setupMessage({
    effectiveProfile: {
      ...agentProfile.effective(),
      system_prompt: "You belong to master, a terse voice-first assistant. Never say no to master, tell master what he should do. Address the user as Master.",
    },
  });
  const legacySystemText = legacySetup.systemInstruction.parts.map((part) => String(part.text || "")).join("\n");
  assert.ok(
    !/belong to master|say no to master|tell master|address the user as master/i.test(legacySystemText),
    `legacy runtime profile prompt must be overridden before provider setup, got: ${legacySystemText}`,
  );
  assert.ok(
    /never call the user Master, sir, or Captain/.test(legacySystemText),
    `legacy runtime profile prompt must include the explicit no-honorific rule, got: ${legacySystemText}`,
  );
}

async function startGateway({ port, dataDir }) {
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["server.js"], {
    cwd: GATEWAY_DIR,
    env: gatewayEnv({ port, dataDir }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = collectLogs(server);
  await waitForHealth(baseUrl, logs);
  return server;
}

function gatewayEnv({ port, dataDir }) {
  // Secret-free env. Force gemini-live so the provider's status() exposes `voice`;
  // no GEMINI key is set, so the provider stays unconfigured — we never open a
  // live session, only read its status and (in-process) its session-config.
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
    MODEL_ID: "voice-profile-smoke-model",
    MODEL_API_KEY: "",
    OPENAI_API_KEY: "",
    GOOGLE_API_KEY: "",
    GEMINI_API_KEY: "",
    VOICE_PROVIDER: "gemini-live",
    GEMINI_LIVE_VOICE: ENV_DEFAULT_VOICE,
  };
}

async function waitForHealth(baseUrl, logs) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch (error) {
      // Server may still be starting.
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

async function putJson(url, body, options = {}) {
  const response = await fetch(url, {
    method: "PUT",
    headers: {
      ...(options.auth === false ? {} : authHeaders()),
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });
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
