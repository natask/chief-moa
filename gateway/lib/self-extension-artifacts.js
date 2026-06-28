"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const STORE_FILENAME = "self-extension-artifacts.json";
const STORE_VERSION = 1;
const ARTIFACT_TYPES = ["avatar_behavior"];
const STATUSES = ["draft", "applied", "archived"];
const AVATAR_TRIGGERS = [
  "idle",
  "editing",
  "listening",
  "thinking",
  "speaking",
  "done",
  "error",
  "attention",
  "busy",
];
const AVATAR_MOTIONS = ["still", "pulse", "hop", "orbit", "float", "shake", "glow"];
const AVATAR_INTENSITIES = ["subtle", "normal", "strong"];
const AVATAR_DURATIONS = ["while_active"];

function createSelfExtensionArtifactStore(options = {}) {
  const dataDir = path.resolve(options.dataDir || "./data");
  const storePath = path.join(dataDir, STORE_FILENAME);
  fs.mkdirSync(dataDir, { recursive: true });

  let state = loadState(storePath);

  function list(filter = {}) {
    const type = cleanText(filter.type, 80);
    const status = cleanText(filter.status, 40);
    const limit = clampLimit(filter.limit, 100);
    return Object.values(state.artifacts)
      .filter((artifact) => (type ? artifact.type === type : true))
      .filter((artifact) => (status ? artifact.status === status : true))
      .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")))
      .slice(0, limit)
      .map(clone);
  }

  function get(id) {
    const safeId = cleanToken(id, 80);
    const artifact = safeId ? state.artifacts[safeId] : null;
    return artifact ? clone(artifact) : null;
  }

  function createCandidate(input = {}) {
    const type = normalizeType(input.type);
    const validation = validateSpec(type, input.spec);
    if (!validation.ok) {
      throw new Error(`invalid ${type} spec: ${validation.errors.join("; ")}`);
    }
    const now = new Date().toISOString();
    const artifact = {
      id: `art_${crypto.randomBytes(8).toString("hex")}`,
      type,
      title: cleanText(input.title, 160) || defaultTitle(type, validation.spec),
      status: "draft",
      variant_group_id: cleanToken(input.variant_group_id || input.variantGroupId, 80) || `var_${crypto.randomBytes(6).toString("hex")}`,
      parent_id: cleanToken(input.parent_id || input.parentId, 80),
      prompt: cleanText(input.prompt || input.intent || input.text, 2000),
      spec: validation.spec,
      preview: previewFor(type, validation.spec),
      validation: {
        ok: true,
        errors: [],
        warnings: validation.warnings,
      },
      created_at: now,
      updated_at: now,
      applied_at: "",
    };
    state.artifacts[artifact.id] = artifact;
    flush(storePath, state);
    return clone(artifact);
  }

  function apply(id) {
    const safeId = cleanToken(id, 80);
    const artifact = safeId ? state.artifacts[safeId] : null;
    if (!artifact) {
      return null;
    }
    if (artifact.validation?.ok !== true) {
      throw new Error(`artifact ${safeId} is not valid`);
    }
    const now = new Date().toISOString();
    for (const candidate of Object.values(state.artifacts)) {
      if (candidate.type === artifact.type && candidate.status === "applied" && candidate.id !== artifact.id) {
        candidate.status = "draft";
        candidate.updated_at = now;
      }
    }
    artifact.status = "applied";
    artifact.updated_at = now;
    artifact.applied_at = now;
    state.active[artifact.type] = artifact.id;
    flush(storePath, state);
    return clone(artifact);
  }

  function runtime() {
    const active = {};
    for (const type of ARTIFACT_TYPES) {
      const artifact = state.artifacts[state.active[type]];
      active[type] = artifact && artifact.status === "applied"
        ? runtimeArtifact(artifact)
        : null;
    }
    return {
      version: STORE_VERSION,
      generated_at: new Date().toISOString(),
      active,
    };
  }

  return {
    storePath,
    list,
    get,
    createCandidate,
    apply,
    runtime,
    validate: validateArtifactInput,
    known: () => ({
      artifact_types: ARTIFACT_TYPES.slice(),
      avatar_behavior: {
        triggers: AVATAR_TRIGGERS.slice(),
        motions: AVATAR_MOTIONS.slice(),
        intensities: AVATAR_INTENSITIES.slice(),
        durations: AVATAR_DURATIONS.slice(),
      },
    }),
  };
}

function validateArtifactInput(input = {}) {
  const type = normalizeType(input.type);
  return validateSpec(type, input.spec);
}

function validateSpec(type, spec) {
  if (type === "avatar_behavior") {
    return validateAvatarBehaviorSpec(spec);
  }
  return { ok: false, errors: [`unsupported artifact type: ${type}`], warnings: [], spec: {} };
}

function validateAvatarBehaviorSpec(input) {
  const errors = [];
  const warnings = [];
  const spec = plainObject(input);
  const trigger = cleanToken(spec.trigger, 40);
  const motion = cleanToken(spec.motion, 40);
  const intensity = cleanToken(spec.intensity, 40);
  const duration = cleanToken(spec.duration, 40);

  if (!AVATAR_TRIGGERS.includes(trigger)) {
    errors.push(`trigger must be one of: ${AVATAR_TRIGGERS.join(", ")}`);
  }
  if (!AVATAR_MOTIONS.includes(motion)) {
    errors.push(`motion must be one of: ${AVATAR_MOTIONS.join(", ")}`);
  }
  if (!AVATAR_INTENSITIES.includes(intensity)) {
    errors.push(`intensity must be one of: ${AVATAR_INTENSITIES.join(", ")}`);
  }
  if (!AVATAR_DURATIONS.includes(duration)) {
    errors.push(`duration must be one of: ${AVATAR_DURATIONS.join(", ")}`);
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    spec: {
      trigger,
      motion,
      intensity,
      duration,
    },
  };
}

function runtimeArtifact(artifact) {
  return {
    artifact_id: artifact.id,
    type: artifact.type,
    title: artifact.title,
    spec: clone(artifact.spec),
    preview: clone(artifact.preview),
    applied_at: artifact.applied_at,
  };
}

function previewFor(type, spec) {
  if (type === "avatar_behavior") {
    return {
      class_name: `moa-avatar--${spec.trigger}-${spec.motion}-${spec.intensity}`,
      trigger: spec.trigger,
      motion: spec.motion,
      duration: spec.duration,
    };
  }
  return {};
}

function normalizeType(value) {
  const type = cleanToken(value, 80);
  if (!ARTIFACT_TYPES.includes(type)) {
    throw new Error(`unsupported artifact type: ${type || "(missing)"}`);
  }
  return type;
}

function defaultTitle(type, spec) {
  if (type === "avatar_behavior") {
    return `${spec.trigger} ${spec.motion}`;
  }
  return type;
}

function loadState(storePath) {
  if (!fs.existsSync(storePath)) {
    return emptyState();
  }
  try {
    return normalizeState(JSON.parse(fs.readFileSync(storePath, "utf8")), storePath);
  } catch {
    archiveCorruptStore(storePath);
    return emptyState();
  }
}

function normalizeState(raw, storePath = "") {
  if (!raw || typeof raw !== "object" || !raw.artifacts || typeof raw.artifacts !== "object") {
    archiveCorruptStore(storePath);
    return emptyState();
  }
  const next = emptyState();
  let droppedPersistedData = false;
  for (const artifact of Object.values(raw.artifacts)) {
    const normalized = normalizePersistedArtifact(artifact);
    if (normalized) {
      next.artifacts[normalized.id] = normalized;
    } else {
      droppedPersistedData = true;
    }
  }
  const active = plainObject(raw.active);
  for (const type of ARTIFACT_TYPES) {
    const id = cleanToken(active[type], 80);
    if (id && next.artifacts[id]?.type === type) {
      next.active[type] = id;
    } else if (id) {
      droppedPersistedData = true;
    }
  }
  if (droppedPersistedData) {
    archiveCorruptStore(storePath);
  }
  return next;
}

function normalizePersistedArtifact(input) {
  if (!input || typeof input !== "object") {
    return null;
  }
  const id = cleanToken(input.id, 80);
  let type;
  try {
    type = normalizeType(input.type);
  } catch {
    return null;
  }
  const validation = validateSpec(type, input.spec);
  if (!id || !validation.ok) {
    return null;
  }
  const createdAt = cleanDate(input.created_at) || new Date().toISOString();
  return {
    id,
    type,
    title: cleanText(input.title, 160) || defaultTitle(type, validation.spec),
    status: STATUSES.includes(input.status) ? input.status : "draft",
    variant_group_id: cleanToken(input.variant_group_id, 80) || `var_${crypto.randomBytes(6).toString("hex")}`,
    parent_id: cleanToken(input.parent_id, 80),
    prompt: cleanText(input.prompt, 2000),
    spec: validation.spec,
    preview: plainObject(input.preview),
    validation: {
      ok: true,
      errors: [],
      warnings: Array.isArray(input.validation?.warnings) ? input.validation.warnings.filter((item) => typeof item === "string") : [],
    },
    created_at: createdAt,
    updated_at: cleanDate(input.updated_at) || createdAt,
    applied_at: cleanDate(input.applied_at),
  };
}

function emptyState() {
  return { version: STORE_VERSION, artifacts: {}, active: {} };
}

function flush(storePath, state) {
  const tmpPath = `${storePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2));
  fs.renameSync(tmpPath, storePath);
}

function archiveCorruptStore(storePath) {
  if (!storePath || !fs.existsSync(storePath)) {
    return "";
  }
  const stamp = new Date().toISOString().replace(/[^0-9TZ]/g, "");
  const archivePath = `${storePath}.corrupt-${stamp}`;
  try {
    fs.copyFileSync(storePath, archivePath);
    return archivePath;
  } catch {
    return "";
  }
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function cleanText(value, max) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().slice(0, max);
}

function cleanToken(value, max) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, max);
}

function cleanDate(value) {
  const text = typeof value === "string" ? value.trim() : "";
  const date = text ? new Date(text) : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

function clampLimit(value, fallback) {
  const numeric = Number(value || fallback);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(1, Math.min(Math.trunc(numeric), 500));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

module.exports = {
  createSelfExtensionArtifactStore,
  ARTIFACT_TYPES,
  AVATAR_TRIGGERS,
  AVATAR_MOTIONS,
  AVATAR_INTENSITIES,
  AVATAR_DURATIONS,
};
