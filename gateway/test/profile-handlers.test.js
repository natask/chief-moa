"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createProfileHandlers } = require("../lib/profile-handlers");

function makeHarness(overrides = {}) {
  let version = 3;
  let value = { model: "old", language: "en-US" };
  const calls = [];
  const agentProfile = {
    effective: () => ({ ...value }), currentVersion: () => version,
    fields: () => ["model", "language"], defaults: () => ({ model: "default", language: "en-US" }),
    patch: (patch, meta) => { calls.push(["patch", patch, meta]); value = { ...value, ...patch }; version += 1; },
    reset: (meta) => { calls.push(["reset", meta]); value = { model: "default" }; version += 1; },
    rollback: (target, meta) => { calls.push(["rollback", target, meta]); value = { model: "rolled" }; version += 1; },
    versions: (options) => [{ version, options }],
    ...(overrides.agentProfile || {}),
  };
  const deps = {
    agentProfile, authorizedAgent: () => true, agentAuthError: () => ({ error: "unauthorized" }),
    readJsonBody: async (request) => request.body,
    sendJson: (response, status, payload) => Object.assign(response, { status, payload }),
    cleanError: (error) => error.message,
    profileOptionsFromUrl: (url) => ({ scope: url.searchParams.get("scope") || "global", deviceId: url.searchParams.get("device_id") || "" }),
    profileOptionsFromBody: (body, scope) => ({ scope: body?.scope || scope, deviceId: body?.device_id || "", requested_scope: body?.scope || scope }),
    requireDeviceScope: () => true,
    agentProfilePayload: (extra, options) => ({ profile: agentProfile.effective(options), ...extra, options }),
    readProfileHistory: (options) => ({ history: options }),
    recordProfileHistory: (...args) => calls.push(["history", ...args]),
    rejectedLanguageFields: (patch) => patch.language === "xx" ? ["language"] : [],
    supportedLanguagesSentence: () => "English or Amharic",
    profileApplicationSemantics: () => ({ applies: "next_turn" }),
    providerCatalog: ({ profile }) => ({ version: "catalog/v1", active: profile.model }),
    resolveProviderSelection: (body) => {
      if (body.choice_id === "blocked") {
        const error = new Error("choice is unavailable");
        error.name = "ProviderSelectionError"; error.code = "provider_selection_unavailable";
        error.statusCode = 409; error.details = { choice_id: "blocked", status: "unavailable" };
        throw error;
      }
      return { choice: { id: body.choice_id }, patch: { model: body.model_id || "selected" } };
    },
    settingsCatalog: {
      list: () => [{ id: "model" }, { id: "language" }],
      get: (id) => id === "model" ? { id: "model" } : null,
      search: (query) => query === "reasoning" ? [{ id: "model" }] : [],
      recommend: (query) => query === "speak" ? [{ id: "language", recommendation: "Use language." }] : [],
    },
    ...overrides, agentProfile,
  };
  return { ...createProfileHandlers(deps), calls };
}

async function route(harness, method, pathname, body, query = "") {
  const response = {};
  const handled = await harness.routeProfiles({ method, body }, response, new URL(`https://test${pathname}${query}`));
  return { handled, response };
}

test("profile, history, and version reads preserve bounded query adapters", async () => {
  const harness = makeHarness();
  const profile = await route(harness, "GET", "/v1/agent/profile", null, "?scope=device&device_id=dev");
  assert.equal(profile.response.payload.options.deviceId, "dev");
  const history = await route(harness, "GET", "/v1/agent/profile/history", null, "?limit=4&system_prompt_only=1");
  assert.deepEqual(history.response.payload.history, { limit: 4, systemPromptOnly: true });
  const historyDefaults = await route(harness, "GET", "/v1/agent/profile/history");
  assert.equal(historyDefaults.response.payload.history.limit, 50);
  assert.equal(historyDefaults.response.payload.history.systemPromptOnly, false);
  const versions = await route(harness, "GET", "/v1/agent/profile/versions", null, "?scope=device&device_id=dev&limit=2");
  assert.equal(versions.response.payload.scope, "device");
  assert.equal(versions.response.payload.versions[0].options.limit, 2);
  const defaults = await route(harness, "GET", "/v1/agent/profile/versions");
  assert.equal(defaults.response.payload.device_id, "");
  assert.equal(defaults.response.payload.versions[0].options.limit, 50);
});

test("put accepts bare and wrapped patches and records exact versions", async () => {
  for (const body of [{ model: "a", source: "voice" }, { profile: { model: "b" } }, { profile_overrides: { model: "c" } }, null]) {
    const harness = makeHarness();
    const result = await route(harness, "PUT", "/v1/agent/profile", body);
    assert.equal(result.response.status, 200);
    assert.equal(result.response.payload.application.applies, "next_turn");
    assert.equal(harness.calls.filter(([name]) => name === "history").length, 1);
  }
});

test("put reports rejected languages and enforces device scope", async () => {
  const rejected = await route(makeHarness(), "PUT", "/v1/agent/profile", { language: "xx" });
  assert.deepEqual(rejected.response.payload.language_rejection.fields, ["language"]);
  assert.match(rejected.response.payload.language_rejection.message, /English or Amharic/);
  const denied = makeHarness({ requireDeviceScope: (response) => { response.denied = true; return false; } });
  assert.equal((await route(denied, "PUT", "/v1/agent/profile", { scope: "device" })).response.denied, true);
});

test("put rejects unknown fields atomically instead of silently inventing settings", async () => {
  for (const body of [
    { imaginary: true },
    { profile: { model: "new", imaginary: true } },
    { profile_overrides: { made_up: "value" } },
  ]) {
    const harness = makeHarness();
    const result = await route(harness, "PUT", "/v1/agent/profile", body);
    assert.equal(result.response.status, 400);
    assert.equal(result.response.payload.error, "unknown_profile_fields");
    assert.equal(harness.calls.some(([name]) => name === "patch"), false);
  }
  const metadata = await route(makeHarness(), "PUT", "/v1/agent/profile", { model: "new", source: "voice", scope: "global" });
  assert.equal(metadata.response.status, 200);
});

test("put reports provider validation failures without recording profile history", async () => {
  const error = new Error("provider is unavailable");
  error.name = "ProviderSelectionError"; error.code = "provider_selection_unavailable";
  error.statusCode = 409; error.details = { choice_id: "cascaded-claude" };
  const harness = makeHarness({ agentProfile: { patch: () => { throw error; } } });
  const result = await route(harness, "PUT", "/v1/agent/profile", { model: "claude" });
  assert.equal(result.response.status, 409);
  assert.equal(result.response.payload.choice_id, "cascaded-claude");
  assert.equal(harness.calls.some(([name]) => name === "history"), false);
});

test("provider catalog and atomic selection expose configured choices and preserve profile on rejection", async () => {
  const harness = makeHarness();
  const catalog = await route(harness, "GET", "/v1/agent/provider-catalog");
  assert.equal(catalog.response.payload.version, "catalog/v1");
  assert.equal(catalog.response.payload.active, "old");
  const selected = await route(harness, "PUT", "/v1/agent/provider-selection",
    { choice_id: "openai-realtime", model_id: "realtime-model" });
  assert.equal(selected.response.status, 200);
  assert.equal(selected.response.payload.profile.model, "realtime-model");
  assert.equal(selected.response.payload.selection.id, "openai-realtime");
  const beforeCalls = harness.calls.length;
  const rejected = await route(harness, "PUT", "/v1/agent/provider-selection", { choice_id: "blocked" });
  assert.equal(rejected.response.status, 409);
  assert.equal(rejected.response.payload.error, "provider_selection_unavailable");
  assert.equal(harness.calls.length, beforeCalls);
});

test("settings catalog routes list, get, search, and recommend canonical settings", async () => {
  const harness = makeHarness();
  const listed = await route(harness, "GET", "/v1/agent/settings");
  assert.equal(listed.response.payload.count, 2);
  const found = await route(harness, "GET", "/v1/agent/settings", null, "?q=reasoning");
  assert.deepEqual(found.response.payload.settings, [{ id: "model" }]);
  const exact = await route(harness, "GET", "/v1/agent/settings/model");
  assert.equal(exact.response.payload.id, "model");
  const missing = await route(harness, "GET", "/v1/agent/settings/imaginary");
  assert.equal(missing.response.status, 404);
  assert.equal(missing.response.payload.error, "unknown_setting");
  const recommendations = await route(harness, "GET", "/v1/agent/settings/recommend", null, "?q=speak");
  assert.equal(recommendations.response.payload.settings[0].id, "language");
});

test("reset records before and after versions with source defaults", async () => {
  for (const body of [{ source: "settings" }, {}]) {
    const harness = makeHarness();
    const result = await route(harness, "POST", "/v1/agent/profile/reset", body);
    assert.equal(result.response.payload.profile.model, "default");
    assert.equal(harness.calls[0][0], "reset");
    assert.equal(harness.calls[1][0], "history");
  }
  const denied = makeHarness({ requireDeviceScope: () => false });
  assert.equal((await route(denied, "POST", "/v1/agent/profile/reset", {})).response.status, undefined);
});

test("rollback accepts every version alias and returns bounded missing errors", async () => {
  for (const body of [{ version: 1 }, { profile_version: 2 }, { rollback_to_version: 3 }, {}]) {
    const harness = makeHarness();
    const result = await route(harness, "POST", "/v1/agent/profile/rollback", body);
    assert.equal(result.response.status, 200);
    assert.equal(harness.calls[0][1], body.version || body.profile_version || body.rollback_to_version);
  }
  const broken = makeHarness({ agentProfile: { rollback: () => { throw new Error("version missing"); } } });
  assert.deepEqual((await route(broken, "POST", "/v1/agent/profile/rollback", {})).response,
    { status: 404, payload: { error: "version missing" } });
});

test("all profile routes authorize and unrelated combinations fall through", async () => {
  const denied = makeHarness({ authorizedAgent: () => false });
  for (const [method, path] of [["GET", "/v1/agent/profile"], ["PUT", "/v1/agent/profile"],
    ["GET", "/v1/agent/provider-catalog"], ["PUT", "/v1/agent/provider-selection"],
    ["GET", "/v1/agent/profile/history"], ["GET", "/v1/agent/profile/versions"],
    ["GET", "/v1/agent/settings"], ["GET", "/v1/agent/settings/model"],
    ["POST", "/v1/agent/profile/reset"], ["POST", "/v1/agent/profile/rollback"]]) {
    const result = await route(denied, method, path, {}); assert.equal(result.handled, true); assert.equal(result.response.status, 401);
  }
  const harness = makeHarness();
  assert.equal((await route(harness, "DELETE", "/v1/agent/profile", {})).handled, false);
  assert.equal((await route(harness, "POST", "/v1/agent/profile/history", {})).handled, false);
  assert.equal((await route(harness, "GET", "/v1/agent/other", {})).handled, false);
});
