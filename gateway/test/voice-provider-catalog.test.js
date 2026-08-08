"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createAgentProfileStore } = require("../lib/agent-profile");
const { createVoiceSessionAdmission } = require("../lib/voice-session-admission");
const {
  createVoiceProviderCatalog,
  resolveProviderSelection,
  validateProfileProviderPatch,
  voiceProviderEnvForProfile,
} = require("../lib/voice-provider-catalog");

const BASE_PROFILE = {
  model: "gpt-test", voice_provider: "chirp", stt_provider: "chirp",
  reasoning_provider: "openai-compatible", tts_provider: "gemini-tts",
};

test("catalog reports credential readiness without exposing values or inventing Claude duplex audio", () => {
  const secret = "do-not-leak-provider-secret";
  const catalog = createVoiceProviderCatalog({
    profile: BASE_PROFILE,
    env: configuredEnv({ OPENAI_API_KEY: secret, XAI_API_KEY: secret, GEMINI_API_KEY: secret,
      ANTHROPIC_API_KEY: secret, MODEL_ID: "gpt-test" }),
  });
  assert.equal(catalog.version, "moa.voice-provider-catalog.v1");
  assert.equal(catalog.credentials_owner, "gateway");
  assert.equal(JSON.stringify(catalog).includes(secret), false);
  assert.equal(choice(catalog, "openai-realtime").status, "configured");
  assert.equal(choice(catalog, "xai-voice").status, "configured");
  const claude = choice(catalog, "cascaded-claude");
  assert.equal(claude.status, "unavailable");
  assert.equal(claude.available, false);
  assert.equal(Boolean(claude.capabilities.duplex_audio), false);
  assert.match(claude.limitation, /text reasoning stage only/i);
});

test("unavailable selection is rejected atomically and a configured choice produces one complete patch", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-provider-selection-"));
  const env = configuredEnv({ OPENAI_API_KEY: "configured", ANTHROPIC_API_KEY: "configured", MODEL_ID: "gpt-test" });
  const store = createAgentProfileStore({ dataDir, defaults: BASE_PROFILE,
    validateProviderSelection: (current, _candidate, patch) => validateProfileProviderPatch(current, patch, { env }) });
  try {
    const before = store.currentVersion();
    const beforeProfile = store.effective();
    assert.throws(() => {
      const rejected = resolveProviderSelection({ choice_id: "cascaded-claude" }, { env, profile: store.effective() });
      store.patch(rejected.patch);
    }, /unavailable/);
    assert.equal(store.currentVersion(), before);
    assert.deepEqual(store.effective(), beforeProfile);

    const accepted = resolveProviderSelection({ choice_id: "openai-realtime" }, { env, profile: store.effective() });
    store.patch(accepted.patch);
    assert.notEqual(store.currentVersion(), before);
    assert.equal(store.effective().voice_provider, "openai-realtime");
    assert.equal(store.effective().stt_provider, "openai-realtime");
    assert.equal(store.effective().reasoning_provider, "openai-realtime");
    assert.equal(store.effective().tts_provider, "openai-realtime");
    assert.equal(store.effective().model, "gpt-realtime-2.1");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("turn admission pins a provider bundle and immutable profile until the next admission", async () => {
  let profile = { ...BASE_PROFILE };
  let version = "profile_v0001";
  const constructed = [];
  const admission = createVoiceSessionAdmission({
    sanitizeId: (value) => value,
    agentProfile: { effective: () => ({ ...profile }), currentVersion: () => version },
    voiceProviderFactory: (pinned) => {
      constructed.push(pinned);
      return { status: () => ({ provider: pinned.voice_provider }) };
    },
  });
  const firstProfile = admission.effectiveProfile("");
  const first = await admission.admit({ effectiveProfile: firstProfile, profileVersion: version });
  profile = { ...profile, voice_provider: "openai-realtime", stt_provider: "openai-realtime",
    reasoning_provider: "openai-realtime", tts_provider: "openai-realtime" };
  version = "profile_v0002";
  const second = await admission.admit({ effectiveProfile: admission.effectiveProfile(""), profileVersion: version });
  assert.equal(first.effectiveProfile.voice_provider, "chirp");
  assert.equal(first.profileVersion, "profile_v0001");
  assert.equal(Object.isFrozen(first.effectiveProfile), true);
  assert.equal(second.effectiveProfile.voice_provider, "openai-realtime");
  assert.equal(second.profileVersion, "profile_v0002");
  assert.equal(constructed.length, 2);
});

test("profile selection maps only gateway-owned provider environment names", () => {
  const source = { OPENAI_API_KEY: "secret", VOICE_PROVIDER: "chirp" };
  const selected = voiceProviderEnvForProfile({ voice_provider: "xai-voice" }, source);
  assert.equal(selected.VOICE_PROVIDER, "xai-voice");
  assert.equal(selected.VOICE_STT_PROVIDER, "xai-voice");
  assert.equal(selected.OPENAI_API_KEY, "secret");
  const withModel = voiceProviderEnvForProfile({ voice_provider: "xai-voice", model: "grok-voice-custom" }, source);
  assert.equal(withModel.XAI_REALTIME_MODEL, "grok-voice-custom");
});

test("native profile keeps a configured cascaded switch-back choice", () => {
  const env = configuredEnv({ OPENAI_API_KEY: "configured", VOICE_TTS_PROVIDER: "gemini-tts" });
  const nativeProfile = {
    model: "gpt-realtime-2.1", voice_provider: "openai-realtime",
    stt_provider: "openai-realtime", reasoning_provider: "openai-realtime",
    tts_provider: "openai-realtime",
  };
  const catalog = createVoiceProviderCatalog({ env, profile: nativeProfile });
  const cascaded = choice(catalog, "cascaded-openai");
  assert.equal(catalog.selection_scope, "profile_effective");
  assert.equal(catalog.active_selection.scope, "profile_effective");
  assert.equal(cascaded.status, "configured");
  assert.equal(cascaded.stages.tts, "gemini-tts");
  const selected = resolveProviderSelection({ choice_id: cascaded.id }, { env, profile: nativeProfile });
  assert.equal(selected.patch.voice_provider, "chirp");
  assert.equal(selected.patch.tts_provider, "gemini-tts");
});

test("admission diagnostics distinguish boot defaults from device-effective selection", async () => {
  const profile = { ...BASE_PROFILE };
  const admission = createVoiceSessionAdmission({
    sanitizeId: (value) => value,
    agentProfile: { effective: () => profile, currentVersion: () => "device_profile_v0002" },
    voiceProviderFactory: () => ({ status: () => ({ provider: "chirp" }) }),
  });
  assert.equal(admission.status().provider_selection.scope, "boot_default");
  const admitted = await admission.admit({
    deviceId: "android_test", effectiveProfile: profile, profileVersion: "device_profile_v0002",
  });
  assert.deepEqual(admitted.providerSelection, {
    scope: "device_effective",
    device_id: "android_test",
    provider_bundle: "chirp|chirp|openai-compatible|gemini-tts|gpt-test",
  });
});

function configuredEnv(overrides = {}) {
  return {
    MODEL_PROVIDER: "openai-compatible", MODEL_BASE_URL: "https://api.openai.com/v1",
    CHIRP_PROJECT: "project", CHIRP_ACCESS_TOKEN: "configured", VOICE_TTS_PROVIDER: "gemini-tts",
    VERTEX_PROJECT: "project", VERTEX_ACCESS_TOKEN: "configured", ...overrides,
  };
}

function choice(catalog, id) { return catalog.choices.find((entry) => entry.id === id); }
