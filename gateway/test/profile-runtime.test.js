const assert = require("node:assert/strict");
const test = require("node:test");

const { createProfileRuntime, voiceProfileDiagnostics } = require("../lib/profile-runtime");

function fixture() {
  const profile = {
    system_prompt: "base persona",
    model: "model-a",
    assistant_name: "A.G.",
    input_languages: "en-US,am-ET",
    voice_provider: "cascaded",
  };
  const agentProfile = {
    effective: (options) => ({ ...profile, scope_seen: options.scope }),
    currentVersion: (options) => options?.deviceId ? "device-v1" : "global-v1",
    defaults: () => ({ ...profile }),
    isOverridden: (options) => Boolean(options?.deviceId),
    fields: () => Object.keys(profile),
  };
  const sent = [];
  const runtime = createProfileRuntime({
    agentProfile,
    activeCompanionPayload: () => ({ id: "pet-1" }),
    modelId: "model-a",
    modelProvider: "openai-compatible",
    modelOptions: () => "model-b,model-a",
    profileOptionsPayload: (extra) => extra,
    sendJson: (_response, status, payload) => sent.push({ status, payload }),
    truncate: (value, size) => String(value).slice(0, size),
  });
  return { runtime, sent };
}

test("profile scope parsing preserves device aliases and fails closed without an id", () => {
  const { runtime, sent } = fixture();
  assert.deepEqual(runtime.profileOptionsFromBody({ scope: "this_device", client: { device_id: "phone 1" } }), {
    scope: "device", requested_scope: "device", deviceId: "phone-1",
  });
  const missing = runtime.profileOptionsFromBody({ scope: "device" });
  assert.equal(runtime.requireDeviceScope({}, missing), false);
  assert.deepEqual(sent, [{ status: 400, payload: { error: "device_id is required for device-scoped profile changes" } }]);
});

test("profile payloads and model options preserve their legacy shape", () => {
  const { runtime } = fixture();
  const url = new URL("https://gateway.test/v1/agent/profile?scope=device&device_id=phone-1");
  const payload = runtime.agentProfilePayload({ application: { applies: "next_turn" } }, runtime.profileOptionsFromUrl(url));
  assert.equal(payload.scope, "device");
  assert.equal(payload.current_version, "device-v1");
  assert.equal(payload.global_version, "global-v1");
  assert.deepEqual(payload.active_companion, { id: "pet-1" });
  assert.deepEqual(runtime.gatewayProfileOptionsPayload().models, [
    { id: "model-a", label: "model-a", provider: "openai-compatible", current: true },
    { id: "model-b", label: "model-b", provider: "openai-compatible", current: false },
  ]);
});

test("voice diagnostics retain provider drift and language warnings", () => {
  const result = voiceProfileDiagnostics(
    { providers: { voice_provider: "cascaded" }, language: { input: "en-US" } },
    { provider: "gemini-live" },
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.warnings.map((warning) => warning.code), [
    "stored_runtime_provider_drift", "single_input_language_restriction",
  ]);
});
