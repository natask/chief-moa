import assert from "node:assert/strict";
import test from "node:test";
import {
  browserSettings,
  mergeSettingsResults,
  normalizeGatewaySetting,
  parseBrowserSettingWriteIntent,
  parseSettingsQueryIntent,
  readBrowserSettings,
  validateBrowserSettingWrite,
} from "../extension/browser-settings-registry.js";

const state = {
  gatewayUrl: "https://api.agee.app",
  gatewayTokenConfigured: true,
  livekitVoiceEnabled: false,
  backgroundAutomationEnabled: true,
  backgroundAutomationConsentCurrent: false,
  microphonePermission: "denied",
  agentRole: "help",
};

test("catalog lists every existing browser-local control without semantic truncation", () => {
  const result = readBrowserSettings({ operation: "list" }, state);
  assert.equal(result.ok, true);
  assert.deepEqual(result.settings.map(({ id }) => id), [
    "browser.gateway_url",
    "browser.gateway_token",
    "browser.livekit_voice",
    "browser.background_automation",
    "browser.microphone_permission",
    "browser.agent_role",
  ]);
  assert.ok(result.settings.every((setting) => setting.owner === "browser_extension"));
});

test("All keeps every local and gateway identity while semantic search stays bounded", () => {
  const local = browserSettings(state);
  const gateway = Array.from({ length: 31 }, (_, index) => ({ id: `gateway.setting_${index}` }));
  const all = mergeSettingsResults(local, gateway, { operation: "list", limit: 20 });
  assert.equal(all.length, 37);
  assert.equal(new Set(all.map(({ id }) => id)).size, 37);
  assert.equal(all.at(-1).id, "gateway.setting_30");
  assert.equal(mergeSettingsResults(local, gateway, { operation: "search", limit: 20 }).length, 20);
});

test("spoken list/search/get/recommend intents use the same canonical query contract", () => {
  assert.deepEqual(parseSettingsQueryIntent("Tell me all the settings"), { operation: "list", query: "" });
  assert.deepEqual(parseSettingsQueryIntent("Get setting browser.agent_role"), {
    operation: "get", id: "browser.agent_role", query: "",
  });
  assert.deepEqual(parseSettingsQueryIntent("Which settings are useful for private voice?"), {
    operation: "recommend", query: "private voice",
  });
  assert.deepEqual(parseSettingsQueryIntent("Find settings related to microphone access"), {
    operation: "search", query: "microphone access",
  });
  assert.equal(parseSettingsQueryIntent("Enable LiveKit voice"), null);
});

test("registered local writes validate atomically and microphone stays user-action-only", () => {
  assert.deepEqual(parseBrowserSettingWriteIntent("set browser agent role to explain"), {
    id: "browser.agent_role", value: "explain",
  });
  assert.equal(validateBrowserSettingWrite({ id: "browser.unknown", value: true }).error, "unknown_setting");
  assert.equal(validateBrowserSettingWrite({ id: "browser.microphone_permission", value: "granted" }).error, "setting_not_writable");
  assert.equal(validateBrowserSettingWrite({ id: "browser.livekit_voice", value: "yes" }).error, "invalid_setting_value");
  assert.equal(validateBrowserSettingWrite({ id: "browser.background_automation", value: true }).error, "explicit_versioned_approval_required");
  assert.equal(validateBrowserSettingWrite({
    id: "browser.background_automation",
    value: true,
    approval: { approved: true, setting_id: "browser.background_automation", consent_version: 1 },
  }).ok, true);
});

test("tokens expose configured state but never a secret value", () => {
  const settings = browserSettings({ ...state, gatewayToken: "must-never-appear" });
  const token = settings.find(({ id }) => id === "browser.gateway_token");
  assert.equal(token.current, "configured (value redacted)");
  assert.equal(token.redaction, "configured state only");
  assert.doesNotMatch(JSON.stringify(settings), /must-never-appear/);
});

test("background automation is effective only with current consent", () => {
  const stale = readBrowserSettings({ operation: "get", id: "browser.background_automation" }, state);
  assert.equal(stale.setting.current, false);
  const current = readBrowserSettings(
    { operation: "get", id: "browser.background_automation" },
    { ...state, backgroundAutomationConsentCurrent: true },
  );
  assert.equal(current.setting.current, true);
  assert.equal(current.setting.mutability, "explicit user consent only");
});

test("search and recommendations return grounded entries without mutation", () => {
  const mic = readBrowserSettings({ operation: "search", query: "why can voice not hear my mic" }, state);
  assert.equal(mic.settings[0].id, "browser.microphone_permission");
  assert.equal(mic.settings[0].current, "denied");
  assert.deepEqual(mic.settings[0].deep_link, {
    target: "microphone_permission",
    label: "Open microphone setup",
  });
  const voice = readBrowserSettings({ operation: "recommend", query: "test experimental voice transport" }, state);
  assert.equal(voice.settings[0].id, "browser.livekit_voice");
  assert.match(voice.settings[0].recommendation, /experimental browser voice/);
  assert.equal(readBrowserSettings({ operation: "get", id: "browser.not_real" }, state).error, "unknown_setting");
  assert.equal(readBrowserSettings({ operation: "write" }, state).error, "unknown_settings_operation");
});

test("gateway records normalize to the shared read-only projection", () => {
  const setting = normalizeGatewaySetting({
    id: "provider_key",
    title: "Provider key",
    category: "model",
    scope: "global",
    value: true,
    default_value: false,
    redacted: true,
    minimum: 1,
    maximum: 10,
  });
  assert.equal(setting.id, "gateway.provider_key");
  assert.equal(setting.owner, "gateway");
  assert.equal(setting.current, "configured (value redacted)");
  assert.equal(setting.default, "not configured");
  assert.deepEqual(setting.constraints, ["Minimum: 1", "Maximum: 10"]);
});
