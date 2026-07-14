"use strict";

// Shared release selection is deliberately a planning boundary. This module
// validates immutable release metadata and decides whether a client is eligible
// to receive an artifact. It never downloads an artifact or invokes an
// installer.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const REGISTRY_SCHEMA = "moa-release-registry/v1";
const RELEASE_SCHEMA = "moa-release/v1";
const MAX_RELEASES = 10_000;
const MAX_NOTES_CHARS = 8_192;
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const GIT_SHA_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;

class ReleaseValidationError extends Error {
  constructor(code, message, field) {
    super(message);
    this.name = "ReleaseValidationError";
    this.code = code;
    if (field) this.field = field;
  }
}

function createReleaseRegistry(options = {}) {
  const adapter = options.adapter || createInMemoryReleaseAdapter();
  const now = typeof options.now === "function" ? options.now : () => Date.now();

  function list(query = {}) {
    return readAll(adapter)
      .filter((release) => matchesQuery(release, query))
      .sort(compareReleases)
      .map(copy);
  }

  function get(releaseId) {
    const id = cleanId(releaseId, "release_id");
    const found = readAll(adapter).find((release) => release.release_id === id);
    return found ? copy(found) : null;
  }

  function publish(input) {
    const release = validateRelease(input);
    const releases = readAll(adapter);
    const sameId = releases.find((item) => item.release_id === release.release_id);
    if (sameId) {
      if (canonicalJson(sameId) !== canonicalJson(release)) {
        throw validationError("immutable_release", "release_id already names different metadata", "release_id");
      }
      return copy(sameId);
    }
    if (releases.some((item) => releaseCoordinate(item) === releaseCoordinate(release))) {
      throw validationError("duplicate_build", "a release already exists for this key and monotonic_build", "monotonic_build");
    }
    if (releases.length >= MAX_RELEASES) {
      throw validationError("registry_full", `registry cannot exceed ${MAX_RELEASES} releases`);
    }
    adapter.write([...releases, release].map(copy));
    return copy(release);
  }

  function check(input = {}) {
    const key = normalizeKey(input);
    const candidates = list(key).sort((a, b) => b.monotonic_build - a.monotonic_build);
    if (!candidates.length) return decision("no_release", "no_release_for_key");
    const release = candidates[0];
    return evaluateReleaseEligibility({ ...input, release, now: now() });
  }

  function planRollback(input = {}) {
    const currentId = cleanId(input.current_release_id, "current_release_id");
    const current = get(currentId);
    if (!current) return decision("incompatible", "current_release_not_found");
    if (!current.rollback_release) return decision("incompatible", "rollback_not_declared", current);
    const target = get(current.rollback_release);
    if (!target) return decision("incompatible", "rollback_release_not_found", current);
    if (releaseKey(target) !== releaseKey(current)) {
      return decision("verification_failed", "rollback_key_mismatch", target);
    }
    if (target.monotonic_build >= current.monotonic_build) {
      return decision("verification_failed", "rollback_must_target_older_build", target);
    }
    return evaluateReleaseEligibility({
      ...input,
      release: target,
      current_release_id: current.release_id,
      current_build: current.monotonic_build,
      allow_downgrade: true,
      operation: "rollback",
      now: now(),
    });
  }

  return Object.freeze({ list, get, publish, check, planRollback });
}

function evaluateReleaseEligibility(input = {}) {
  let release;
  try {
    release = validateRelease(input.release);
  } catch (error) {
    if (error instanceof ReleaseValidationError) {
      return decision("verification_failed", error.code, null, { field: error.field || null });
    }
    throw error;
  }

  let key;
  try {
    key = normalizeKey(input);
  } catch (error) {
    if (error instanceof ReleaseValidationError) {
      return decision("incompatible", error.code, release, { field: error.field || null });
    }
    throw error;
  }
  if (releaseKey(release) !== releaseKey(key)) return decision("incompatible", "release_key_mismatch", release);

  let protocol;
  let currentBuild;
  try {
    protocol = integer(input.protocol_version, "protocol_version", { min: 0 });
    currentBuild = optionalInteger(input.current_build, "current_build", { min: 0 }) ?? 0;
  } catch (error) {
    if (error instanceof ReleaseValidationError) {
      return decision("incompatible", error.code, release, { field: error.field || null });
    }
    throw error;
  }
  if (protocol < release.protocol.min || protocol > release.protocol.max) {
    return decision("incompatible", "protocol_out_of_range", release, {
      required_protocol: copy(release.protocol),
    });
  }

  const operation = input.operation === "rollback" ? "rollback" : "upgrade";
  if (release.monotonic_build < currentBuild && !(input.allow_downgrade === true && operation === "rollback")) {
    return decision("incompatible", "downgrade_not_authorized", release);
  }
  if (release.monotonic_build === currentBuild) {
    return decision("up_to_date", "installed_build_is_current", release);
  }

  if (release.rollout.percentage < 100) {
    const installationId = String(input.installation_id || "").trim();
    if (!installationId) return decision("incompatible", "installation_id_required_for_rollout", release);
    const bucket = stableRolloutBucket(installationId, release.rollout.salt);
    if (bucket >= release.rollout.percentage) {
      return decision("deferred", "outside_rollout_cohort", release, {
        rollout_bucket: bucket,
        rollout_percentage: release.rollout.percentage,
      });
    }
  }

  return decision("eligible", operation === "rollback" ? "authorized_rollback" : "newer_compatible_release", release, {
    operation,
  });
}

function validateRelease(input) {
  if (!isPlainObject(input)) throw validationError("invalid_release", "release must be an object");
  rejectUnknown(input, [
    "schema_version", "release_id", "app_id", "platform", "arch", "channel",
    "semantic_version", "monotonic_build", "protocol", "git_sha", "artifact_url",
    "size", "sha256", "signature", "provenance", "published_at", "rollout",
    "mandatory", "rollback_release", "release_notes",
  ], "release");

  const schemaVersion = input.schema_version == null ? RELEASE_SCHEMA : String(input.schema_version);
  if (schemaVersion !== RELEASE_SCHEMA) throw validationError("unsupported_schema", "unsupported release schema", "schema_version");
  const appId = cleanId(input.app_id, "app_id");
  const platform = cleanId(input.platform, "platform");
  const arch = cleanId(input.arch, "arch");
  const channel = cleanId(input.channel, "channel");
  const semanticVersion = cleanSemver(input.semantic_version);
  const monotonicBuild = integer(input.monotonic_build, "monotonic_build", { min: 1, max: Number.MAX_SAFE_INTEGER });
  const protocol = cleanProtocol(input.protocol);
  const gitSha = cleanPattern(input.git_sha, "git_sha", GIT_SHA_PATTERN);
  const artifactUrl = cleanHttpsUrl(input.artifact_url, "artifact_url");
  const size = integer(input.size, "size", { min: 1, max: Number.MAX_SAFE_INTEGER });
  const sha256 = cleanPattern(input.sha256, "sha256", SHA256_PATTERN);
  const signature = cleanSignature(input.signature);
  const provenance = cleanProvenance(input.provenance);
  const publishedAt = cleanTimestamp(input.published_at, "published_at");
  const rollout = cleanRollout(input.rollout);
  const mandatory = boolean(input.mandatory, "mandatory");
  const rollbackRelease = input.rollback_release == null ? null : cleanId(input.rollback_release, "rollback_release");
  const releaseNotes = cleanReleaseNotes(input.release_notes);
  const releaseId = input.release_id == null
    ? `${appId}-${platform}-${arch}-${channel}-${monotonicBuild}`
    : cleanId(input.release_id, "release_id");

  if (rollbackRelease === releaseId) throw validationError("invalid_rollback", "release cannot roll back to itself", "rollback_release");

  return deepFreeze({
    schema_version: RELEASE_SCHEMA,
    release_id: releaseId,
    app_id: appId,
    platform,
    arch,
    channel,
    semantic_version: semanticVersion,
    monotonic_build: monotonicBuild,
    protocol,
    git_sha: gitSha,
    artifact_url: artifactUrl,
    size,
    sha256,
    signature,
    provenance,
    published_at: publishedAt,
    rollout,
    mandatory,
    rollback_release: rollbackRelease,
    release_notes: releaseNotes,
  });
}

function createInMemoryReleaseAdapter(initialReleases = []) {
  let releases = initialReleases.map(validateRelease);
  return Object.freeze({
    read: () => releases.map(copy),
    write: (next) => { releases = next.map(validateRelease); },
  });
}

function createFileReleaseAdapter(filePath) {
  const target = path.resolve(String(filePath || ""));
  if (!filePath) throw validationError("invalid_file_path", "filePath is required", "filePath");
  return Object.freeze({
    read() {
      if (!fs.existsSync(target)) return [];
      let parsed;
      try {
        parsed = JSON.parse(fs.readFileSync(target, "utf8"));
      } catch (error) {
        throw validationError("invalid_registry_file", `release registry cannot be read: ${error.message}`);
      }
      if (!isPlainObject(parsed) || parsed.schema_version !== REGISTRY_SCHEMA || !Array.isArray(parsed.releases)) {
        throw validationError("invalid_registry_file", "release registry has an unsupported shape");
      }
      if (parsed.releases.length > MAX_RELEASES) throw validationError("registry_full", "release registry exceeds its bound");
      return parsed.releases.map(validateRelease);
    },
    write(releases) {
      if (!Array.isArray(releases) || releases.length > MAX_RELEASES) {
        throw validationError("registry_full", "release registry exceeds its bound");
      }
      const validated = releases.map(validateRelease);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const temp = `${target}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
      fs.writeFileSync(temp, `${JSON.stringify({ schema_version: REGISTRY_SCHEMA, releases: validated }, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temp, target);
    },
  });
}

function cleanProtocol(value) {
  if (!isPlainObject(value)) throw validationError("invalid_protocol", "protocol must contain min and max", "protocol");
  rejectUnknown(value, ["min", "max"], "protocol");
  const min = integer(value.min, "protocol.min", { min: 0 });
  const max = integer(value.max, "protocol.max", { min: 0 });
  if (min > max) throw validationError("invalid_protocol", "protocol.min cannot exceed protocol.max", "protocol");
  return { min, max };
}

function cleanSignature(value) {
  if (!isPlainObject(value)) throw validationError("malformed_signature", "signature metadata is required", "signature");
  rejectUnknown(value, ["algorithm", "key_id", "value"], "signature");
  const algorithm = String(value.algorithm || "").toLowerCase();
  if (algorithm !== "ed25519") throw validationError("malformed_signature", "signature.algorithm must be ed25519", "signature.algorithm");
  const keyId = cleanId(value.key_id, "signature.key_id");
  const encoded = String(value.value || "");
  if (!/^[A-Za-z0-9+/]{86}==$/.test(encoded)) {
    throw validationError("malformed_signature", "signature.value must be a canonical base64 Ed25519 signature", "signature.value");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length !== 64 || bytes.toString("base64") !== encoded) {
    throw validationError("malformed_signature", "signature.value must decode to 64 bytes", "signature.value");
  }
  return { algorithm, key_id: keyId, value: encoded };
}

function cleanProvenance(value) {
  if (!isPlainObject(value)) throw validationError("invalid_provenance", "provenance metadata is required", "provenance");
  rejectUnknown(value, ["builder", "source_url", "attestation_url", "attestation_sha256"], "provenance");
  const builder = cleanBoundedText(value.builder, "provenance.builder", 256);
  const sourceUrl = cleanHttpsUrl(value.source_url, "provenance.source_url");
  const attestationUrl = value.attestation_url == null ? null : cleanHttpsUrl(value.attestation_url, "provenance.attestation_url");
  const attestationSha256 = value.attestation_sha256 == null
    ? null
    : cleanPattern(value.attestation_sha256, "provenance.attestation_sha256", SHA256_PATTERN);
  if ((attestationUrl == null) !== (attestationSha256 == null)) {
    throw validationError("invalid_provenance", "attestation_url and attestation_sha256 must be provided together", "provenance");
  }
  return { builder, source_url: sourceUrl, attestation_url: attestationUrl, attestation_sha256: attestationSha256 };
}

function cleanRollout(value) {
  if (!isPlainObject(value)) throw validationError("invalid_rollout", "rollout metadata is required", "rollout");
  rejectUnknown(value, ["percentage", "salt"], "rollout");
  const percentage = Number(value.percentage);
  if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) {
    throw validationError("invalid_rollout", "rollout.percentage must be between 0 and 100", "rollout.percentage");
  }
  const salt = cleanBoundedText(value.salt, "rollout.salt", 256);
  return { percentage, salt };
}

function cleanReleaseNotes(value) {
  if (typeof value === "string") return { summary: cleanBoundedText(value, "release_notes", MAX_NOTES_CHARS), url: null };
  if (!isPlainObject(value)) throw validationError("invalid_release_notes", "release_notes must be text or an object", "release_notes");
  rejectUnknown(value, ["summary", "url"], "release_notes");
  const summary = cleanBoundedText(value.summary, "release_notes.summary", MAX_NOTES_CHARS);
  const url = value.url == null ? null : cleanHttpsUrl(value.url, "release_notes.url");
  return { summary, url };
}

function normalizeKey(value) {
  return {
    app_id: cleanId(value.app_id, "app_id"),
    platform: cleanId(value.platform, "platform"),
    arch: cleanId(value.arch, "arch"),
    channel: cleanId(value.channel, "channel"),
  };
}

function releaseKey(value) {
  const key = normalizeKey(value);
  return [key.app_id, key.platform, key.arch, key.channel].join("/");
}

function stableRolloutBucket(installationId, salt) {
  const id = cleanBoundedText(installationId, "installation_id", 512);
  const cleanSalt = cleanBoundedText(salt, "rollout.salt", 256);
  const digest = crypto.createHash("sha256").update(`${cleanSalt}\0${id}`, "utf8").digest();
  return digest.readUInt32BE(0) / 0x100000000 * 100;
}

function compareSemanticVersions(left, right) {
  const a = parseSemver(cleanSemver(left));
  const b = parseSemver(cleanSemver(right));
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] < b.core[index] ? -1 : 1;
  }
  if (a.pre.length === 0 && b.pre.length === 0) return 0;
  if (a.pre.length === 0) return 1;
  if (b.pre.length === 0) return -1;
  const length = Math.max(a.pre.length, b.pre.length);
  for (let index = 0; index < length; index += 1) {
    if (a.pre[index] == null) return -1;
    if (b.pre[index] == null) return 1;
    if (a.pre[index] === b.pre[index]) continue;
    const aNumber = /^\d+$/.test(a.pre[index]);
    const bNumber = /^\d+$/.test(b.pre[index]);
    if (aNumber && bNumber) return Number(a.pre[index]) < Number(b.pre[index]) ? -1 : 1;
    if (aNumber !== bNumber) return aNumber ? -1 : 1;
    return a.pre[index] < b.pre[index] ? -1 : 1;
  }
  return 0;
}

function decision(status, reason, release = null, extra = {}) {
  return deepFreeze({
    status,
    reason,
    release: release ? copy(release) : null,
    install_performed: false,
    ...extra,
  });
}

function matchesQuery(release, query) {
  return ["app_id", "platform", "arch", "channel"].every((field) => query[field] == null || release[field] === String(query[field]));
}

function releaseCoordinate(release) {
  return `${releaseKey(release)}/${release.monotonic_build}`;
}

function compareReleases(left, right) {
  return releaseKey(left).localeCompare(releaseKey(right)) || left.monotonic_build - right.monotonic_build;
}

function readAll(adapter) {
  if (!adapter || typeof adapter.read !== "function" || typeof adapter.write !== "function") {
    throw validationError("invalid_adapter", "release adapter must implement read() and write(releases)");
  }
  const releases = adapter.read();
  if (!Array.isArray(releases) || releases.length > MAX_RELEASES) throw validationError("invalid_adapter", "adapter returned an invalid release list");
  return releases.map(validateRelease);
}

function rejectUnknown(object, allowed, field) {
  const unknown = Object.keys(object).filter((key) => !allowed.includes(key));
  if (unknown.length) throw validationError("unknown_field", `${field} contains unknown field ${unknown[0]}`, `${field}.${unknown[0]}`);
}

function cleanId(value, field) {
  const text = String(value || "").trim().toLowerCase();
  if (!ID_PATTERN.test(text)) throw validationError("invalid_id", `${field} is invalid`, field);
  return text;
}

function cleanSemver(value) {
  const text = String(value || "").trim();
  if (!SEMVER_PATTERN.test(text)) throw validationError("invalid_semantic_version", "semantic_version must be valid SemVer", "semantic_version");
  return text;
}

function parseSemver(value) {
  const match = SEMVER_PATTERN.exec(value);
  return { core: match.slice(1, 4).map(Number), pre: match[4] ? match[4].split(".") : [] };
}

function cleanPattern(value, field, pattern) {
  const text = String(value || "").trim().toLowerCase();
  if (!pattern.test(text)) throw validationError(`invalid_${field.replace(/\./g, "_")}`, `${field} is invalid`, field);
  return text;
}

function cleanHttpsUrl(value, field) {
  let parsed;
  try { parsed = new URL(String(value || "")); } catch { throw validationError("invalid_url", `${field} must be a valid HTTPS URL`, field); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw validationError("invalid_url", `${field} must be an HTTPS URL without credentials`, field);
  }
  return parsed.toString();
}

function cleanTimestamp(value, field) {
  const text = String(value || "");
  const time = Date.parse(text);
  if (!Number.isFinite(time) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(text)) {
    throw validationError("invalid_timestamp", `${field} must be RFC3339 UTC`, field);
  }
  return new Date(time).toISOString();
}

function cleanBoundedText(value, field, max) {
  const text = String(value || "").trim();
  if (!text || text.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) {
    throw validationError("invalid_text", `${field} must contain 1-${max} safe characters`, field);
  }
  return text;
}

function integer(value, field, bounds = {}) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < (bounds.min ?? Number.MIN_SAFE_INTEGER) || number > (bounds.max ?? Number.MAX_SAFE_INTEGER)) {
    throw validationError("invalid_integer", `${field} must be a bounded safe integer`, field);
  }
  return number;
}

function optionalInteger(value, field, bounds) {
  return value == null ? null : integer(value, field, bounds);
}

function boolean(value, field) {
  if (typeof value !== "boolean") throw validationError("invalid_boolean", `${field} must be boolean`, field);
  return value;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function validationError(code, message, field) {
  return new ReleaseValidationError(code, message, field);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isPlainObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

module.exports = {
  REGISTRY_SCHEMA,
  RELEASE_SCHEMA,
  ReleaseValidationError,
  compareSemanticVersions,
  createFileReleaseAdapter,
  createInMemoryReleaseAdapter,
  createMemoryReleaseAdapter: createInMemoryReleaseAdapter,
  createReleaseRegistry,
  evaluateReleaseEligibility,
  releaseKey,
  stableRolloutBucket,
  validateRelease,
};
