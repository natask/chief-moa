"use strict";

// Settings a freshly installed `ag.companion` may restore from its account.
//
// Android sandboxing means the new package CANNOT read `ai.moa.assistant`'s
// app-private storage, so a clean install can only come back configured by
// re-fetching from the gateway. This module is that read: a bounded, secret-free
// projection of the account's agent profile, versioned so a client can tell
// whether it understands the shape it received.
//
// The list is deliberately narrower than the full profile. Routing, provider,
// trust, and prompt fields (model, temperature, *_provider, tool_policy,
// autonomy_level, memory_policy, recovery_mode, system_prompt) stay server-owned:
// the gateway already applies them per turn, and a device copy would only invite
// drift or make server state look like local authority. Nothing here is a
// credential; provider API keys never enter the agent profile.
const CONTINUITY_SETTINGS_SCHEMA_VERSION = 1;

const RESTORABLE_SETTINGS = Object.freeze([
  "assistant_name",
  "user_address",
  "user_name",
  "user_nickname",
  "voice",
  "speaking_rate",
  "voice_tone",
  "language",
  "language_mode",
  "language_primary",
  "language_output",
  "language_auto_switch",
  "input_languages",
  "input_language_primary",
  "response_modality",
  "active_companion_id",
  "active_companion_name",
  "active_companion_source",
  "active_companion_version",
]);

// Project the effective profile onto the restorable allowlist. Absent and
// undefined fields are omitted rather than sent as empty values, so a client
// never overwrites a good local value with a blank one.
function restorableSettings(profile) {
  const source = profile && typeof profile === "object" ? profile : {};
  const settings = {};
  for (const field of RESTORABLE_SETTINGS) {
    const value = source[field];
    if (value === undefined || value === null) continue;
    settings[field] = value;
  }
  return settings;
}

function continuitySettingsPayload({ profile, profileVersion, accountId, tenantId } = {}) {
  return {
    schema_version: 1,
    settings_schema_version: CONTINUITY_SETTINGS_SCHEMA_VERSION,
    account_id: String(accountId || ""),
    tenant_id: String(tenantId || ""),
    profile_version: String(profileVersion || ""),
    settings: restorableSettings(profile),
    restorable_fields: RESTORABLE_SETTINGS.slice(),
    // Restated on every restore read: the new package received account data it
    // authenticated for, never app-private state from another package.
    local_state_transferred: false,
  };
}

module.exports = {
  CONTINUITY_SETTINGS_SCHEMA_VERSION,
  RESTORABLE_SETTINGS,
  restorableSettings,
  continuitySettingsPayload,
};
