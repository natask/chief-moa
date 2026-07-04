#!/usr/bin/env node
"use strict";

const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { WebSocket } = require("ws");

const GATEWAY_DIR = path.resolve(__dirname, "..");
const TOKEN = "test-token";

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-gateway-smoke-"));
  const dataDir = path.join(tempDir, "data");
  const otaDir = path.join(tempDir, "android-ota");
  const fakeGemini = writeFakeHarness(tempDir, "fake-gemini.sh", "gemini");
  const fakeCodex = writeFakeHarness(tempDir, "fake-codex.sh", "codex");
  const fakeHermes = writeFakeHarness(tempDir, "fake-hermes.sh", "hermes");
  const port = await freePort();
  let baseUrl = `http://127.0.0.1:${port}`;
  let server;
  const completedRunIds = [];

  try {
    server = await startGateway({ port, dataDir, otaDir, fakeGemini, fakeCodex, fakeHermes });

    await step("auth required", () => assertAuthRequired(baseUrl));
    await step("health", () => assertHealth(baseUrl));
    await step("agent profile token guard", () => assertAgentProfileTokenGuard(baseUrl));
    await step("agent profile options catalog", () => assertAgentProfileOptionsCatalog(baseUrl));
    await step("agent profile runtime cycle", () => assertAgentProfileRuntimeCycle(baseUrl, dataDir));
    await step("agent profile per-request overrides", () => assertAgentProfilePerRequestOverrides(baseUrl, dataDir));
    await step("agent profile device scope", () => assertAgentProfileDeviceScope(baseUrl, dataDir));
    await step("streaming voice persistence", () => assertStreamingVoiceSessionPersistence(baseUrl, dataDir));
    await step("voice chat and idempotency", () => assertVoiceChatAndIdempotency(baseUrl, dataDir));
    await step("control voice turn", () => assertControlTurn(baseUrl, dataDir));
    await step("voice-started agent run", async () => completedRunIds.push(await assertVoiceStartedAgentRun(baseUrl, dataDir)));
    await step("duplicate agent turn", async () => completedRunIds.push(await assertDuplicateAgentTurnDoesNotStartAnotherRun(baseUrl)));
    await step("multi-agent voice turn", async () => completedRunIds.push(...await assertMultiAgentVoiceTurn(baseUrl)));
    await step("direct async agent run", async () => completedRunIds.push(await assertDirectAsyncAgentRun(baseUrl, dataDir)));
    await step("hermes agent run", async () => completedRunIds.push(await assertHermesAgentRun(baseUrl, dataDir)));
    await step("agent run follow-up", async () => completedRunIds.push(await assertAgentRunFollowUp(baseUrl, dataDir, completedRunIds[completedRunIds.length - 1])));
    await step("canceled agent run", async () => completedRunIds.push(await assertCanceledAgentRun(baseUrl, dataDir)));
    await step("failed agent run", async () => completedRunIds.push(await assertFailedAgentRun(baseUrl, dataDir)));
    await step("invalid agent run input", () => assertInvalidAgentRunInput(baseUrl));
    await step("browser task queue", () => assertBrowserTaskQueue(baseUrl));
    await step("session and latest context", () => assertSessionAndLatestContext(baseUrl));
    await step("android OTA routes", () => assertAndroidOtaRoutes(baseUrl, otaDir));

    server.kill("SIGTERM");
    await onceExit(server, 1500);
    server = null;

    const restartPort = await freePort();
    baseUrl = `http://127.0.0.1:${restartPort}`;
    server = await startGateway({ port: restartPort, dataDir, otaDir, fakeGemini, fakeCodex, fakeHermes });
    await step("restart persistence", () => assertRestartPersistence(baseUrl, completedRunIds));

    console.log(JSON.stringify({
      ok: true,
      base_url: baseUrl,
      checks: [
        "auth required",
        "health",
        "agent profile token guard",
        "agent profile options catalog (valid voices/languages + strict validation)",
        "agent profile runtime cycle (PUT -> turn -> reset, no restart)",
        "agent profile per-request overrides (not persisted)",
        "agent profile device scope (global + current-device overrides)",
        "streaming voice persistence",
        "voice chat",
        "voice turn idempotency",
        "control voice turn",
        "voice-started agent run",
        "duplicate agent turn does not duplicate runs",
        "multi-agent voice turn",
        "direct wait=false agent run",
        "agent run follow-up",
        "canceled agent run",
        "failed agent run",
        "invalid agent run input",
        "browser task queue claim/receipt",
        "agent run list/detail",
        "session summaries",
        "latest context",
        "android OTA manifest/apk",
        "restart persistence",
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
    await fn();
  } catch (error) {
    error.message = `[${name}] ${error.message}`;
    throw error;
  }
}

async function startGateway({ port, dataDir, otaDir, fakeGemini, fakeCodex, fakeHermes }) {
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["server.js"], {
    cwd: GATEWAY_DIR,
    env: gatewayEnv({ port, dataDir, otaDir, fakeGemini, fakeCodex, fakeHermes }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = collectLogs(server);
  await waitForHealth(baseUrl, logs);
  return server;
}

function gatewayEnv({ port, dataDir, otaDir, fakeGemini, fakeCodex, fakeHermes }) {
  return {
    PATH: process.env.PATH || "",
    HOME: process.env.HOME || "",
    TMPDIR: process.env.TMPDIR || os.tmpdir(),
    HOST: "127.0.0.1",
    PORT: String(port),
    DATA_DIR: dataDir,
    ANDROID_OTA_DIR: otaDir,
    MOA_GATEWAY_TOKEN: TOKEN,
    DEFAULT_AGENT_HARNESS: "gemini",
    GEMINI_BIN: fakeGemini,
    CODEX_BIN: fakeCodex,
    HERMES_BIN: fakeHermes,
    MODEL_PROVIDER: "openai-compatible",
    MODEL_BASE_URL: "https://api.openai.com/v1",
    MODEL_ID: "smoke-model",
    MODEL_API_KEY: "",
    OPENAI_API_KEY: "",
    GOOGLE_API_KEY: "",
    GEMINI_API_KEY: "",
    VERTEX_PROJECT: "",
    GOOGLE_CLOUD_PROJECT: "",
    GOOGLE_APPLICATION_CREDENTIALS: "",
    VERTEX_ACCESS_TOKEN: "",
    HARNESS_STATUS_TIMEOUT_MS: "200",
    AGENT_RUN_TIMEOUT_MS: "5000",
    PROBE_GEMINI_VERSION: "1",
  };
}

async function assertAuthRequired(baseUrl) {
  const health = await requestJson(`${baseUrl}/health`, { auth: false });
  assert.equal(health.status, 200);

  const voice = await postJson(`${baseUrl}/v1/voice/turns`, {
    session_id: "auth_session",
    turn_id: "auth_turn",
    transcript: "hello",
  }, { auth: false });
  assert.equal(voice.status, 401);

  const agentRuns = await requestJson(`${baseUrl}/v1/agent/runs`, { auth: false });
  assert.equal(agentRuns.status, 401);

  const ota = await requestJson(`${baseUrl}/v1/android/updates/latest`, { auth: false });
  assert.equal(ota.status, 401);
}

async function assertHealth(baseUrl) {
  const health = await getJson(`${baseUrl}/health`);
  assert.equal(health.ok, true);
  assert.equal(health.agent_loop.default_harness, "gemini");
  assert.equal(health.agent_loop.token_required, true);
  const hermes = (health.agent_loop.harnesses || []).find((harness) => harness.name === "hermes");
  assert.ok(hermes, "hermes harness must be registered");
  assert.equal(hermes.available, true, "fake hermes harness must be available");
  assert.equal(health.android_ota.configured, false);
  const voiceProvider = health.voice_stream?.provider;
  assert.ok(voiceProvider, "health must expose voice_stream.provider");
  assert.equal(voiceProvider.runtime_mode, "native_live");
  assert.equal(voiceProvider.selected_providers.native_live, "loopback");
  assert.equal(voiceProvider.selected_providers.stt, "loopback");
  assert.equal(voiceProvider.selected_providers.reasoning, "loopback");
  assert.equal(voiceProvider.selected_providers.tts, "loopback");
  assert.equal(voiceProvider.configuration.configured, true);
  assert.equal(voiceProvider.capabilities.assistant_audio, true);
  assert.ok(
    voiceProvider.provider_registry.native_live.some((provider) => provider.id === "loopback"),
    "provider registry must include loopback",
  );
  assert.ok(
    voiceProvider.provider_registry.native_live.some((provider) => provider.id === "gemini-live"),
    "provider registry must include gemini-live",
  );
}

async function assertAgentProfileTokenGuard(baseUrl) {
  // Task 4.3: profile endpoints reject requests without a valid bearer token.
  const get = await requestJson(`${baseUrl}/v1/agent/profile`, { auth: false });
  assert.equal(get.status, 401, "GET profile must require a token");

  const options = await requestJson(`${baseUrl}/v1/agent/profile/options`, { auth: false });
  assert.equal(options.status, 401, "GET profile options must require a token");

  const put = await putJson(`${baseUrl}/v1/agent/profile`, { system_prompt: "unauthorized" }, { auth: false });
  assert.equal(put.status, 401, "PUT profile must require a token");

  const reset = await postJson(`${baseUrl}/v1/agent/profile/reset`, {}, { auth: false });
  assert.equal(reset.status, 401, "reset profile must require a token");

  // A wrong token is also rejected.
  const wrong = await fetch(`${baseUrl}/v1/agent/profile`, {
    headers: { Authorization: "Bearer not-the-token" },
  });
  assert.equal(wrong.status, 401, "wrong token must be rejected");

  // With a valid token it succeeds and starts at the env default.
  const authed = await getJson(`${baseUrl}/v1/agent/profile`);
  assert.equal(authed.is_overridden, false, "profile must start at env default");
  assert.equal(authed.profile.model, "smoke-model", "default model must come from env");
}

async function assertAgentProfileOptionsCatalog(baseUrl) {
  const catalog = await getJson(`${baseUrl}/v1/agent/profile/options`);
  assert.equal(catalog.version, "profile-options/v1");
  assert.ok(catalog.endpoints?.profile === "/v1/agent/profile", "catalog must name the profile endpoint");
  assert.ok(catalog.endpoints?.options === "/v1/agent/profile/options", "catalog must name the options endpoint");
  assert.ok(Array.isArray(catalog.models) && catalog.models.some((model) => model.id === "smoke-model" && model.current === true), "catalog must list the current gateway model");
  assert.ok(catalog.fields?.model?.values?.includes("smoke-model"), "catalog model field must include the current gateway model");
  assert.ok(Array.isArray(catalog.voices) && catalog.voices.length >= 8, "catalog must list supported voices");
  assert.deepEqual(catalog.languages.map((language) => language.code), ["en-US", "am-ET"], "catalog must expose only English and Amharic for now");

  const aoede = catalog.voices.find((voice) => voice.id === "Aoede");
  const charon = catalog.voices.find((voice) => voice.id === "Charon");
  assert.ok(aoede?.tone_tags?.includes("feminine"), "Aoede must carry feminine tone metadata");
  assert.ok(charon?.tone_tags?.includes("masculine"), "Charon must carry masculine tone metadata");
  assert.equal(catalog.fields?.voice?.aliases?.feminine, "Aoede");
  assert.equal(catalog.fields?.voice?.aliases?.masculine, "Charon");
  assert.ok(catalog.languages.some((language) => language.code === "en-US" && language.label === "English"));
  assert.ok(catalog.languages.some((language) => language.code === "am-ET" && language.label === "Amharic"));

  const valid = await putJson(`${baseUrl}/v1/agent/profile`, {
    source: "smoke-regression",
    profile: {
      voice: "feminine",
      language: "English,Amharic",
      input_languages: "English,Amharic",
      language_auto_switch: false,
    },
  });
  assert.equal(valid.status, 200);
  assert.equal(valid.json.profile.voice, "Aoede", "voice alias must canonicalize to a supported voice id");
  assert.equal(valid.json.profile.language, "en-US,am-ET");
  assert.equal(valid.json.profile.language_primary, "en-US", "reply primary must derive from first reply code");
  assert.equal(valid.json.profile.input_languages, "en-US,am-ET");
  assert.equal(valid.json.profile.input_language_primary, "en-US", "input primary must derive from first heard code");
  const versionAfterValid = valid.json.current_version;

  const invalid = await putJson(`${baseUrl}/v1/agent/profile`, {
    source: "smoke-regression",
    profile: {
      voice: "not-a-real-voice",
      language: "Spanish,French",
      input_languages: "en-US,not-a-language",
    },
  });
  assert.equal(invalid.status, 200);
  assert.equal(invalid.json.current_version, versionAfterValid, "invalid-only patch must not create a new profile version");
  assert.equal(invalid.json.profile.voice, "Aoede", "invalid voice must not persist");
  assert.equal(invalid.json.profile.language, "en-US,am-ET", "invalid reply language must not persist");
  assert.equal(invalid.json.profile.input_languages, "en-US,am-ET", "mixed invalid heard-language list must not persist");

  const languageOptionsTurn = await postJson(`${baseUrl}/v1/voice/turns`, {
    session_id: "profile_options_session",
    branch_id: "default",
    turn_id: "language_options_turn",
    source: "smoke-regression",
    transcript: "what are the different languages I can make you speak",
  });
  assert.equal(languageOptionsTurn.status, 200);
  assert.equal(languageOptionsTurn.json.classification, "profile_control");
  assert.match(languageOptionsTurn.json.display, /English \(en-US\)/);
  assert.match(languageOptionsTurn.json.display, /Amharic \(am-ET\)/);
  assert.equal(languageOptionsTurn.json.actions?.[0]?.subject, "language_options");

  const voiceOptionsTurn = await postJson(`${baseUrl}/v1/voice/turns`, {
    session_id: "profile_options_session",
    branch_id: "default",
    turn_id: "voice_options_turn",
    source: "smoke-regression",
    transcript: "what voices can you use",
  });
  assert.equal(voiceOptionsTurn.status, 200);
  assert.equal(voiceOptionsTurn.json.classification, "profile_control");
  assert.match(voiceOptionsTurn.json.display, /Aoede/);
  assert.match(voiceOptionsTurn.json.display, /masculine/);
  assert.equal(voiceOptionsTurn.json.actions?.[0]?.subject, "voice_options");

  const reset = await postJson(`${baseUrl}/v1/agent/profile/reset`, {
    source: "smoke-regression",
    scope: "global",
  });
  assert.equal(reset.status, 200);
  assert.equal(reset.json.is_overridden, false);
}

async function assertAgentProfileRuntimeCycle(baseUrl, dataDir) {
  // Task 4.1: PUT a new prompt + model, confirm the next /v1/voice/turns uses it,
  // then reset back to default, all without restarting the process.
  const before = await getJson(`${baseUrl}/v1/agent/profile`);
  assert.equal(before.is_overridden, false);
  const defaultModel = before.defaults.model;
  assert.equal(defaultModel, "smoke-model");

  const put = await putJson(`${baseUrl}/v1/agent/profile`, {
    system_prompt: "You are a terse runtime-edited assistant. Use the user's preferred name when known.",
    model: "runtime-edited-model",
    temperature: 0.1,
    voice_max_chars: 64,
  });
  assert.equal(put.status, 200);
  assert.equal(put.json.is_overridden, true);
  assert.equal(put.json.profile.model, "runtime-edited-model");
  assert.ok(
    put.json.profile.system_prompt.startsWith("You are a terse runtime-edited assistant. Use the user's preferred name when known."),
    "runtime-edited prompt must preserve the requested prompt text",
  );
  assert.equal(put.json.profile.temperature, 0.1);
  assert.equal(put.json.profile.voice_max_chars, 64);
  // The env default is immutable even after a patch.
  assert.equal(put.json.defaults.model, defaultModel);

  // GET reflects the persisted override without any restart.
  const afterPut = await getJson(`${baseUrl}/v1/agent/profile`);
  assert.equal(afterPut.profile.model, "runtime-edited-model");
  assert.equal(afterPut.is_overridden, true);

  // The very next voice turn uses the edited profile (persisted conversation
  // records the effective model).
  const editedTurn = await postJson(`${baseUrl}/v1/voice/turns`, {
    session_id: "profile_runtime_session",
    branch_id: "default",
    turn_id: "turn_after_put",
    transcript: "what is the gateway status",
    source: "smoke-regression",
  });
  assert.equal(editedTurn.status, 200);
  const editedConversation = JSON.parse(fs.readFileSync(
    path.join(dataDir, "conversations", "profile_runtime_session.json"), "utf8"));
  assert.equal(editedConversation.model, "runtime-edited-model", "turn after PUT must record edited model");

  // Reset drops overrides and returns to the env default.
  const reset = await postJson(`${baseUrl}/v1/agent/profile/reset`, {});
  assert.equal(reset.status, 200);
  assert.equal(reset.json.is_overridden, false);
  assert.equal(reset.json.profile.model, defaultModel);
  assert.equal(reset.json.profile.system_prompt, before.profile.system_prompt);

  const afterReset = await getJson(`${baseUrl}/v1/agent/profile`);
  assert.equal(afterReset.is_overridden, false);
  assert.equal(afterReset.profile.model, defaultModel);

  // A turn after reset records the env default model again, still no restart.
  const resetTurn = await postJson(`${baseUrl}/v1/voice/turns`, {
    session_id: "profile_runtime_session",
    branch_id: "default",
    turn_id: "turn_after_reset",
    transcript: "voice check after reset",
    source: "smoke-regression",
  });
  assert.equal(resetTurn.status, 200);
  const resetConversation = JSON.parse(fs.readFileSync(
    path.join(dataDir, "conversations", "profile_runtime_session.json"), "utf8"));
  assert.equal(resetConversation.model, defaultModel, "turn after reset must record env default model");
}

async function assertAgentProfilePerRequestOverrides(baseUrl, dataDir) {
  // Task 4.2: profile_overrides apply for one request only and never persist.
  const persisted = await putJson(`${baseUrl}/v1/agent/profile`, { model: "persisted-model" });
  assert.equal(persisted.status, 200);
  assert.equal(persisted.json.profile.model, "persisted-model");

  // A turn carrying profile_overrides uses the override for that turn.
  const overrideTurn = await postJson(`${baseUrl}/v1/voice/turns`, {
    session_id: "profile_override_session",
    branch_id: "default",
    turn_id: "turn_with_override",
    transcript: "override just this turn",
    source: "smoke-regression",
    profile_overrides: { model: "one-shot-override-model" },
  });
  assert.equal(overrideTurn.status, 200);
  const overrideConversation = JSON.parse(fs.readFileSync(
    path.join(dataDir, "conversations", "profile_override_session.json"), "utf8"));
  assert.equal(overrideConversation.model, "one-shot-override-model", "override turn must use override model");

  // The persisted profile is unchanged by the per-request override.
  const afterOverride = await getJson(`${baseUrl}/v1/agent/profile`);
  assert.equal(afterOverride.profile.model, "persisted-model", "override must not mutate persisted profile");
  assert.equal(afterOverride.is_overridden, true);

  // A subsequent turn WITHOUT overrides falls back to the persisted profile.
  const plainTurn = await postJson(`${baseUrl}/v1/voice/turns`, {
    session_id: "profile_override_session",
    branch_id: "default",
    turn_id: "turn_without_override",
    transcript: "no override this time",
    source: "smoke-regression",
  });
  assert.equal(plainTurn.status, 200);
  const plainConversation = JSON.parse(fs.readFileSync(
    path.join(dataDir, "conversations", "profile_override_session.json"), "utf8"));
  assert.equal(plainConversation.model, "persisted-model", "turn without override must use persisted model");

  // Clean up so later checks observe the env default again.
  const reset = await postJson(`${baseUrl}/v1/agent/profile/reset`, {});
  assert.equal(reset.status, 200);
  assert.equal(reset.json.is_overridden, false);
}

async function assertAgentProfileDeviceScope(baseUrl, dataDir) {
  const deviceA = "browser_device_a";
  const deviceB = "android_device_b";

  const globalPut = await putJson(`${baseUrl}/v1/agent/profile`, {
    source: "smoke-regression",
    scope: "global",
    profile: {
      voice: "Charon",
      language: "en-US",
      language_primary: "en-US",
      input_languages: "en-US",
      input_language_primary: "en-US",
    },
  });
  assert.equal(globalPut.status, 200);
  assert.equal(globalPut.json.scope, "global");
  assert.equal(globalPut.json.profile.voice, "Charon");

  const devicePut = await putJson(`${baseUrl}/v1/agent/profile`, {
    source: "smoke-regression",
    scope: "device",
    device_id: deviceA,
    profile: {
      voice: "Kore",
      input_languages: "am-ET",
      input_language_primary: "am-ET",
    },
  });
  assert.equal(devicePut.status, 200);
  assert.equal(devicePut.json.scope, "device");
  assert.equal(devicePut.json.device_id, deviceA);
  assert.equal(devicePut.json.profile.voice, "Kore");
  assert.equal(devicePut.json.profile.language, "en-US", "device override must inherit global reply language");
  assert.equal(devicePut.json.profile.input_languages, "am-ET", "device override must replace heard language");

  const globalProfile = await getJson(`${baseUrl}/v1/agent/profile`);
  assert.equal(globalProfile.profile.voice, "Charon", "global profile must not pick up device override");
  assert.equal(globalProfile.profile.input_languages, "en-US", "global heard language must remain unchanged");

  const deviceProfile = await getJson(`${baseUrl}/v1/agent/profile?scope=device&device_id=${deviceA}`);
  assert.equal(deviceProfile.scope, "device");
  assert.equal(deviceProfile.profile.voice, "Kore");
  assert.equal(deviceProfile.profile.input_languages, "am-ET");

  const otherDeviceProfile = await getJson(`${baseUrl}/v1/agent/profile?scope=device&device_id=${deviceB}`);
  assert.equal(otherDeviceProfile.profile.voice, "Charon", "other devices should inherit global voice");
  assert.equal(otherDeviceProfile.profile.input_languages, "en-US", "other devices should inherit global input language");

  const spokenDeviceUpdate = await postJson(`${baseUrl}/v1/voice/turns`, {
    session_id: "profile_scope_session",
    branch_id: "default",
    turn_id: "device_profile_voice_turn",
    source: "smoke-regression",
    device_id: deviceA,
    transcript: "respond in Amharic on this device",
  });
  assert.equal(spokenDeviceUpdate.status, 200);
  assert.equal(spokenDeviceUpdate.json.classification, "profile_control");
  assert.equal(spokenDeviceUpdate.json.profile.scope, "device");
  assert.equal(spokenDeviceUpdate.json.profile.device_id, deviceA);
  assert.equal(spokenDeviceUpdate.json.profile.language.allowed, "am-ET");

  const afterSpokenDevice = await getJson(`${baseUrl}/v1/agent/profile?scope=device&device_id=${deviceA}`);
  assert.equal(afterSpokenDevice.profile.language, "am-ET", "spoken profile control must update only this device");
  const afterSpokenGlobal = await getJson(`${baseUrl}/v1/agent/profile`);
  assert.equal(afterSpokenGlobal.profile.language, "en-US", "spoken device update must not mutate global reply language");

  const versionsPath = path.join(dataDir, "agent-profile-device-overrides.json");
  assert.ok(fs.existsSync(versionsPath), "device override file must persist to disk");

  const resetDevice = await postJson(`${baseUrl}/v1/agent/profile/reset`, {
    source: "smoke-regression",
    scope: "device",
    device_id: deviceA,
  });
  assert.equal(resetDevice.status, 200);
  assert.equal(resetDevice.json.profile.voice, "Charon", "device reset should reveal inherited global voice");

  const resetGlobal = await postJson(`${baseUrl}/v1/agent/profile/reset`, {
    source: "smoke-regression",
    scope: "global",
  });
  assert.equal(resetGlobal.status, 200);
  assert.equal(resetGlobal.json.is_overridden, false);
}

async function assertStreamingVoiceSessionPersistence(baseUrl, dataDir) {
  const target = baseUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:") + "/v1/voice/sessions";
  const sessionId = "stream_smoke_session";
  const branchId = "stream_branch";
  const turnId = "stream_smoke_turn";
  const events = await smokeStreamingVoiceSession(target, sessionId, branchId, turnId);

  assert.ok(events.includes("session_ready"), "streaming voice missing session_ready");
  assert.ok(events.includes("assistant_audio_start"), "streaming voice missing assistant_audio_start");
  assert.ok(events.includes("assistant_audio_done"), "streaming voice missing assistant_audio_done");
  assert.ok(events.includes("turn_done"), "streaming voice missing turn_done");

  const sessionDir = path.join(dataDir, "voice-sessions", sessionId);
  const userAudioPath = path.join(sessionDir, `${turnId}.pcm`);
  const assistantAudioPath = path.join(sessionDir, `${turnId}.assistant.pcm`);
  const metadataPath = path.join(sessionDir, `${turnId}.json`);
  assert.ok(fs.existsSync(userAudioPath), "streaming user audio file missing");
  assert.ok(fs.statSync(userAudioPath).size > 0, "streaming user audio file was empty");
  assert.ok(fs.existsSync(assistantAudioPath), "streaming assistant audio file missing");
  assert.ok(fs.statSync(assistantAudioPath).size > 0, "streaming assistant audio file was empty");
  assert.ok(fs.existsSync(metadataPath), "streaming metadata file missing");

  const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  assert.equal(metadata.status, "completed");
  assert.equal(metadata.audio.pcm_file, `${turnId}.pcm`);
  assert.ok(metadata.audio.bytes > 0, "streaming metadata missing user audio bytes");
  assert.equal(metadata.assistant_audio.pcm_file, `${turnId}.assistant.pcm`);
  assert.ok(metadata.assistant_audio.bytes > 0, "streaming metadata missing assistant audio bytes");
  assert.equal(metadata.assistant.provider, "loopback");
  assert.equal(metadata.conversation_id, sessionId);
  assert.equal(metadata.branch_id, branchId);
  assert.equal(metadata.playback_policy?.assistant_overlap, true, "streaming metadata missing assistant overlap playback policy");

  const canonicalPath = path.join(dataDir, "voice-turns", sessionId, `${turnId}.json`);
  assert.ok(fs.existsSync(canonicalPath), "streaming canonical voice-turn record missing");
  const canonical = JSON.parse(fs.readFileSync(canonicalPath, "utf8"));
  assert.equal(canonical.session_id, sessionId);
  assert.equal(canonical.conversation_id, sessionId);
  assert.equal(canonical.branch_id, branchId);
  assert.equal(canonical.id, turnId);
  assert.ok(canonical.profile_version, "streaming canonical record missing profile version");
  assert.equal(canonical.classification, "chat");
  assert.equal(canonical.response.turn_id, turnId);
  assert.match(String(canonical.response.display || ""), /Streaming voice transport is connected/);
  assert.equal(
    canonical.references?.voice_session?.playback_policy?.assistant_overlap,
    true,
    "canonical voice-turn reference missing assistant overlap playback policy",
  );

  const history = await getJson(`${baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/turns`);
  assert.ok(Array.isArray(history.turns), "streaming session history must be an array");
  const historyTurn = history.turns.find((turn) => turn.turn_id === turnId);
  assert.ok(historyTurn, "streaming turn must be queryable by session history");
  assert.ok(historyTurn.audio?.user?.href, "streaming history turn must expose user audio playback ref");
  assert.ok(historyTurn.audio?.assistant?.href, "streaming history turn must expose assistant audio playback ref");

  const archive = await getJson(`${baseUrl}/v1/history/messages?session_id=${encodeURIComponent(sessionId)}&q=streaming`);
  const archivedTurn = archive.messages.find((message) => message.type === "voice_turn" && message.turn_id === turnId);
  assert.ok(archivedTurn, "history search must return the sent streaming voice message");
  assert.ok(archivedTurn.audio?.user?.href, "history search result must include user audio ref");

  const userAudio = await requestBinary(`${baseUrl}${historyTurn.audio.user.href}`);
  assert.equal(userAudio.status, 200, "user audio endpoint must succeed");
  assert.equal(userAudio.contentType, "audio/L16; rate=16000; channels=1");
  assert.equal(userAudio.buffer.length, fs.statSync(userAudioPath).size, "user audio endpoint must return archived PCM bytes");
}

function smokeStreamingVoiceSession(target, sessionId, branchId, turnId) {
  const seen = [];

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target, {
      headers: authHeaders(),
    });
    const timeout = setTimeout(() => {
      closeWebSocketQuietly(ws);
      reject(new Error(`timed out waiting for ${target}`));
    }, 5000);

    ws.on("open", () => {
      ws.send(JSON.stringify({
        type: "session_start",
        session_id: sessionId,
        conversation_id: sessionId,
        branch_id: branchId,
        turn_id: turnId,
        source: "smoke-regression",
        playback_policy: {
          assistant_overlap: true,
        },
        format: {
          encoding: "pcm16",
          sample_rate: 16000,
          channels: 1,
        },
      }));
    });

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        return;
      }
      const event = JSON.parse(Buffer.from(data).toString("utf8"));
      if (event.type === "error") {
        clearTimeout(timeout);
        closeWebSocketQuietly(ws);
        reject(new Error(event.message || "streaming voice returned error"));
        return;
      }
      seen.push(event.type);
      if (event.type === "session_ready") {
        ws.send(generatePcm16Tone(16000, 220, 0.2, 320));
        ws.send(JSON.stringify({
          type: "commit_turn",
          turn_id: turnId,
        }));
      }
      if (event.type === "turn_done") {
        clearTimeout(timeout);
        closeWebSocketQuietly(ws);
        resolve(seen);
      }
    });

    ws.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    ws.on("close", () => {
      if (!seen.includes("turn_done")) {
        clearTimeout(timeout);
        reject(new Error("streaming voice websocket closed before turn_done"));
      }
    });
  });
}

async function assertVoiceChatAndIdempotency(baseUrl, dataDir) {
  const body = {
    session_id: "smoke_session",
    branch_id: "default",
    turn_id: "turn_chat",
    transcript: "hello gateway",
    source: "smoke-regression",
    screen: { package: "test.app", class: "Main", text: "Visible text" },
  };

  const first = await postJson(`${baseUrl}/v1/voice/turns`, body);
  assert.equal(first.status, 200);
  assert.equal(first.json.session_id, body.session_id);
  assert.equal(first.json.branch_id, body.branch_id);
  assert.equal(first.json.turn_id, body.turn_id);
  assert.equal(first.json.classification, "chat");
  assert.ok(first.json.text);

  const duplicate = await postJson(`${baseUrl}/v1/voice/turns`, body);
  assert.equal(duplicate.status, 200);
  assert.deepEqual(duplicate.json, first.json);

  const voiceTurnPath = path.join(dataDir, "voice-turns", body.session_id, `${body.turn_id}.json`);
  assert.ok(fs.existsSync(voiceTurnPath), "voice turn record was not persisted");
  const persisted = JSON.parse(fs.readFileSync(voiceTurnPath, "utf8"));
  assert.equal(persisted.session_id, body.session_id);
  assert.equal(persisted.branch_id, body.branch_id);
  assert.equal(persisted.id, body.turn_id);
  assert.equal(persisted.classification, "chat");
  assert.equal(persisted.response.turn_id, body.turn_id);

  const time = await postJson(`${baseUrl}/v1/voice/turns`, {
    session_id: "smoke_session",
    branch_id: "default",
    turn_id: "turn_time",
    transcript: "what time is it",
    source: "smoke-regression",
  });
  assert.equal(time.status, 200);
  assert.equal(time.json.classification, "chat");
  assert.match(time.json.display || "", /^It's .+\.$/);
  assert.doesNotMatch(time.json.display || "", /without a model provider|don't have access/i);
}

async function assertControlTurn(baseUrl, dataDir) {
  const body = {
    session_id: "smoke_session",
    branch_id: "default",
    turn_id: "turn_stop",
    transcript: "stop",
    source: "smoke-regression",
  };

  const response = await postJson(`${baseUrl}/v1/voice/turns`, body);
  assert.equal(response.status, 200);
  assert.equal(response.json.classification, "control");
  assert.deepEqual(response.json.actions, [{ type: "control", name: "stop" }]);
  assert.equal(response.json.text, "");

  const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, "voice-turns", body.session_id, `${body.turn_id}.json`), "utf8"));
  assert.equal(persisted.classification, "control");
}

async function assertVoiceStartedAgentRun(baseUrl, dataDir) {
  const response = await postJson(`${baseUrl}/v1/voice/turns`, {
    session_id: "smoke_session",
    branch_id: "default",
    turn_id: "turn_agent",
    transcript: "fix the small issue",
    forced_action: "agent_run",
    source: "smoke-regression",
  });

  assert.equal(response.status, 202);
  assert.equal(response.json.classification, "agent_run");
  assert.equal(response.json.agent_runs.length, 1);
  const runId = response.json.agent_runs[0].id;
  assert.ok(runId.startsWith("run_"));

  const detail = await waitForRunTerminal(baseUrl, runId);
  assert.equal(detail.run.status, "completed");
  assert.match(detail.run.output || "", /fake harness completed/);
  assert.ok(Array.isArray(detail.events));
  assert.ok(detail.events.some((event) => event.type === "queued"));
  assert.ok(detail.events.some((event) => event.type === "completed"));

  assertPersistedRun(dataDir, runId, {
    status: "completed",
    harness: "gemini",
    conversation_id: "smoke_session",
  });
  return runId;
}

async function assertDuplicateAgentTurnDoesNotStartAnotherRun(baseUrl) {
  const body = {
    session_id: "smoke_session",
    branch_id: "default",
    turn_id: "turn_agent_duplicate",
    transcript: "fix another small issue",
    forced_action: "agent_run",
    source: "smoke-regression",
  };

  const first = await postJson(`${baseUrl}/v1/voice/turns`, body);
  assert.equal(first.status, 202);
  assert.equal(first.json.agent_runs.length, 1);
  const runId = first.json.agent_runs[0].id;
  await waitForRunTerminal(baseUrl, runId);

  const before = await getJson(`${baseUrl}/v1/agent/runs?limit=100`);
  const duplicate = await postJson(`${baseUrl}/v1/voice/turns`, body);
  const after = await getJson(`${baseUrl}/v1/agent/runs?limit=100`);

  assert.equal(duplicate.status, 200);
  assert.deepEqual(duplicate.json, first.json);
  assert.equal(after.runs.length, before.runs.length);
  assert.equal(after.runs.filter((run) => run.id === runId).length, 1);
  return runId;
}

async function assertMultiAgentVoiceTurn(baseUrl) {
  const response = await postJson(`${baseUrl}/v1/voice/turns`, {
    session_id: "parallel_session",
    branch_id: "branch_a",
    turn_id: "turn_multi_agent",
    transcript: "run gemini and codex on this",
    forced_action: "multi_agent",
    harnesses: ["gemini", "codex"],
    source: "smoke-regression",
  });

  assert.equal(response.status, 202);
  assert.equal(response.json.session_id, "parallel_session");
  assert.equal(response.json.branch_id, "branch_a");
  assert.equal(response.json.classification, "multi_agent");
  assert.equal(response.json.agent_runs.length, 2);
  assert.deepEqual(response.json.agent_runs.map((run) => run.harness).sort(), ["codex", "gemini"]);

  const runIds = [];
  for (const run of response.json.agent_runs) {
    const detail = await waitForRunTerminal(baseUrl, run.id);
    assert.equal(detail.run.status, "completed");
    runIds.push(run.id);
  }
  return runIds;
}

async function assertDirectAsyncAgentRun(baseUrl, dataDir) {
  const started = Date.now();
  const response = await postJson(`${baseUrl}/v1/agent/runs`, {
    source: "smoke-regression",
    conversation_id: "smoke_session",
    harness: "gemini",
    wait: false,
    prompt: "run a fake smoke command",
  });
  const elapsedMs = Date.now() - started;

  assert.equal(response.status, 202);
  assert.ok(elapsedMs < 1500, `wait=false response was too slow: ${elapsedMs}ms`);
  assert.ok(response.json.run.id.startsWith("run_"));

  const list = await getJson(`${baseUrl}/v1/agent/runs?limit=10`);
  assert.ok(list.runs.some((run) => run.id === response.json.run.id));

  const detail = await waitForRunTerminal(baseUrl, response.json.run.id);
  assert.equal(detail.run.status, "completed");
  assertPersistedRun(dataDir, response.json.run.id, {
    status: "completed",
    harness: "gemini",
    conversation_id: "smoke_session",
  });
  return response.json.run.id;
}

async function assertHermesAgentRun(baseUrl, dataDir) {
  const response = await postJson(`${baseUrl}/v1/agent/runs`, {
    source: "smoke-regression",
    conversation_id: "smoke_hermes_session",
    harness: "hermes",
    wait: false,
    prompt: "use Hermes to build a tiny smoke change",
  });

  assert.equal(response.status, 202);
  const runId = response.json.run.id;
  const detail = await waitForRunTerminal(baseUrl, runId);
  assert.equal(detail.run.status, "completed");
  assert.match(detail.run.output || "", /fake harness completed: hermes/);
  assertPersistedRun(dataDir, runId, {
    status: "completed",
    harness: "hermes",
    conversation_id: "smoke_hermes_session",
  });
  return runId;
}

async function assertCanceledAgentRun(baseUrl, dataDir) {
  const response = await postJson(`${baseUrl}/v1/agent/runs`, {
    source: "smoke-regression",
    conversation_id: "smoke_cancel_session",
    harness: "gemini",
    wait: false,
    prompt: "SLEEP_SMOKE",
  });

  assert.equal(response.status, 202);
  const runId = response.json.run.id;
  await waitForRunStatus(baseUrl, runId, "running");

  const canceled = await postJson(`${baseUrl}/v1/agent/runs/${runId}/cancel`, {});
  assert.ok(canceled.status === 200 || canceled.status === 202);

  const detail = await waitForRunTerminal(baseUrl, runId);
  assert.equal(detail.run.status, "canceled");
  assert.match(detail.run.error, /canceled/);
  assert.ok(detail.events.some((event) => event.type === "cancel_requested"));
  assert.ok(detail.events.some((event) => event.type === "canceled"));
  assertPersistedRun(dataDir, runId, {
    status: "canceled",
    harness: "gemini",
    conversation_id: "smoke_cancel_session",
  });
  return runId;
}

async function assertAgentRunFollowUp(baseUrl, dataDir, parentRunId) {
  assert.ok(parentRunId, "parent run id required");
  const response = await postJson(`${baseUrl}/v1/agent/runs/${parentRunId}/followups`, {
    source: "smoke-regression",
    conversation_id: "smoke_session",
    prompt: "use this follow-up context",
  });

  assert.equal(response.status, 202);
  assert.equal(response.json.parent_run_id, parentRunId);
  const childRunId = response.json.run.id;
  assert.ok(childRunId.startsWith("run_"));

  const parentDetail = await getJson(`${baseUrl}/v1/agent/runs/${parentRunId}`);
  assert.ok(parentDetail.events.some((event) => event.type === "follow_up"));

  const childDetail = await waitForRunTerminal(baseUrl, childRunId);
  assert.equal(childDetail.run.status, "completed");
  assert.equal(childDetail.run.parent_run_id, parentRunId);
  assertPersistedRun(dataDir, childRunId, {
    status: "completed",
    harness: parentDetail.run.harness,
    conversation_id: "smoke_session",
    parent_run_id: parentRunId,
  });
  return childRunId;
}

async function assertFailedAgentRun(baseUrl, dataDir) {
  const response = await postJson(`${baseUrl}/v1/agent/runs`, {
    source: "smoke-regression",
    conversation_id: "smoke_failure_session",
    harness: "gemini",
    wait: false,
    prompt: "FAIL_SMOKE",
  });

  assert.equal(response.status, 202);
  const runId = response.json.run.id;
  const detail = await waitForRunTerminal(baseUrl, runId);
  assert.equal(detail.run.status, "failed");
  assert.equal(detail.run.exit_code, 7);
  assert.match(detail.run.error, /harness exited with code 7/);
  assert.match(detail.run.stderr || "", /fake harness failed/);
  assert.ok(detail.events.some((event) => event.type === "failed"));
  assertPersistedRun(dataDir, runId, {
    status: "failed",
    harness: "gemini",
    conversation_id: "smoke_failure_session",
  });
  return runId;
}

async function assertInvalidAgentRunInput(baseUrl) {
  const emptyPrompt = await postJson(`${baseUrl}/v1/agent/runs`, {
    source: "smoke-regression",
    harness: "gemini",
    wait: false,
    prompt: "",
  });
  assert.equal(emptyPrompt.status, 400);
  assert.match(emptyPrompt.json.error, /prompt is required/);

  const badHarness = await postJson(`${baseUrl}/v1/agent/runs`, {
    source: "smoke-regression",
    harness: "unknown",
    wait: false,
    prompt: "hello",
  });
  assert.equal(badHarness.status, 400);
  assert.match(badHarness.json.error, /harness must be one of/);
}

async function assertBrowserTaskQueue(baseUrl) {
  const unauth = await postJson(`${baseUrl}/v1/browser/tasks`, {
    instruction: "open a page",
  }, { auth: false });
  assert.equal(unauth.status, 401, "browser task creation must require token");

  const created = await postJson(`${baseUrl}/v1/browser/tasks`, {
    source: "smoke-regression",
    conversation_id: "browser_queue_session",
    branch_id: "default",
    instruction: "inspect the page title",
    url: "http://example.com/",
    cdp_actions: [
      {
        method: "Runtime.evaluate",
        params: {
          expression: "document.title",
          returnByValue: true,
        },
      },
      {
        method: "Runtime.callFunctionOn",
        params: { functionDeclaration: "() => chrome" },
      },
    ],
  });
  assert.equal(created.status, 202);
  assert.equal(created.json.task.status, "pending");
  assert.equal(created.json.task.action_count, 1, "unsupported CDP methods must be stripped");
  assert.equal(created.json.task.cdp_actions.length, 1);

  const claim = await postJson(`${baseUrl}/v1/browser/tasks/claim`, {
    client_id: "smoke-extension",
  });
  assert.equal(claim.status, 200);
  assert.equal(claim.json.task.id, created.json.task.id);
  assert.equal(claim.json.task.status, "claimed");
  assert.equal(claim.json.task.claimed_by, "smoke-extension");
  assert.equal(claim.json.task.cdp_actions.length, 1);

  const receipt = await postJson(`${baseUrl}/v1/browser/tasks/${claim.json.task.id}/receipts`, {
    client_id: "smoke-extension",
    ok: true,
    summary: "captured page state",
    action_results: [{ method: "Runtime.evaluate", ok: true, value: "Example Domain" }],
    page_state: { title: "Example Domain", url: "http://example.com/", ready: "complete" },
    screenshot: { format: "jpeg", bytes: 1200 },
  });
  assert.equal(receipt.status, 200);
  assert.equal(receipt.json.task.status, "completed");
  assert.equal(receipt.json.receipt.ok, true);

  const completed = await getJson(`${baseUrl}/v1/browser/tasks?status=completed&limit=5`);
  assert.ok(completed.tasks.some((task) => task.id === claim.json.task.id), "completed task must be listable");
}

async function assertSessionAndLatestContext(baseUrl) {
  const sessions = await getJson(`${baseUrl}/v1/sessions?limit=10`);
  assert.ok(Array.isArray(sessions.sessions));
  const smoke = sessions.sessions.find((session) => session.session_id === "smoke_session" && session.branch_id === "default");
  assert.ok(smoke, "missing smoke_session summary");
  assert.ok(smoke.turn_count >= 1);
  assert.ok(Array.isArray(smoke.agent_run_ids));

  const latest = await getJson(`${baseUrl}/v1/context/latest`);
  assert.equal(latest.store.type, "json-files");
  assert.ok(Array.isArray(latest.sessions));
  assert.ok(Array.isArray(latest.recent_turns));
  assert.ok(Array.isArray(latest.recent_runs));
  assert.ok(latest.recent_runs.length >= 1);
}

async function assertAndroidOtaRoutes(baseUrl, otaDir) {
  const missing = await requestJson(`${baseUrl}/v1/android/updates/latest`);
  assert.equal(missing.status, 404);

  fs.mkdirSync(otaDir, { recursive: true });
  const apk = Buffer.from("fake apk fixture\n", "utf8");
  const apkPath = path.join(otaDir, "moa-assistant.apk");
  fs.writeFileSync(apkPath, apk);
  fs.writeFileSync(path.join(otaDir, "latest.json"), JSON.stringify({
    app_id: "ai.moa.assistant",
    version_code: 42,
    version_name: "0.1.42",
    apk: "moa-assistant.apk",
    size_bytes: apk.length,
    sha256: crypto.createHash("sha256").update(apk).digest("hex"),
    git_sha: "smoke",
    built_at: new Date().toISOString(),
    min_sdk: 26,
  }, null, 2));

  const manifest = await getJson(`${baseUrl}/v1/android/updates/latest`);
  assert.equal(manifest.version_code, 42);
  assert.match(manifest.download_url, /\/v1\/android\/updates\/latest\.apk$/);

  const apkResponse = await fetch(`${baseUrl}/v1/android/updates/latest.apk`, {
    headers: authHeaders(),
  });
  assert.equal(apkResponse.status, 200);
  assert.equal(apkResponse.headers.get("content-type"), "application/vnd.android.package-archive");
  const downloaded = Buffer.from(await apkResponse.arrayBuffer());
  assert.deepEqual(downloaded, apk);
}

async function assertRestartPersistence(baseUrl, expectedRunIds) {
  const health = await getJson(`${baseUrl}/health`);
  assert.equal(health.android_ota.configured, true);
  assert.equal(health.android_ota.version_code, 42);

  const list = await getJson(`${baseUrl}/v1/agent/runs?limit=100`);
  for (const runId of expectedRunIds) {
    const summary = list.runs.find((run) => run.id === runId);
    assert.ok(summary, `missing persisted run summary ${runId}`);
    assert.equal(summary.active, false);

    const detail = await getJson(`${baseUrl}/v1/agent/runs/${runId}`);
    assert.equal(detail.run.id, runId);
    assert.equal(detail.active, false);
    assert.ok(Array.isArray(detail.events));
    assert.ok(detail.events.length >= 2);
  }

  const manifest = await getJson(`${baseUrl}/v1/android/updates/latest`);
  assert.equal(manifest.version_code, 42);
}

function assertPersistedRun(dataDir, runId, expected) {
  const runPath = path.join(dataDir, "agent-runs", `${runId}.json`);
  const eventPath = path.join(dataDir, "agent-runs", `${runId}.events.jsonl`);
  assert.ok(fs.existsSync(runPath), `run file missing for ${runId}`);
  assert.ok(fs.existsSync(eventPath), `event log missing for ${runId}`);

  const run = JSON.parse(fs.readFileSync(runPath, "utf8"));
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(run[key], value, `run ${runId} ${key}`);
  }

  const eventTypes = fs.readFileSync(eventPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line).type);
  assert.ok(eventTypes.includes("queued"), `run ${runId} missing queued event`);
  assert.ok(eventTypes.includes(expected.status), `run ${runId} missing ${expected.status} event`);
}

async function waitForRunTerminal(baseUrl, runId) {
  const terminal = new Set(["completed", "failed", "timed-out", "canceled"]);
  const deadline = Date.now() + 5000;
  let last;
  while (Date.now() < deadline) {
    last = await getJson(`${baseUrl}/v1/agent/runs/${runId}`);
    if (terminal.has(last.run.status)) {
      return last;
    }
    await sleep(100);
  }
  throw new Error(`run ${runId} did not finish; last=${JSON.stringify(last)}`);
}

async function waitForRunStatus(baseUrl, runId, status) {
  const deadline = Date.now() + 5000;
  let last;
  while (Date.now() < deadline) {
    last = await getJson(`${baseUrl}/v1/agent/runs/${runId}`);
    if (last.run.status === status) {
      return last;
    }
    await sleep(100);
  }
  throw new Error(`run ${runId} did not reach ${status}; last=${JSON.stringify(last)}`);
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

async function requestBinary(url, options = {}) {
  const response = await fetch(url, { headers: options.auth === false ? {} : authHeaders() });
  const buffer = Buffer.from(await response.arrayBuffer());
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    buffer,
  };
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

function authHeaders() {
  return { Authorization: `Bearer ${TOKEN}` };
}

function closeWebSocketQuietly(ws) {
  try {
    ws.close(1000, "smoke complete");
  } catch (error) {
    // Ignore close errors during smoke cleanup.
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

function writeFakeHarness(tempDir, fileName, label) {
  const filePath = path.join(tempDir, fileName);
  fs.writeFileSync(filePath, [
    "#!/usr/bin/env sh",
    `if [ "$1" = "-v" ] || [ "$1" = "--version" ]; then echo 'fake-${label} 0.0.0'; exit 0; fi`,
    "case \"$*\" in *FAIL_SMOKE*) echo 'fake harness failed' >&2; exit 7;; esac",
    "case \"$*\" in *SLEEP_SMOKE*) sleep 5; echo 'fake harness slept'; exit 0;; esac",
    `echo 'fake harness completed: ${label}'`,
  ].join("\n"));
  fs.chmodSync(filePath, 0o755);
  return filePath;
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
