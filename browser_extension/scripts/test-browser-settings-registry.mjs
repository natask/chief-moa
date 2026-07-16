import assert from "node:assert/strict";
import test from "node:test";
import {
  browserSettings,
  normalizeGatewaySetting,
  readBrowserSettings,
} from "../extension/browser-settings-registry.js";

const state = {
  gatewayUrl: "https://api.agee.app",
  gatewayTokenConfigured: true,
  livekitVoiceEnabled: false,
  backgroundAutomationEnabled: true,
  backgroundAutomationConsentCurrent: false,
  microphonePermission: "denied",
};

test("catalog lists only the five existing browser-local controls", () => {
  const result = readBrowserSettings({ operation: "list" }, state);
  assert.equal(result.ok, true);
  assert.deepEqual(result.settings.map(({ id }) => id), [
    "browser.gateway_url",
    "browser.gateway_token",
    "browser.livekit_voice",
    "browser.background_automation",
    "browser.microphone_permission",
  ]);
  assert.ok(result.settings.every((setting) => setting.owner === "browser_extension"));
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
