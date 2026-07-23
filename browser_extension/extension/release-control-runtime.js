"use strict";

const APPLICATION_ID = "chief-moa";
const SURFACE = "browser_extension";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

function fail(path, message) {
  throw new Error(`Release control response is invalid at ${path}: ${message}.`);
}

function object(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(path, "expected an object");
  return value;
}

function text(value, path, { pattern = null, max = 500 } = {}) {
  if (typeof value !== "string" || !value || value.length > max) fail(path, "expected bounded text");
  if (pattern && !pattern.test(value)) fail(path, "unexpected format");
  return value;
}

function optionalText(value, path, options) {
  return value == null ? null : text(value, path, options);
}

function integer(value, path) {
  if (!Number.isSafeInteger(value) || value < 0) fail(path, "expected a non-negative integer");
  return value;
}

function exactBoolean(value, path) {
  if (typeof value !== "boolean") fail(path, "expected a boolean");
  return value;
}

function digest(value, path) {
  return text(value, path, { pattern: SHA256_PATTERN, max: 64 });
}

function id(value, path) {
  return text(value, path, { pattern: ID_PATTERN, max: 160 });
}

function boundedJson(value, path, depth = 0) {
  if (depth > 5) fail(path, "nested too deeply");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(path, "number must be finite");
    return value;
  }
  if (typeof value === "string") return text(value, path, { max: 1000 });
  if (Array.isArray(value)) {
    if (value.length > 100) fail(path, "too many items");
    return value.map((item, index) => boundedJson(item, `${path}[${index}]`, depth + 1));
  }
  const source = object(value, path);
  const entries = Object.entries(source);
  if (entries.length > 100) fail(path, "too many fields");
  return Object.fromEntries(entries.map(([key, item]) => [
    text(key, `${path} key`, { pattern: /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/, max: 80 }),
    boundedJson(item, `${path}.${key}`, depth + 1),
  ]));
}

function parseArtifact(value, path) {
  const source = object(value, path);
  const surface = text(source.surface, `${path}.surface`, { pattern: ID_PATTERN, max: 160 });
  if (surface !== SURFACE) fail(`${path}.surface`, `expected ${SURFACE}`);
  const downloadUrl = optionalText(source.download_url, `${path}.download_url`, { max: 2000 });
  if (downloadUrl) {
    let parsed;
    try {
      parsed = new URL(downloadUrl);
    } catch {
      fail(`${path}.download_url`, "expected an absolute URL");
    }
    if (!["https:", "http:"].includes(parsed.protocol)) fail(`${path}.download_url`, "unsupported URL scheme");
  }
  return Object.freeze({
    surface,
    sha256: digest(source.sha256, `${path}.sha256`),
    size_bytes: integer(source.size_bytes, `${path}.size_bytes`),
    version: text(source.version, `${path}.version`, { pattern: /^[0-9]+(?:\.[0-9]+){1,3}(?:[-+][A-Za-z0-9.-]+)?$/, max: 80 }),
    download_url: downloadUrl,
    git_sha: text(source.git_sha, `${path}.git_sha`, { pattern: /^[a-f0-9]{7,64}$/, max: 64 }),
  });
}

function parseBundle(value, path) {
  const source = object(value, path);
  return Object.freeze({
    ...boundedJson(source, path),
    bundle_id: id(source.bundle_id, `${path}.bundle_id`),
    release_id: id(source.release_id, `${path}.release_id`),
  });
}

function parseAssignment(value, path) {
  const source = object(value, path);
  const channel = text(source.channel, `${path}.channel`, { pattern: /^(stable|preview)$/, max: 7 });
  return Object.freeze({
    assignment_id: id(source.assignment_id, `${path}.assignment_id`),
    sequence: integer(source.sequence, `${path}.sequence`),
    scope: text(source.scope, `${path}.scope`, { pattern: /^(device|user|cohort|tenant)$/, max: 8 }),
    channel,
    bundle_id: id(source.bundle_id, `${path}.bundle_id`),
    release_id: id(source.release_id, `${path}.release_id`),
    feature_profile_id: optionalText(source.feature_profile_id, `${path}.feature_profile_id`, { pattern: ID_PATTERN, max: 160 }),
  });
}

function parseCandidate(value, index) {
  const path = `candidates[${index}]`;
  const source = object(value, path);
  const compatibility = object(source.compatibility, `${path}.compatibility`);
  const reasons = compatibility.reasons;
  if (!Array.isArray(reasons) || reasons.length > 50) fail(`${path}.compatibility.reasons`, "expected a bounded array");
  return Object.freeze({
    bundle_id: id(source.bundle_id, `${path}.bundle_id`),
    release_id: id(source.release_id, `${path}.release_id`),
    channel: text(source.channel, `${path}.channel`, { pattern: /^(stable|preview)$/, max: 7 }),
    source_ref: text(source.source_ref, `${path}.source_ref`, { max: 500 }),
    artifact: parseArtifact(source.artifact, `${path}.artifact`),
    compatibility: Object.freeze({
      eligible: exactBoolean(compatibility.eligible, `${path}.compatibility.eligible`),
      reasons: Object.freeze(reasons.map((reason, reasonIndex) =>
        text(reason, `${path}.compatibility.reasons[${reasonIndex}]`, { max: 500 }))),
    }),
    readiness: Object.freeze(boundedJson(object(source.readiness, `${path}.readiness`), `${path}.readiness`)),
  });
}

function parseReleaseControlView(value) {
  const source = object(value, "view");
  if (source.schema_version !== 1) fail("schema_version", "expected 1");
  if (source.application_id !== APPLICATION_ID) fail("application_id", `expected ${APPLICATION_ID}`);
  const installed = object(source.installed, "installed");
  const installedSurface = text(installed.surface, "installed.surface", { pattern: ID_PATTERN, max: 160 });
  if (installedSurface !== SURFACE) fail("installed.surface", `expected ${SURFACE}`);
  const installedStatus = text(installed.status, "installed.status", {
    pattern: /^(unknown|offered|download_verified|installer_opened|installed|activated|smoked|refused|failed)$/,
    max: 32,
  });
  const channels = object(source.channels, "channels");
  const parsedChannels = {};
  for (const channel of ["stable", "preview"]) {
    if (channels[channel] == null) {
      parsedChannels[channel] = null;
    } else {
      const item = object(channels[channel], `channels.${channel}`);
      parsedChannels[channel] = Object.freeze({
        sequence: integer(item.sequence, `channels.${channel}.sequence`),
        bundle: parseBundle(item.bundle, `channels.${channel}.bundle`),
      });
    }
  }
  if (!Array.isArray(source.candidates) || source.candidates.length > 100) fail("candidates", "expected a bounded array");
  const candidates = source.candidates.map(parseCandidate);
  const candidateKeys = new Set();
  for (const candidate of candidates) {
    const key = `${candidate.bundle_id}:${candidate.release_id}`;
    if (candidateKeys.has(key)) fail("candidates", `duplicate release binding ${key}`);
    candidateKeys.add(key);
  }
  const assignment = source.effective_assignment == null
    ? null
    : parseAssignment(source.effective_assignment, "effective_assignment");
  if (assignment && !candidateKeys.has(`${assignment.bundle_id}:${assignment.release_id}`)) {
    fail("effective_assignment", "release binding is absent from candidates");
  }
  const lastKnownGood = source.last_known_good == null ? null : object(source.last_known_good, "last_known_good");
  return Object.freeze({
    schema_version: 1,
    application_id: APPLICATION_ID,
    installed: Object.freeze({
      surface: installedSurface,
      release_id: id(installed.release_id, "installed.release_id"),
      artifact_sha256: digest(installed.artifact_sha256, "installed.artifact_sha256"),
      version: text(installed.version, "installed.version", { max: 80 }),
      git_sha: text(installed.git_sha, "installed.git_sha", { pattern: /^[a-f0-9]{7,64}$/, max: 64 }),
      status: installedStatus,
    }),
    effective_assignment: assignment,
    channels: Object.freeze(parsedChannels),
    last_known_good: lastKnownGood ? Object.freeze({
      assignment_id: id(lastKnownGood.assignment_id, "last_known_good.assignment_id"),
      bundle_id: id(lastKnownGood.bundle_id, "last_known_good.bundle_id"),
      release_id: id(lastKnownGood.release_id, "last_known_good.release_id"),
    }) : null,
    candidates: Object.freeze(candidates),
  });
}

function parseAssignmentMutationResponse(value) {
  const source = object(value, "assignment response");
  if (source.install_confirmed !== false) {
    fail("assignment response.install_confirmed", "must be false until the platform proves installation");
  }
  const platformActionSource = object(source.platform_action, "assignment response.platform_action");
  const kind = text(platformActionSource.kind, "assignment response.platform_action.kind", {
    pattern: /^(browser_binary_reload_required|none)$/,
    max: 40,
  });
  const artifact = platformActionSource.artifact == null
    ? null
    : parseArtifact(platformActionSource.artifact, "assignment response.platform_action.artifact");
  if (kind === "browser_binary_reload_required" && !artifact) {
    fail("assignment response.platform_action.artifact", "is required for a browser binary reload");
  }
  return Object.freeze({
    assignment_receipt: parseAssignment(source.assignment_receipt, "assignment response.assignment_receipt"),
    effective_assignment: parseAssignment(source.effective_assignment, "assignment response.effective_assignment"),
    platform_action: Object.freeze({ kind, artifact }),
    install_confirmed: false,
  });
}

function candidateForBinding(view, binding) {
  if (!binding) return null;
  return view.candidates.find((candidate) =>
    candidate.bundle_id === binding.bundle_id && candidate.release_id === binding.release_id) || null;
}

function deriveReleaseCockpitState(view, localManifestVersion) {
  const current = view.effective_assignment ? candidateForBinding(view, view.effective_assignment) : null;
  if (view.effective_assignment && !current) fail("effective_assignment", "candidate is unavailable");
  const loadedVersion = text(localManifestVersion, "local manifest version", { max: 80 });
  return Object.freeze({
    current,
    stable: view.channels.stable ? candidateForBinding(view, view.channels.stable.bundle) : null,
    preview: view.channels.preview ? candidateForBinding(view, view.channels.preview.bundle) : null,
    loaded_version: loadedVersion,
    loaded_version_matches_assignment: Boolean(current && loadedVersion === current.artifact.version),
    digest_proven_locally: false,
    install_reload_pending: true,
    feedback_binding_proven: false,
  });
}

function idempotencyKey(prefix, nonce) {
  return `${id(prefix, "idempotency prefix")}_${id(nonce, "idempotency nonce")}`;
}

function buildAssignmentRequest(view, candidate, deviceId, nonce) {
  if (!view.candidates.includes(candidate)) throw new Error("Candidate must come from the parsed release view.");
  if (!candidate.compatibility.eligible) throw new Error("This release is not compatible with this browser.");
  return Object.freeze({
    device_id: id(deviceId, "device_id"),
    surface: SURFACE,
    expected_assignment_sequence: view.effective_assignment?.sequence || 0,
    channel: candidate.channel,
    bundle_id: candidate.bundle_id,
    release_id: candidate.release_id,
    idempotency_key: idempotencyKey("browser_assign", nonce),
  });
}

function buildFallbackRequest(view, deviceId, nonce) {
  if (!view.effective_assignment) throw new Error("No release assignment exists to fall back.");
  return Object.freeze({
    device_id: id(deviceId, "device_id"),
    surface: SURFACE,
    expected_assignment_sequence: view.effective_assignment.sequence,
    idempotency_key: idempotencyKey("browser_fallback", nonce),
  });
}

function buildFeedbackRequest(view, deviceId, textValue, evidenceRefs, localEvidence, nonce) {
  const candidate = candidateForBinding(view, view.effective_assignment);
  if (!candidate) throw new Error("The current assignment has no exact browser artifact.");
  const evidence = object(localEvidence, "local feedback evidence");
  if (evidence.digest_proven !== true
      || evidence.release_id !== candidate.release_id
      || evidence.artifact_sha256 !== candidate.artifact.sha256
      || evidence.version !== candidate.artifact.version
      || !["activated", "smoked"].includes(evidence.status)) {
    throw new Error("Feedback is disabled until the exact assigned browser release is installed and activated.");
  }
  const feedbackText = text(String(textValue || "").trim(), "feedback text", { max: 4000 });
  if (!Array.isArray(evidenceRefs) || evidenceRefs.length > 20) throw new Error("Evidence references must be a bounded array.");
  return Object.freeze({
    assignment_id: view.effective_assignment.assignment_id,
    device_id: id(deviceId, "device_id"),
    bundle_id: candidate.bundle_id,
    release_id: candidate.release_id,
    surface: SURFACE,
    artifact_sha256: candidate.artifact.sha256,
    text: feedbackText,
    evidence_refs: Object.freeze(evidenceRefs.map((ref, index) => text(ref, `evidence_refs[${index}]`, { max: 1000 }))),
    idempotency_key: idempotencyKey("browser_feedback", nonce),
  });
}

function buildInstallReceiptRequest(view, localEvidence, status, nonce) {
  const candidate = candidateForBinding(view, view.effective_assignment);
  const evidence = object(localEvidence, "local install evidence");
  if (!candidate
      || evidence.version !== candidate.artifact.version
      || evidence.artifact_sha256 !== candidate.artifact.sha256
      || evidence.digest_proven !== true) {
    throw new Error("Exact local extension bytes are not proven; no install receipt was created.");
  }
  if (!["activated", "smoked"].includes(status)) throw new Error("Browser install receipt status must be activated or smoked.");
  return Object.freeze({
    device_id: id(evidence.device_id, "local install evidence.device_id"),
    assignment_id: view.effective_assignment.assignment_id,
    bundle_id: candidate.bundle_id,
    release_id: candidate.release_id,
    surface: SURFACE,
    artifact_sha256: candidate.artifact.sha256,
    version: candidate.artifact.version,
    status,
    idempotency_key: idempotencyKey("browser_install", nonce),
  });
}

export {
  APPLICATION_ID,
  SURFACE,
  buildAssignmentRequest,
  buildFallbackRequest,
  buildFeedbackRequest,
  buildInstallReceiptRequest,
  candidateForBinding,
  deriveReleaseCockpitState,
  parseAssignmentMutationResponse,
  parseReleaseControlView,
};
