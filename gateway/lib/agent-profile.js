"use strict";

// Runtime-editable, versioned agent profile layered over gateway defaults.
//
// Effective profile = current profile version. Each persisted edit appends a
// version instead of mutating prior turn history, so voice/chat turns and agent
// runs can record the exact profile version they used.

const fs = require("node:fs");
const path = require("node:path");
const {
  CORE_VOICES,
  normalizeLanguageCode,
  normalizeLanguageList,
  normalizeVoiceChoice,
} = require("./profile-options");

const PROFILE_FILENAME = "agent-profile.json";
const PROFILE_VERSIONS_FILENAME = "agent-profile-versions.json";
const DEVICE_OVERRIDES_FILENAME = "agent-profile-device-overrides.json";
const LEGACY_VOICE_STYLE_RULE = "Voice style requirement: speak tersely. Honor the user's requested form of address, title, or roleplay style when provided. Keep replies short enough for voice.";
const REQUIRED_VOICE_STYLE_RULE = "Voice mode: this reply will be heard. Lead with the answer. Start with a complete, natural clause of at most 12 words. Use one or two short spoken sentences unless the user asks for detail. Skip preambles, headings, markdown, repeated context, and long parentheticals. Do not read raw URLs aloud. Speak tersely. Honor the user's requested form of address, title, or roleplay style when provided.";
const DEFAULT_SPEAKER_CONTEXT = "The speaker frequently discusses software engineering, authentication, APIs and protocols, speech systems, cloud infrastructure, and mathematics. Bias recognition toward technical terminology and technical senses of ambiguous words.";
// Only these fields may be patched/persisted/overridden; anything else is ignored.
const PROFILE_FIELDS = [
  "system_prompt",
  "assistant_name",
  "user_address",
  "user_name",
  "user_nickname",
  "model",
  "temperature",
  "voice_max_chars",
  "language",
  "voice",
  "speaking_rate",
  "voice_tone",
  "language_mode",
  "language_primary",
  "language_output",
  "language_auto_switch",
  "input_languages",
  "input_language_primary",
  "speaker_context",
  "response_modality",
  "voice_provider",
  "stt_provider",
  "reasoning_provider",
  "tts_provider",
  "tool_policy",
  "autonomy_level",
  "memory_policy",
  "recovery_mode",
  "active_companion_id",
  "active_companion_name",
  "active_companion_source",
  "active_companion_version",
];

// Canonicalize a requested voice to its proper-case core-voice name, including
// approved tone aliases such as feminine/masculine. Null means "reject".
function normalizeVoice(value) {
  return normalizeVoiceChoice(value);
}

function createAgentProfileStore(options) {
  const dataDir = path.resolve(options?.dataDir || "./data");
  const profilePath = path.join(dataDir, PROFILE_FILENAME);
  const versionsPath = path.join(dataDir, PROFILE_VERSIONS_FILENAME);
  const deviceOverridesPath = path.join(dataDir, DEVICE_OVERRIDES_FILENAME);
  // The env default is computed once at boot; it is the immutable baseline.
  const defaults = freeze(normalizeProfile(options?.defaults || {}));

  fs.mkdirSync(dataDir, { recursive: true });

  let state = loadVersionState({ profilePath, versionsPath, defaults });
  let deviceState = loadDeviceOverrideState(deviceOverridesPath);

  function effective(options = {}) {
    const profile = { ...currentVersionRecord().profile };
    const deviceId = normalizeDeviceId(options?.deviceId || options?.device_id);
    if (!deviceId) {
      return profile;
    }
    const patch = currentDevicePatch(deviceId);
    return Object.keys(patch).length > 0 ? mergeProfile(profile, patch) : profile;
  }

  function isOverridden(options = {}) {
    return !profilesEqual(effective(options), defaults);
  }

  // Merge a per-request override onto the effective profile WITHOUT persisting.
  function effectiveWithOverrides(overrides, options = {}) {
    const base = effective(options);
    const patch = pickProfileFields(overrides);
    return Object.keys(patch).length > 0 ? mergeProfile(base, patch) : base;
  }

  // Patch + persist as a new version; returns the new effective profile. Applied
  // to later turns with no restart because callers read effective() per request.
  function patch(updates, metadata = {}) {
    const next = guardSpokenIdentityFields(pickProfileFields(updates), metadata.source);
    if (Object.keys(next).length === 0) {
      return effective(metadata);
    }
    const deviceId = normalizeDeviceId(metadata.deviceId || metadata.device_id);
    if (metadata.scope === "device" && deviceId) {
      return patchDevice(deviceId, next, metadata);
    }
    const before = currentVersionRecord();
    const profile = mergeProfile(before.profile, next);
    if (profilesEqual(before.profile, profile)) {
      return effective();
    }
    appendVersion(profile, {
      source: metadata.source || "api",
      reason: metadata.reason || "patch",
      parent_version: before.version,
      changed: changedFields(before.profile, profile),
    });
    return effective();
  }

  // Return to the env default by appending a new version.
  function reset(metadata = {}) {
    const deviceId = normalizeDeviceId(metadata.deviceId || metadata.device_id);
    if (metadata.scope === "device" && deviceId) {
      return resetDevice(deviceId, metadata);
    }
    const before = currentVersionRecord();
    if (!profilesEqual(before.profile, defaults)) {
      appendVersion(defaults, {
        source: metadata.source || "api",
        reason: metadata.reason || "reset",
        parent_version: before.version,
        changed: changedFields(before.profile, defaults),
      });
    }
    return effective();
  }

  function rollback(version, metadata = {}) {
    const target = findVersion(version);
    if (!target) {
      throw new Error(`profile version not found: ${version}`);
    }
    const before = currentVersionRecord();
    appendVersion(target.profile, {
      source: metadata.source || "api",
      reason: metadata.reason || "rollback",
      parent_version: before.version,
      rollback_from_version: target.version,
      changed: changedFields(before.profile, target.profile),
    });
    return effective();
  }

  // Undo the last change by re-applying the immediately prior version as a new
  // version (history stays append-only, so the undo is itself undoable). Global
  // scope walks the global version stack; device scope walks that device's patch
  // stack. Returns a descriptor of what happened so callers can speak it, and
  // never leaves a broken profile: with no prior state it reports no_previous.
  function revertLast(metadata = {}) {
    const deviceId = normalizeDeviceId(metadata.deviceId || metadata.device_id);
    if (metadata.scope === "device" && deviceId) {
      return revertLastDevice(deviceId, metadata);
    }
    const before = currentVersionRecord();
    const previous = previousGlobalVersion(before);
    if (!previous) {
      return { ok: false, reason: "no_previous", scope: "global", profile: effective(), from_version: before.version, to_version: before.version };
    }
    if (profilesEqual(before.profile, previous.profile)) {
      return { ok: false, reason: "already_at_previous", scope: "global", profile: effective(), from_version: before.version, to_version: previous.version };
    }
    const entry = appendVersion(previous.profile, {
      source: metadata.source || "api",
      reason: metadata.reason || "revert_last",
      parent_version: before.version,
      rollback_from_version: previous.version,
      changed: changedFields(before.profile, previous.profile),
    });
    return {
      ok: true,
      scope: "global",
      reverted_to_version: previous.version,
      from_version: before.version,
      to_version: entry.version,
      changed: entry.changed,
      profile: effective(),
    };
  }

  // The version whose profile we should restore when undoing the last change:
  // the current record's parent when present, else the second-most-recent entry.
  function previousGlobalVersion(currentRecord) {
    const parent = currentRecord?.parent_version ? findVersion(currentRecord.parent_version) : null;
    if (parent) {
      return parent;
    }
    if (state.versions.length >= 2) {
      return state.versions[state.versions.length - 2];
    }
    return null;
  }

  function revertLastDevice(deviceId, metadata) {
    const id = normalizeDeviceId(deviceId);
    const entry = deviceState.devices[id];
    const versions = Array.isArray(entry?.versions) ? entry.versions : [];
    if (versions.length === 0) {
      return { ok: false, reason: "no_previous", scope: "device", device_id: id, profile: effective({ deviceId: id }) };
    }
    const beforePatch = currentDevicePatch(id);
    // The patch to restore is the one before the current device version (or the
    // empty patch when only one device version exists, i.e. back to the global
    // effective profile for this device).
    const priorPatch = versions.length >= 2 ? { ...(versions[versions.length - 2].patch || {}) } : {};
    if (patchesEqual(beforePatch, priorPatch)) {
      return { ok: false, reason: "already_at_previous", scope: "device", device_id: id, profile: effective({ deviceId: id }) };
    }
    const versionEntry = appendDeviceVersion(id, priorPatch, {
      source: metadata.source || "api",
      reason: metadata.reason || "device_revert_last",
      parent_version: entry.current_version || "",
      changed: changedPatchFields(beforePatch, priorPatch),
    });
    return {
      ok: true,
      scope: "device",
      device_id: id,
      to_version: versionEntry.version,
      changed: versionEntry.changed,
      profile: effective({ deviceId: id }),
    };
  }

  function currentVersion(options = {}) {
    const globalVersion = currentVersionRecord().version;
    const deviceId = normalizeDeviceId(options?.deviceId || options?.device_id);
    if (!deviceId) {
      return globalVersion;
    }
    const deviceVersion = currentDeviceVersion(deviceId);
    return deviceVersion ? `${globalVersion}_${deviceVersion}` : globalVersion;
  }

  function listVersions(options = {}) {
    const deviceId = normalizeDeviceId(options.deviceId || options.device_id);
    if (deviceId) {
      return listDeviceVersions(deviceId, options);
    }
    const limit = Math.max(1, Math.min(Number(options.limit || state.versions.length) || state.versions.length, 500));
    const records = state.versions.slice().reverse().slice(0, limit);
    return records.map(publicVersionRecord);
  }

  function currentVersionRecord() {
    return findVersion(state.current_version) || state.versions[state.versions.length - 1];
  }

  function findVersion(version) {
    const requested = String(version || "").trim();
    if (!requested) {
      return null;
    }
    return state.versions.find((entry) => entry.version === requested) || null;
  }

  function appendVersion(profile, metadata) {
    const now = new Date().toISOString();
    const sequence = nextSequence(state.versions);
    const entry = {
      version: versionId(sequence),
      sequence,
      created_at: now,
      source: cleanSource(metadata?.source),
      reason: String(metadata?.reason || "patch").slice(0, 80),
      parent_version: metadata?.parent_version || state.current_version || "",
      rollback_from_version: metadata?.rollback_from_version || "",
      changed: Array.isArray(metadata?.changed) ? metadata.changed : [],
      profile: normalizeProfile(profile),
    };
    state.versions.push(entry);
    state.current_version = entry.version;
    persistState({ versionsPath, profilePath, state, defaults });
    return entry;
  }

  function patchDevice(deviceId, next, metadata) {
    const entry = ensureDeviceEntry(deviceId);
    const beforePatch = currentDevicePatch(deviceId);
    const patch = mergePatch(beforePatch, next);
    if (patchesEqual(beforePatch, patch)) {
      return effective({ deviceId });
    }
    appendDeviceVersion(deviceId, patch, {
      source: metadata.source || "api",
      reason: metadata.reason || "device_patch",
      parent_version: entry.current_version || "",
      changed: changedPatchFields(beforePatch, patch),
    });
    return effective({ deviceId });
  }

  function resetDevice(deviceId, metadata) {
    const beforePatch = currentDevicePatch(deviceId);
    if (Object.keys(beforePatch).length === 0) {
      return effective({ deviceId });
    }
    const entry = ensureDeviceEntry(deviceId);
    appendDeviceVersion(deviceId, {}, {
      source: metadata.source || "api",
      reason: metadata.reason || "device_reset",
      parent_version: entry.current_version || "",
      changed: changedPatchFields(beforePatch, {}),
    });
    return effective({ deviceId });
  }

  function ensureDeviceEntry(deviceId) {
    const id = normalizeDeviceId(deviceId);
    if (!id) {
      throw new Error("device id is required");
    }
    deviceState.devices[id] = deviceState.devices[id] || { current_version: "", versions: [] };
    return deviceState.devices[id];
  }

  function currentDeviceRecord(deviceId) {
    const id = normalizeDeviceId(deviceId);
    const entry = id ? deviceState.devices[id] : null;
    if (!entry || !Array.isArray(entry.versions) || entry.versions.length === 0) {
      return null;
    }
    return entry.versions.find((version) => version.version === entry.current_version) || entry.versions[entry.versions.length - 1];
  }

  function currentDevicePatch(deviceId) {
    return { ...(currentDeviceRecord(deviceId)?.patch || {}) };
  }

  function currentDeviceVersion(deviceId) {
    return currentDeviceRecord(deviceId)?.version || "";
  }

  function appendDeviceVersion(deviceId, patch, metadata) {
    const id = normalizeDeviceId(deviceId);
    const entry = ensureDeviceEntry(id);
    const now = new Date().toISOString();
    const sequence = nextSequence(entry.versions);
    const versionEntry = {
      version: deviceVersionId(sequence),
      sequence,
      created_at: now,
      source: cleanSource(metadata?.source),
      reason: String(metadata?.reason || "device_patch").slice(0, 80),
      parent_version: metadata?.parent_version || entry.current_version || "",
      changed: Array.isArray(metadata?.changed) ? metadata.changed : [],
      patch: pickProfileFields(patch),
    };
    entry.versions.push(versionEntry);
    entry.current_version = versionEntry.version;
    persistDeviceOverrideState(deviceOverridesPath, deviceState);
    return versionEntry;
  }

  function listDeviceVersions(deviceId, options = {}) {
    const entry = deviceState.devices[normalizeDeviceId(deviceId)];
    const versions = Array.isArray(entry?.versions) ? entry.versions : [];
    const limit = Math.max(1, Math.min(Number(options.limit || versions.length) || versions.length || 1, 500));
    return versions.slice().reverse().slice(0, limit).map((version) => ({
      version: version.version,
      sequence: version.sequence,
      created_at: version.created_at,
      source: version.source,
      reason: version.reason,
      parent_version: version.parent_version,
      changed: version.changed,
      patch: { ...(version.patch || {}) },
      profile: mergeProfile(currentVersionRecord().profile, version.patch || {}),
    }));
  }

  return {
    profilePath,
    versionsPath,
    deviceOverridesPath,
    defaults: () => ({ ...defaults }),
    effective,
    effectiveWithOverrides,
    isOverridden,
    patch,
    reset,
    rollback,
    revertLast,
    currentVersion,
    versions: listVersions,
    fields: () => PROFILE_FIELDS.slice(),
    normalizeDeviceId,
  };
}

function loadVersionState({ profilePath, versionsPath, defaults }) {
  const loaded = loadVersionsFile(versionsPath, defaults);
  if (loaded) {
    return loaded;
  }

  const now = new Date().toISOString();
  const versions = [{
    version: versionId(1),
    sequence: 1,
    created_at: now,
    source: "env_default",
    reason: "default",
    parent_version: "",
    rollback_from_version: "",
    changed: PROFILE_FIELDS.slice(),
    profile: normalizeProfile(defaults),
  }];
  const legacy = loadLegacyPersisted(profilePath);
  if (legacy && Object.keys(legacy).length > 0) {
    const profile = mergeProfile(defaults, legacy);
    if (!profilesEqual(profile, defaults)) {
      versions.push({
        version: versionId(2),
        sequence: 2,
        created_at: now,
        source: "legacy_profile",
        reason: "migration",
        parent_version: versionId(1),
        rollback_from_version: "",
        changed: changedFields(defaults, profile),
        profile,
      });
    }
  }

  return {
    current_version: versions[versions.length - 1].version,
    versions,
  };
}

function loadVersionsFile(versionsPath, defaults) {
  if (!fs.existsSync(versionsPath)) {
    return null;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(versionsPath, "utf8"));
    const incoming = Array.isArray(raw?.versions) ? raw.versions : [];
    const versions = incoming.map((entry, index) => {
      const sequence = Number(entry.sequence || index + 1);
      return {
        version: String(entry.version || versionId(sequence)),
        sequence,
        created_at: typeof entry.created_at === "string" ? entry.created_at : new Date().toISOString(),
        source: cleanSource(entry.source),
        reason: String(entry.reason || "loaded").slice(0, 80),
        parent_version: String(entry.parent_version || ""),
        rollback_from_version: String(entry.rollback_from_version || ""),
        changed: Array.isArray(entry.changed) ? entry.changed.filter((field) => PROFILE_FIELDS.includes(field)) : [],
        profile: mergeProfile(defaults, entry.profile || {}),
      };
    });
    if (versions.length === 0) {
      return null;
    }
    const current = String(raw.current_version || versions[versions.length - 1].version);
    return {
      current_version: versions.some((entry) => entry.version === current) ? current : versions[versions.length - 1].version,
      versions,
    };
  } catch {
    return null;
  }
}

function loadDeviceOverrideState(deviceOverridesPath) {
  const empty = { devices: {} };
  if (!fs.existsSync(deviceOverridesPath)) {
    return empty;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(deviceOverridesPath, "utf8"));
    const devices = {};
    const incoming = raw?.devices && typeof raw.devices === "object" && !Array.isArray(raw.devices)
      ? raw.devices
      : {};
    for (const [rawDeviceId, entry] of Object.entries(incoming)) {
      const deviceId = normalizeDeviceId(rawDeviceId);
      if (!deviceId) continue;
      const versions = Array.isArray(entry?.versions)
        ? entry.versions.map((version, index) => {
          const sequence = Number(version.sequence || index + 1);
          return {
            version: String(version.version || deviceVersionId(sequence)),
            sequence,
            created_at: typeof version.created_at === "string" ? version.created_at : new Date().toISOString(),
            source: cleanSource(version.source),
            reason: String(version.reason || "loaded").slice(0, 80),
            parent_version: String(version.parent_version || ""),
            changed: Array.isArray(version.changed) ? version.changed.filter((field) => PROFILE_FIELDS.includes(field)) : [],
            patch: pickProfileFields(version.patch || version.profile || {}),
          };
        })
        : [];
      devices[deviceId] = {
        current_version: versions.some((version) => version.version === entry?.current_version)
          ? String(entry.current_version)
          : (versions[versions.length - 1]?.version || ""),
        versions,
      };
    }
    return { devices };
  } catch {
    return empty;
  }
}

function loadLegacyPersisted(profilePath) {
  if (!fs.existsSync(profilePath)) {
    return null;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(profilePath, "utf8"));
    const picked = pickProfileFields(raw);
    return Object.keys(picked).length > 0 ? picked : null;
  } catch {
    // A corrupt profile file must not change behavior: fall back to the default.
    return null;
  }
}

function persistState({ versionsPath, profilePath, state, defaults }) {
  const tmpPath = `${versionsPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2));
  fs.renameSync(tmpPath, versionsPath);
  writeLegacyCurrent(profilePath, state, defaults);
}

function persistDeviceOverrideState(deviceOverridesPath, deviceState) {
  const tmpPath = `${deviceOverridesPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(deviceState, null, 2));
  fs.renameSync(tmpPath, deviceOverridesPath);
}

function writeLegacyCurrent(profilePath, state, defaults) {
  const current = state.versions.find((entry) => entry.version === state.current_version) || state.versions[state.versions.length - 1];
  const patch = diffProfile(defaults, current.profile);
  if (Object.keys(patch).length === 0) {
    if (fs.existsSync(profilePath)) {
      fs.rmSync(profilePath, { force: true });
    }
    return;
  }
  const tmpPath = `${profilePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(patch, null, 2));
  fs.renameSync(tmpPath, profilePath);
}

function mergeProfile(base, patch) {
  return { ...base, ...pickProfileFields(patch) };
}

function mergePatch(base, patch) {
  return { ...pickProfileFields(base), ...pickProfileFields(patch) };
}

// Coerce and keep only known fields with usable values. Unknown keys, empty
// strings, and invalid numbers are dropped so a patch never blanks a field.
function pickProfileFields(input) {
  if (!input || typeof input !== "object") {
    return {};
  }
  const out = {};
  if (typeof input.system_prompt === "string" && input.system_prompt.trim()) {
    const prompt = normalizeSystemPromptField(input.system_prompt);
    if (prompt) {
      out.system_prompt = prompt;
    }
  }
  if (typeof input.assistant_name === "string" && input.assistant_name.trim()) {
    const name = normalizeAssistantName(input.assistant_name);
    if (name) {
      out.assistant_name = name;
    }
  }
  if (typeof input.user_address === "string" && input.user_address.trim()) {
    const address = normalizeUserAddress(input.user_address);
    if (address) {
      out.user_address = address;
    }
  }
  if (typeof input.user_name === "string" && input.user_name.trim()) {
    const userName = normalizeUserAddress(input.user_name);
    if (userName) {
      out.user_name = userName;
    }
  }
  if (typeof input.user_nickname === "string" && input.user_nickname.trim()) {
    const nickname = normalizeUserAddress(input.user_nickname);
    if (nickname) {
      out.user_nickname = nickname;
    }
  }
  if (typeof input.model === "string" && input.model.trim()) {
    // The model id becomes a swappable reasoning target (env MODEL_ID default,
    // provider path/URL segment). Cap length and restrict to a safe id charset so
    // a bad value is dropped and the previous model is kept, never blanked and
    // never able to inject into a provider URL path.
    const model = input.model.trim();
    if (model.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(model)) {
      out.model = model;
    }
  }
  if (input.temperature !== undefined && input.temperature !== null && input.temperature !== "") {
    const temperature = Number(input.temperature);
    if (Number.isFinite(temperature) && temperature >= 0 && temperature <= 2) {
      out.temperature = temperature;
    }
  }
  if (input.voice_max_chars !== undefined && input.voice_max_chars !== null && input.voice_max_chars !== "") {
    const voiceMaxChars = Number(input.voice_max_chars);
    if (Number.isFinite(voiceMaxChars) && voiceMaxChars > 0) {
      out.voice_max_chars = Math.round(voiceMaxChars);
    }
  }
  if (typeof input.language === "string" && input.language.trim()) {
    const list = normalizeLanguageList(input.language);
    if (list.codes.length > 0 && list.invalid.length === 0) {
      out.language = list.codes.join(",");
      if (typeof input.language_primary !== "string" || !input.language_primary.trim()) {
        out.language_primary = list.codes[0];
      }
    }
  }
  if (typeof input.language_mode === "string" && input.language_mode.trim()) {
    const value = input.language_mode.trim().toLowerCase();
    if (["explicit", "auto"].includes(value)) {
      out.language_mode = value;
    }
  }
  if (typeof input.language_primary === "string" && input.language_primary.trim()) {
    const primary = normalizeLanguageCode(input.language_primary);
    if (primary) {
      out.language_primary = primary;
    }
  }
  if (typeof input.language_output === "string" && input.language_output.trim()) {
    const value = input.language_output.trim().toLowerCase();
    if (["same_as_input", "primary_only", "configured_value"].includes(value)) {
      out.language_output = value;
    }
  }
  if (typeof input.language_auto_switch === "boolean") {
    out.language_auto_switch = input.language_auto_switch;
  }
  // Languages the USER speaks. Chirp keeps provider recognition on `auto` and
  // turns these into a custom transcription prompt; native-audio providers
  // receive them through Moa-owned context.
  if (typeof input.input_languages === "string" && input.input_languages.trim()) {
    const list = normalizeLanguageList(input.input_languages);
    if (list.codes.length > 0 && list.invalid.length === 0) {
      out.input_languages = list.codes.join(",");
      if (typeof input.input_language_primary !== "string" || !input.input_language_primary.trim()) {
        out.input_language_primary = list.codes[0];
      }
    }
  }
  if (typeof input.input_language_primary === "string" && input.input_language_primary.trim()) {
    const primary = normalizeLanguageCode(input.input_language_primary);
    if (primary) {
      out.input_language_primary = primary;
    }
  }
  if (typeof input.speaker_context === "string") {
    const value = input.speaker_context
      .replace(/[\x00-\x1F\x7F]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 1200)
      .trim();
    if (value) out.speaker_context = value;
  }
  // How the agent delivers replies: "speech" (speak), "text" (write, no audio),
  // or "auto" (match the input — typed turn -> text, spoken turn -> speech).
  if (typeof input.response_modality === "string" && input.response_modality.trim()) {
    const value = input.response_modality.trim().toLowerCase();
    if (["speech", "text", "auto"].includes(value)) {
      out.response_modality = value;
    }
  }
  for (const field of ["voice_provider", "stt_provider", "reasoning_provider", "tts_provider"]) {
    if (typeof input[field] === "string" && input[field].trim()) {
      out[field] = input[field].trim().toLowerCase().replace(/_/g, "-").slice(0, 80);
    }
  }
  for (const field of ["tool_policy", "autonomy_level", "memory_policy", "recovery_mode"]) {
    if (typeof input[field] === "string" && input[field].trim()) {
      out[field] = input[field].trim().toLowerCase().replace(/\s+/g, "_").slice(0, 80);
    }
  }
  for (const field of ["active_companion_id", "active_companion_source", "active_companion_version"]) {
    if (typeof input[field] === "string" && input[field].trim()) {
      out[field] = input[field].trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_").slice(0, 120);
    }
  }
  if (typeof input.active_companion_name === "string" && input.active_companion_name.trim()) {
    const name = normalizeAssistantName(input.active_companion_name);
    if (name) {
      out.active_companion_name = name;
    }
  }
  if (input.voice !== undefined && input.voice !== null && input.voice !== "") {
    const voice = normalizeVoice(input.voice);
    // Unknown voices are dropped (not persisted) so a bad value leaves the
    // current/default voice in place rather than breaking the live session.
    if (voice) {
      out.voice = voice;
    }
  }
  // Spoken delivery pace: 1.0 = the provider's normal speed. Values are clamped
  // to 0.5–2.0 (the Chirp/Gemini-TTS supported band) instead of dropped, so
  // "2.5x" persists the fastest supported rate rather than silently keeping the
  // old one.
  if (input.speaking_rate !== undefined && input.speaking_rate !== null && input.speaking_rate !== "") {
    const rate = Number(input.speaking_rate);
    if (Number.isFinite(rate) && rate > 0) {
      out.speaking_rate = Math.min(2, Math.max(0.5, Math.round(rate * 100) / 100));
    }
  }
  // Spoken delivery tone: a few free-text words fed to the expressive TTS style
  // prompt ("warm, upbeat"). The reset words store "" (explicitly cleared) —
  // the one field where a blank IS a valid persisted value.
  if (typeof input.voice_tone === "string" && input.voice_tone.trim()) {
    const tone = normalizeVoiceTone(input.voice_tone);
    if (tone !== null) {
      out.voice_tone = tone;
    }
  }
  return out;
}

const VOICE_TONE_RESET_WORDS = new Set(["none", "neutral", "default", "normal", "reset", "clear"]);

// Sanitize a tone descriptor: strip control chars, collapse whitespace, cap
// length. Returns "" for the reset words, null when nothing usable remains.
function normalizeVoiceTone(value) {
  const cleaned = String(value || "")
    .replace(/[\x00-\x1F\x7F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160)
    .trim();
  if (!cleaned) {
    return null;
  }
  if (VOICE_TONE_RESET_WORDS.has(cleaned.toLowerCase())) {
    return "";
  }
  return cleaned;
}

// Build the baseline profile object from env-derived defaults, applying the
// same coercion. Missing values fall back to gateway defaults.
function normalizeProfile(defaults) {
  const picked = pickProfileFields(defaults);
  const language = picked.language || picked.language_primary || "en-US";
  const languagePrimary = picked.language_primary || picked.language || "en-US";
  return {
    system_prompt: picked.system_prompt || "",
    assistant_name: picked.assistant_name || normalizeAssistantName("Ag"),
    user_address: picked.user_address || normalizeUserAddress(process.env.MOA_USER_ADDRESS) || "master",
    user_name: picked.user_name || normalizeUserAddress(process.env.MOA_USER_NAME) || "",
    user_nickname: picked.user_nickname || normalizeUserAddress(process.env.MOA_USER_NICKNAME) || "",
    model: picked.model || "",
    temperature: picked.temperature !== undefined ? picked.temperature : 0.4,
    voice_max_chars: picked.voice_max_chars !== undefined ? picked.voice_max_chars : 280,
    language,
    // Empty means "no profile override"; the voice provider falls back to its
    // env default (GEMINI_LIVE_VOICE) when the effective voice is unset.
    voice: picked.voice || "",
    // Fast-by-default delivery: 1.5x normal speed unless the env default or a
    // persisted change says otherwise.
    speaking_rate: picked.speaking_rate !== undefined ? picked.speaking_rate : 1.5,
    voice_tone: picked.voice_tone !== undefined ? picked.voice_tone : "",
    language_mode: picked.language_mode || "explicit",
    language_primary: languagePrimary,
    language_output: picked.language_output || "primary_only",
    language_auto_switch: picked.language_auto_switch === true,
    input_languages: picked.input_languages || "en-US",
    input_language_primary: picked.input_language_primary
      || (picked.input_languages ? picked.input_languages.split(",")[0].trim() : "")
      || "en-US",
    speaker_context: picked.speaker_context || DEFAULT_SPEAKER_CONTEXT,
    response_modality: picked.response_modality || "auto",
    voice_provider: picked.voice_provider || "",
    stt_provider: picked.stt_provider || "",
    reasoning_provider: picked.reasoning_provider || "",
    tts_provider: picked.tts_provider || "",
    tool_policy: picked.tool_policy || "propose_only",
    autonomy_level: picked.autonomy_level || "confirm_actions",
    memory_policy: picked.memory_policy || "recall_and_write",
    recovery_mode: picked.recovery_mode || "normal",
    active_companion_id: picked.active_companion_id || "",
    active_companion_name: picked.active_companion_name || "",
    active_companion_source: picked.active_companion_source || "",
    active_companion_version: picked.active_companion_version || "",
  };
}

// Spoken turns are the highest-corruption write channel: a mis-transcribed
// utterance can silently rename the assistant or replace its persona (seen
// live 2026-07-13: STT garbage persisted as system_prompt, assistant_name
// churned through nonsense values). A spoken rename must look like a name and
// a spoken persona must stay small; anything larger needs the API/studio
// path. Dropped fields fall out of the patch, so callers' before/after diff
// honestly reports "nothing changed".
const SPOKEN_PROFILE_SOURCES = /^(voice|gemini-live-tool)/;
const SPOKEN_NAME_MAX_CHARS = 40;
const SPOKEN_NAME_MAX_WORDS = 4;
const SPOKEN_PROMPT_MAX_CHARS = 400;

function guardSpokenIdentityFields(next, source) {
  if (!SPOKEN_PROFILE_SOURCES.test(String(source || ""))) {
    return next;
  }
  const out = { ...next };
  if (typeof out.assistant_name === "string") {
    const words = out.assistant_name.split(/\s+/).filter(Boolean);
    if (out.assistant_name.length > SPOKEN_NAME_MAX_CHARS || words.length > SPOKEN_NAME_MAX_WORDS) {
      delete out.assistant_name;
    }
  }
  if (typeof out.system_prompt === "string" && out.system_prompt.length > SPOKEN_PROMPT_MAX_CHARS) {
    delete out.system_prompt;
  }
  return out;
}

function normalizeAssistantName(value) {
  const cleaned = String(value || "")
    .trim()
    .replace(/^["'`]+|["'`.!,?;:]+$/g, "")
    .replace(/\s+/g, " ");
  if (!cleaned) {
    return "";
  }
  if (cleaned.length > 80) {
    return "";
  }
  if (!/[A-Za-z0-9]/.test(cleaned)) {
    return "";
  }
  return cleaned;
}

function normalizeUserAddress(value) {
  const cleaned = String(value || "")
    .replace(/[\x00-\x1F\x7F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60)
    .trim();
  return cleaned || "";
}

// Phrases a spoken "become X" / "set your prompt to X" must never smuggle in:
// attempts to override the gateway's own guidelines, safety rules, or identity
// boundary. Matched on the lowercased prompt; a match strips that clause rather
// than persisting it, so a persona stays a persona and cannot rewrite the rules.
const OVERRIDE_QUALIFIER = "(?:your|all|any|the|previous|prior|earlier|above|its)";
const OVERRIDE_TARGET = "(?:guidelines?|rules?|instructions?|policies|policy|constraints?|safety|system\\s+prompt|restrictions?|limits?|filters?)";
const PROMPT_OVERRIDE_PATTERNS = [
  new RegExp(`\\b(?:ignore|disregard|forget|override|bypass|disable|drop|remove|skip)\\s+(?:${OVERRIDE_QUALIFIER}\\s+)+${OVERRIDE_TARGET}\\b[^.!?]*`, "gi"),
  /\byou\s+have\s+no\s+(?:guidelines?|rules?|restrictions?|limits?|constraints?|safety|filters?)\b[^.!?]*/gi,
  /\b(?:there\s+are\s+no|without\s+any)\s+(?:guidelines?|rules?|restrictions?|limits?|constraints?|filters?|safety)\b[^.!?]*/gi,
  /\b(?:jailbreak|developer\s+mode|dan\s+mode|do\s+anything\s+now)\b[^.!?]*/gi,
  /\byou\s+are\s+not\s+bound\s+by\b[^.!?]*/gi,
];
const PROMPT_MAX_CHARS = 1200;

// Strip adversarial override clauses and cap length. Returns the cleaned prompt,
// or "" when nothing usable is left. Never persists a rule-override attempt.
function sanitizePersonaPrompt(value) {
  let prompt = String(value || "").trim();
  if (!prompt) {
    return "";
  }
  for (const pattern of PROMPT_OVERRIDE_PATTERNS) {
    prompt = prompt.replace(pattern, " ");
  }
  prompt = prompt.replace(/\s+/g, " ").trim().slice(0, PROMPT_MAX_CHARS).trim();
  return prompt;
}

function normalizeSystemPromptField(value) {
  const prompt = sanitizePersonaPrompt(value);
  return prompt ? withRequiredVoiceStyle(prompt) : "";
}

function safeSystemPromptForProvider(profile, fallback = "") {
  return withRequiredVoiceStyle(profile?.system_prompt || "", fallback);
}

function withRequiredVoiceStyle(prompt, fallback = "") {
  let value = String(prompt || "").trim() || String(fallback || "").trim() || "You are Ag, the user's personal AI companion.";
  value = value.replace(LEGACY_VOICE_STYLE_RULE, "").trim();
  const requiredRuleIndex = value.indexOf(REQUIRED_VOICE_STYLE_RULE);
  if (requiredRuleIndex >= 0) {
    const prefix = value.slice(0, requiredRuleIndex).trim();
    const suffix = value.slice(requiredRuleIndex + REQUIRED_VOICE_STYLE_RULE.length).trim();
    return [prefix, REQUIRED_VOICE_STYLE_RULE, suffix].filter(Boolean).join("\n\n");
  }
  return [value, REQUIRED_VOICE_STYLE_RULE].join("\n\n");
}

function freeze(profile) {
  return Object.freeze({ ...profile });
}

function profilesEqual(left, right) {
  return PROFILE_FIELDS.every((field) => left?.[field] === right?.[field]);
}

function patchesEqual(left, right) {
  return PROFILE_FIELDS.every((field) => (left?.[field] || undefined) === (right?.[field] || undefined));
}

function changedFields(before, after) {
  return PROFILE_FIELDS.filter((field) => before?.[field] !== after?.[field]);
}

function changedPatchFields(before, after) {
  return PROFILE_FIELDS.filter((field) => (before?.[field] || undefined) !== (after?.[field] || undefined));
}

function diffProfile(defaults, profile) {
  const patch = {};
  for (const field of PROFILE_FIELDS) {
    if (defaults?.[field] !== profile?.[field]) {
      patch[field] = profile[field];
    }
  }
  return patch;
}

function nextSequence(versions) {
  return versions.reduce((max, entry) => Math.max(max, Number(entry.sequence || 0)), 0) + 1;
}

function versionId(sequence) {
  return `profile_v${String(Math.max(1, Number(sequence) || 1)).padStart(4, "0")}`;
}

function deviceVersionId(sequence) {
  return `device_profile_v${String(Math.max(1, Number(sequence) || 1)).padStart(4, "0")}`;
}

function normalizeDeviceId(value) {
  const cleaned = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
  return cleaned || "";
}

function cleanSource(source) {
  return typeof source === "string" && source.trim() ? source.trim().slice(0, 80) : "api";
}

function publicVersionRecord(entry) {
  return {
    version: entry.version,
    sequence: entry.sequence,
    created_at: entry.created_at,
    source: entry.source,
    reason: entry.reason,
    parent_version: entry.parent_version,
    rollback_from_version: entry.rollback_from_version,
    changed: entry.changed,
    profile: { ...entry.profile },
  };
}

module.exports = {
  createAgentProfileStore,
  PROFILE_FIELDS,
  CORE_VOICES,
  normalizeVoice,
  normalizeAssistantName,
  normalizeUserAddress,
  normalizeDeviceId,
  normalizeSystemPromptField,
  sanitizePersonaPrompt,
  safeSystemPromptForProvider,
  withRequiredVoiceStyle,
};
