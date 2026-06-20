"use strict";

// Runtime-editable, versioned agent profile layered over gateway defaults.
//
// Effective profile = current profile version. Each persisted edit appends a
// version instead of mutating prior turn history, so voice/chat turns and agent
// runs can record the exact profile version they used.

const fs = require("node:fs");
const path = require("node:path");

const PROFILE_FILENAME = "agent-profile.json";
const PROFILE_VERSIONS_FILENAME = "agent-profile-versions.json";
// Only these fields may be patched/persisted/overridden; anything else is ignored.
const PROFILE_FIELDS = [
  "system_prompt",
  "model",
  "temperature",
  "voice_max_chars",
  "language",
  "voice",
  "language_mode",
  "language_primary",
  "language_output",
  "language_auto_switch",
  "voice_provider",
  "stt_provider",
  "reasoning_provider",
  "tts_provider",
  "tool_policy",
  "autonomy_level",
  "memory_policy",
  "recovery_mode",
];

// The Gemini Live core voices that are safe on any live model. The agent can
// switch its OWN spoken voice to one of these by talking to itself; an unknown
// value is rejected (the field is left unchanged) so a typo never blanks it.
// Google labels these by style, not gender — gender aliases are defined in the
// extension's settings-intent parser, which maps to one of these canonical names.
const CORE_VOICES = ["Puck", "Charon", "Kore", "Fenrir", "Aoede", "Leda", "Orus", "Zephyr"];
const CORE_VOICES_BY_LOWER = new Map(CORE_VOICES.map((name) => [name.toLowerCase(), name]));

// Canonicalize a requested voice to its proper-case core-voice name, or return
// null if it is not one of the core 8 (case-insensitive). Null means "reject".
function normalizeVoice(value) {
  if (typeof value !== "string") {
    return null;
  }
  return CORE_VOICES_BY_LOWER.get(value.trim().toLowerCase()) || null;
}

function createAgentProfileStore(options) {
  const dataDir = path.resolve(options?.dataDir || "./data");
  const profilePath = path.join(dataDir, PROFILE_FILENAME);
  const versionsPath = path.join(dataDir, PROFILE_VERSIONS_FILENAME);
  // The env default is computed once at boot; it is the immutable baseline.
  const defaults = freeze(normalizeProfile(options?.defaults || {}));

  fs.mkdirSync(dataDir, { recursive: true });

  let state = loadVersionState({ profilePath, versionsPath, defaults });

  function effective() {
    return { ...currentVersionRecord().profile };
  }

  function isOverridden() {
    return !profilesEqual(currentVersionRecord().profile, defaults);
  }

  // Merge a per-request override onto the effective profile WITHOUT persisting.
  function effectiveWithOverrides(overrides) {
    const base = effective();
    const patch = pickProfileFields(overrides);
    return Object.keys(patch).length > 0 ? mergeProfile(base, patch) : base;
  }

  // Patch + persist as a new version; returns the new effective profile. Applied
  // to later turns with no restart because callers read effective() per request.
  function patch(updates, metadata = {}) {
    const next = pickProfileFields(updates);
    if (Object.keys(next).length === 0) {
      return effective();
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

  function currentVersion() {
    return currentVersionRecord().version;
  }

  function listVersions(options = {}) {
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

  return {
    profilePath,
    versionsPath,
    defaults: () => ({ ...defaults }),
    effective,
    effectiveWithOverrides,
    isOverridden,
    patch,
    reset,
    rollback,
    currentVersion,
    versions: listVersions,
    fields: () => PROFILE_FIELDS.slice(),
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
        profile: normalizeProfile({ ...defaults, ...(entry.profile || {}) }),
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

// Coerce and keep only known fields with usable values. Unknown keys, empty
// strings, and invalid numbers are dropped so a patch never blanks a field.
function pickProfileFields(input) {
  if (!input || typeof input !== "object") {
    return {};
  }
  const out = {};
  if (typeof input.system_prompt === "string" && input.system_prompt.trim()) {
    out.system_prompt = input.system_prompt.trim();
  }
  if (typeof input.model === "string" && input.model.trim()) {
    out.model = input.model.trim();
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
    out.language = input.language.trim().slice(0, 40);
  }
  if (typeof input.language_mode === "string" && input.language_mode.trim()) {
    const value = input.language_mode.trim().toLowerCase();
    if (["explicit", "auto"].includes(value)) {
      out.language_mode = value;
    }
  }
  if (typeof input.language_primary === "string" && input.language_primary.trim()) {
    out.language_primary = input.language_primary.trim().slice(0, 40);
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
  if (input.voice !== undefined && input.voice !== null && input.voice !== "") {
    const voice = normalizeVoice(input.voice);
    // Unknown voices are dropped (not persisted) so a bad value leaves the
    // current/default voice in place rather than breaking the live session.
    if (voice) {
      out.voice = voice;
    }
  }
  return out;
}

// Build the baseline profile object from env-derived defaults, applying the
// same coercion. Missing values fall back to gateway defaults.
function normalizeProfile(defaults) {
  const picked = pickProfileFields(defaults);
  const language = picked.language || picked.language_primary || "";
  const languagePrimary = picked.language_primary || picked.language || "en-US";
  return {
    system_prompt: picked.system_prompt || "",
    model: picked.model || "",
    temperature: picked.temperature !== undefined ? picked.temperature : 0.4,
    voice_max_chars: picked.voice_max_chars !== undefined ? picked.voice_max_chars : 280,
    language,
    // Empty means "no profile override"; the voice provider falls back to its
    // env default (GEMINI_LIVE_VOICE) when the effective voice is unset.
    voice: picked.voice || "",
    language_mode: picked.language_mode || "explicit",
    language_primary: languagePrimary,
    language_output: picked.language_output || "primary_only",
    language_auto_switch: picked.language_auto_switch === true,
    voice_provider: picked.voice_provider || "",
    stt_provider: picked.stt_provider || "",
    reasoning_provider: picked.reasoning_provider || "",
    tts_provider: picked.tts_provider || "",
    tool_policy: picked.tool_policy || "propose_only",
    autonomy_level: picked.autonomy_level || "confirm_actions",
    memory_policy: picked.memory_policy || "recall_and_write",
    recovery_mode: picked.recovery_mode || "normal",
  };
}

function freeze(profile) {
  return Object.freeze({ ...profile });
}

function profilesEqual(left, right) {
  return PROFILE_FIELDS.every((field) => left?.[field] === right?.[field]);
}

function changedFields(before, after) {
  return PROFILE_FIELDS.filter((field) => before?.[field] !== after?.[field]);
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
};
