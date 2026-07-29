"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  CONTINUITY_SETTINGS_SCHEMA_VERSION,
  RESTORABLE_SETTINGS,
  continuitySettingsPayload,
  restorableSettings,
} = require("../lib/continuity-settings");

const profile = {
  assistant_name: "Ag",
  user_address: "master",
  voice: "Aoede",
  speaking_rate: 1.5,
  language: "en-US,am-ET",
  language_auto_switch: false,
  response_modality: "auto",
  // Server-owned fields that must never reach the device projection.
  system_prompt: "long server-owned prompt",
  model: "gemini-3.1-flash",
  temperature: 0.4,
  tts_provider: "gemini-tts",
  tool_policy: "approve",
  autonomy_level: "assist",
};

test("restorable settings carry user settings and withhold server-owned routing and prompt", () => {
  const settings = restorableSettings(profile);
  assert.equal(settings.assistant_name, "Ag");
  assert.equal(settings.user_address, "master");
  assert.equal(settings.speaking_rate, 1.5);
  assert.equal(settings.language_auto_switch, false);
  for (const withheld of ["system_prompt", "model", "temperature", "tts_provider", "tool_policy", "autonomy_level"]) {
    assert.equal(Object.prototype.hasOwnProperty.call(settings, withheld), false, withheld);
  }
  for (const field of Object.keys(settings)) {
    assert.ok(RESTORABLE_SETTINGS.includes(field), field);
  }
});

test("absent fields are omitted so a restore never blanks a good local value", () => {
  const settings = restorableSettings({ voice: "Kore", assistant_name: undefined, user_name: null });
  assert.deepEqual(Object.keys(settings), ["voice"]);
  assert.deepEqual(restorableSettings(null), {});
});

test("payload is versioned, account-scoped, and repeats the no-local-transfer claim", () => {
  const payload = continuitySettingsPayload({
    profile, profileVersion: "prof_7", accountId: "owner_1", tenantId: "personal_tenant",
  });
  assert.equal(payload.schema_version, 1);
  assert.equal(payload.settings_schema_version, CONTINUITY_SETTINGS_SCHEMA_VERSION);
  assert.equal(payload.account_id, "owner_1");
  assert.equal(payload.tenant_id, "personal_tenant");
  assert.equal(payload.profile_version, "prof_7");
  assert.equal(payload.local_state_transferred, false);
  assert.deepEqual(payload.restorable_fields, RESTORABLE_SETTINGS.slice());
  assert.equal(JSON.stringify(payload).includes("long server-owned prompt"), false);
});
