"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { PROFILE_FIELDS } = require("../lib/agent-profile");
const { createProfileSettingsCatalog, publicValue, secretLike } = require("../lib/profile-settings-catalog");
const { createProfileSettingsReader, readAgentSettingsTool, readAgentSettingsGeminiDeclaration, requestedOperation } = require("../lib/profile-settings-reader");

function catalogHarness() {
  const defaults = Object.fromEntries(PROFILE_FIELDS.map((field) => [field, null]));
  defaults.voice = "Kore";
  defaults.voice_max_chars = 280;
  defaults.system_prompt = "default instructions";
  const effective = { ...defaults, voice_max_chars: 140, assistant_name: "Aggie" };
  const agentProfile = {
    effective: (options) => ({ ...effective, scope_seen: options.scope }),
    defaults: () => ({ ...defaults }),
    currentVersion: () => "profile_7",
  };
  const catalog = createProfileSettingsCatalog({
    agentProfile,
    optionsPayload: () => ({
      fields: { response_modality: { type: "enum", values: ["auto", "speech", "text"] } },
      voices: [{ id: "Kore" }, { id: "Aoede" }],
      languages: [{ code: "en-US" }, { code: "am-ET" }],
    }),
  });
  return { catalog, agentProfile };
}

test("catalog describes every canonical profile field exactly once", () => {
  const { catalog } = catalogHarness();
  const settings = catalog.list({ scope: "global" });
  assert.deepEqual(settings.map((setting) => setting.id), PROFILE_FIELDS);
  assert.equal(settings.length, PROFILE_FIELDS.length);
  assert.ok(settings.every((setting) => setting.readable === true));
  assert.equal(catalog.get("made_up_setting"), null);
});

test("catalog exposes current/default state, constraints, and managed fields", () => {
  const { catalog } = catalogHarness();
  const terse = catalog.get("voice_max_chars");
  assert.equal(terse.value, 140);
  assert.equal(terse.default_value, 280);
  assert.equal(terse.overridden, true);
  assert.equal(terse.type, "integer");
  assert.equal(catalog.get("voice").values.includes("Aoede"), true);
  assert.deepEqual(catalog.get("response_modality").values, ["auto", "speech", "text"]);
  assert.equal(catalog.get("active_companion_id").writable, true);
  assert.equal(catalog.get("active_companion_id").managed, true);
  assert.equal(catalog.get("system_prompt").sensitivity, "private");
  assert.equal(catalog.get("system_prompt").value, "default instructions");
});

test("search and recommendations are deterministic and catalog-grounded", () => {
  const { catalog } = catalogHarness();
  const concise = catalog.search("concise spoken answers");
  assert.equal(concise[0].id, "voice_max_chars");
  assert.match(concise[0].match.reason, /alias|title|description/);
  const recognition = catalog.search("speech recognition listens for");
  assert.equal(recognition[0].id, "input_languages");
  const recommended = catalog.recommend("I want text only replies", { limit: 3 });
  assert.equal(recommended[0].id, "response_modality");
  assert.ok(recommended.every((setting) => PROFILE_FIELDS.includes(setting.id)));
  assert.ok(recommended.every((setting) => setting.recommendation));
});

test("secret-shaped values are always redacted by the shared projector", () => {
  assert.equal(secretLike("gateway_token"), true);
  assert.equal(secretLike("assistant_name"), false);
  assert.equal(publicValue("gateway_token", "do-not-print"), "[redacted]");
  assert.equal(publicValue("gateway_token", ""), "");
});

test("agent reader supports list/get/search/recommend without inventing settings", () => {
  const { catalog } = catalogHarness();
  const read = createProfileSettingsReader(catalog);
  assert.equal(read({ operation: "list" }).count, PROFILE_FIELDS.length);
  assert.equal(read({ operation: "get", id: "voice" }).setting.id, "voice");
  assert.equal(read({ operation: "get", id: "imaginary" }).error, "unknown_setting");
  assert.equal(read({ operation: "search", query: "voice speed" }).settings[0].id, "speaking_rate");
  assert.equal(read({ operation: "recommend", query: "more concise" }).settings[0].id, "voice_max_chars");
  assert.equal(read({ operation: "search" }).error, "settings_query_required");
  assert.equal(read({ operation: "invent" }).error, "unknown_settings_operation");
  assert.equal(read({ operation: "list", scope: "device" }).error, "device_id_required_for_device_scope");
  assert.equal(requestedOperation({ id: "voice" }), "get");
  assert.equal(requestedOperation({ query: "voice" }), "search");
  assert.equal(requestedOperation({}), "list");
  const classic = readAgentSettingsTool(() => ({}));
  assert.equal(classic.name, "read_agent_settings");
  assert.deepEqual(classic.parameters.properties.operation.enum, ["list", "get", "search", "recommend"]);
  assert.equal(readAgentSettingsGeminiDeclaration().name, "read_agent_settings");
});
