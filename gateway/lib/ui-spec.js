"use strict";

// Engine-served declarative UI spec (tier A of the thin-client architecture).
//
// The browser extension is a thin client: it renders surfaces from this spec
// and never ships UI as extension code. The engine stores a per-user spec; the
// extension fetches it and re-renders on change (the storage.onChanged live-
// refresh pattern). A "deployment" is a spec change here, not a new extension
// package. See openspec/changes/thin-client-gateway-architecture/design.md.
//
// The spec is a whole document (replace-not-merge), validated so a bad PUT can
// never blank the surface: an invalid spec is rejected and the prior/default
// spec stays in place. This mirrors agent-profile.js's file/atomic-write idioms.

const fs = require("node:fs");
const path = require("node:path");

const SPEC_FILENAME = "ui-spec.json";
const SPEC_VERSION = 1;
// A control the renderer knows how to draw. `action` names a client-side
// capability (voice toggle, command open, agent run); the engine never ships
// executable code here, only the binding name.
const CONTROL_TYPES = ["button", "text", "toggle", "select"];
const KNOWN_ACTIONS = [
  "voice.toggle",
  "command.open",
  "agent.run",
  "page.describe",
  "settings.open",
  "noop",
];

// The default surface every client gets before the user customizes anything.
// It describes A.G.'s command panel declaratively: talk, type, run.
function defaultSpec() {
  return {
    version: SPEC_VERSION,
    surfaces: [
      {
        id: "command-panel",
        title: "A.G.",
        controls: [
          { type: "button", id: "talk", label: "Talk", action: "voice.toggle" },
          { type: "button", id: "type", label: "Type", action: "command.open" },
          { type: "text", id: "intent", label: "What should I do?", action: "agent.run" },
        ],
      },
    ],
  };
}

function createUiSpecStore(options) {
  const dataDir = path.resolve(options?.dataDir || "./data");
  const specPath = path.join(dataDir, SPEC_FILENAME);
  const baseline = Object.freeze(normalizeSpec(options?.defaults) || defaultSpec());

  fs.mkdirSync(dataDir, { recursive: true });

  // The persisted per-user spec, or null when the user has not customized.
  let persisted = loadPersisted(specPath);

  function effective() {
    return persisted ? cloneSpec(persisted) : cloneSpec(baseline);
  }

  function isCustomized() {
    return persisted !== null;
  }

  // Replace the spec wholesale. Throws on an invalid spec so the caller returns
  // 400 and the live surface is never blanked by a bad write.
  function replace(input) {
    const next = normalizeSpec(input);
    if (!next) {
      throw new Error("invalid ui spec: expected { surfaces: [...] } with known control types");
    }
    persisted = next;
    writePersisted(specPath, persisted);
    return effective();
  }

  function reset() {
    persisted = null;
    if (fs.existsSync(specPath)) {
      fs.rmSync(specPath, { force: true });
    }
    return effective();
  }

  return {
    specPath,
    defaults: () => cloneSpec(baseline),
    effective,
    isCustomized,
    replace,
    reset,
  };
}

function loadPersisted(specPath) {
  if (!fs.existsSync(specPath)) {
    return null;
  }
  try {
    return normalizeSpec(JSON.parse(fs.readFileSync(specPath, "utf8")));
  } catch {
    // A corrupt spec file must not blank the surface: fall back to default.
    return null;
  }
}

function writePersisted(specPath, spec) {
  const tmpPath = `${specPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(spec, null, 2));
  fs.renameSync(tmpPath, specPath);
}

// Validate and coerce a spec. Returns the cleaned spec, or null if it cannot be
// made into a renderable document (no usable surfaces).
function normalizeSpec(input) {
  if (!input || typeof input !== "object" || !Array.isArray(input.surfaces)) {
    return null;
  }
  const surfaces = input.surfaces
    .map(normalizeSurface)
    .filter(Boolean);
  if (surfaces.length === 0) {
    return null;
  }
  return { version: SPEC_VERSION, surfaces };
}

function normalizeSurface(surface) {
  if (!surface || typeof surface !== "object") {
    return null;
  }
  const id = cleanToken(surface.id);
  if (!id) {
    return null;
  }
  const controls = Array.isArray(surface.controls)
    ? surface.controls.map(normalizeControl).filter(Boolean)
    : [];
  return {
    id,
    title: typeof surface.title === "string" ? surface.title.slice(0, 80) : id,
    controls,
  };
}

function normalizeControl(control) {
  if (!control || typeof control !== "object") {
    return null;
  }
  const type = CONTROL_TYPES.includes(control.type) ? control.type : null;
  const id = cleanToken(control.id);
  if (!type || !id) {
    return null;
  }
  const action = KNOWN_ACTIONS.includes(control.action) ? control.action : "noop";
  const out = {
    type,
    id,
    label: typeof control.label === "string" ? control.label.slice(0, 80) : id,
    action,
  };
  // select carries its options as plain string data (config, not code).
  if (type === "select" && Array.isArray(control.options)) {
    out.options = control.options
      .map((opt) => (typeof opt === "string" ? opt.slice(0, 80) : ""))
      .filter(Boolean)
      .slice(0, 50);
  }
  return out;
}

function cleanToken(value) {
  return typeof value === "string"
    ? value.trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 60)
    : "";
}

function cloneSpec(spec) {
  return JSON.parse(JSON.stringify(spec));
}

module.exports = {
  createUiSpecStore,
  defaultSpec,
  normalizeSpec,
  SPEC_VERSION,
  CONTROL_TYPES,
  KNOWN_ACTIONS,
};
