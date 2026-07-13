"use strict";

const crypto = require("node:crypto");

const FORMAT = "moa-companion-package/v1";
const MANIFEST_SCHEMA = "moa-companion-manifest/v1";
const RECEIPT_SCHEMA = "moa-companion-receipt/v1";
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SPDX_ID = /^[A-Za-z0-9][A-Za-z0-9.+-]{0,63}$/;
const SAFE_PATH = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$/;
const ALLOWED_MEDIA = new Set(["image/png", "audio/wav"]);
const MEDIA_EXTENSIONS = new Map([
  ["image/png", ".png"], ["audio/wav", ".wav"],
]);
const ALLOWED_CAPABILITIES = new Set(["asset.display", "audio.play", "profile.patch.declared", "voice.select"]);
const ALLOWED_PROFILE_FIELDS = new Set([
  "assistant_name", "voice", "voice_max_chars", "response_modality",
  "tool_policy", "autonomy_level", "memory_policy",
]);
const LIMITS = Object.freeze({
  envelopeBytes: 12 * 1024 * 1024,
  manifestBytes: 64 * 1024,
  assets: 32,
  assetBytes: 2 * 1024 * 1024,
  totalAssetBytes: 8 * 1024 * 1024,
  dimension: 4096,
  capabilities: 64,
  profileFields: 24,
});
const VERIFIED_PACKAGES = new WeakSet();

class CompanionPackageError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CompanionPackageError";
    this.code = code;
  }
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value, 0));
}

function canonicalValue(value, depth) {
  if (depth > 16) fail("invalid_shape", "package nesting exceeds 16 levels");
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (Array.isArray(value)) return value.map((item) => canonicalValue(item, depth + 1));
  if (!isPlainObject(value)) fail("invalid_shape", "only plain JSON objects are allowed");
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      fail("invalid_key", `forbidden key: ${key}`);
    }
    out[key] = canonicalValue(value[key], depth + 1);
  }
  return out;
}

function digest(value) {
  return crypto.createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : canonicalJson(value)).digest("hex");
}

function unsignedManifest(manifest) {
  const copy = canonicalValue(manifest, 0);
  delete copy.signature;
  return copy;
}

function signManifest(manifest, { keyId, privateKey }) {
  assertId(keyId, "signer.key_id");
  if (!privateKey) fail("missing_private_key", "private key is required");
  const prepared = { ...manifest, signer: { key_id: keyId, algorithm: "Ed25519" } };
  const bytes = Buffer.from(canonicalJson(unsignedManifest(prepared)));
  return deepFreeze({ ...prepared, signature: crypto.sign(null, bytes, privateKey).toString("base64") });
}

function exportPackage({ manifest, assets }) {
  const envelope = { format: FORMAT, manifest, assets: normalizeAssetBodies(assets) };
  const encoded = Buffer.from(canonicalJson(envelope));
  if (encoded.length > LIMITS.envelopeBytes) fail("envelope_too_large", "package envelope exceeds byte limit");
  return encoded;
}

function importPackage(input, policy = {}) {
  const encoded = Buffer.isBuffer(input) ? input : Buffer.from(String(input || ""), "utf8");
  if (encoded.length === 0 || encoded.length > LIMITS.envelopeBytes) fail("envelope_size", "package envelope size is invalid");
  let envelope;
  try { envelope = JSON.parse(encoded.toString("utf8")); } catch { fail("invalid_json", "package is not valid JSON"); }
  exactKeys(envelope, ["format", "manifest", "assets"], "envelope");
  if (envelope.format !== FORMAT) fail("unsupported_format", "unsupported package format");
  return verifyPackage(envelope, policy);
}

function verifyPackage(envelope, policy = {}) {
  exactKeys(envelope, ["format", "manifest", "assets"], "envelope");
  if (envelope.format !== FORMAT) fail("unsupported_format", "unsupported package format");
  const manifest = validateManifest(envelope.manifest, policy);
  const assets = validateAssets(manifest.assets, envelope.assets);
  verifySignature(manifest, policy);
  const packageDigest = digest({ format: FORMAT, manifest, assets: bodiesAsDigests(assets) });
  if (setOf(policy.revokedPackageDigests).has(packageDigest)) fail("revoked_package", "package digest is revoked");
  const result = deepFreeze({ verified: true, package_digest: packageDigest, manifest, assets });
  VERIFIED_PACKAGES.add(result);
  return result;
}

function validateManifest(input, policy) {
  if (!isPlainObject(input)) fail("invalid_manifest", "manifest must be an object");
  if (Buffer.byteLength(canonicalJson(input)) > LIMITS.manifestBytes) fail("manifest_too_large", "manifest exceeds byte limit");
  exactKeys(input, [
    "schema", "package_id", "version", "created_at", "publisher", "provenance", "license",
    "compatibility", "capabilities", "declared_profile_fields", "profile_patch", "assets",
    "moderation", "signer", "signature",
  ], "manifest");
  if (input.schema !== MANIFEST_SCHEMA) fail("unsupported_manifest", "unsupported manifest schema");
  assertId(input.package_id, "package_id");
  if (!SEMVER.test(input.version || "")) fail("invalid_version", "version must be stable semver");
  assertTimestamp(input.created_at, "created_at");
  validatePublisher(input.publisher);
  validateProvenance(input.provenance);
  validateLicense(input.license, policy);
  validateCompatibility(input.compatibility, policy.currentProtocolVersion);
  validateCapabilities(input.capabilities);
  validateProfilePatch(input.declared_profile_fields, input.profile_patch);
  validateAssetDeclarations(input.assets);
  validateModeration(input.moderation, policy);
  validateSigner(input.signer, input.signature, policy);
  return canonicalValue(input, 0);
}

function validatePublisher(value) {
  exactKeys(value, ["id", "display_name"], "publisher");
  assertId(value.id, "publisher.id");
  assertText(value.display_name, 1, 120, "publisher.display_name");
}

function validateProvenance(value) {
  exactKeys(value, ["source_uri", "source_digest", "author", "created_at"], "provenance");
  assertText(value.source_uri, 1, 500, "provenance.source_uri");
  if (!/^(https:\/\/|urn:)/.test(value.source_uri)) fail("invalid_provenance", "source URI must use https or urn");
  assertDigest(value.source_digest, "provenance.source_digest");
  assertText(value.author, 1, 160, "provenance.author");
  assertTimestamp(value.created_at, "provenance.created_at");
}

function validateLicense(value, policy) {
  exactKeys(value, ["spdx_id", "notice"], "license");
  if (!SPDX_ID.test(value.spdx_id || "")) fail("invalid_license", "license SPDX id is invalid");
  assertText(value.notice, 1, 2000, "license.notice");
  const accepted = setOf(policy.acceptedLicenses);
  if (!accepted.size || !accepted.has(value.spdx_id)) fail("license_not_accepted", "license is not accepted by caller policy");
}

function validateCompatibility(value, current) {
  exactKeys(value, ["protocol", "min_version", "max_version"], "compatibility");
  assertId(value.protocol, "compatibility.protocol");
  if (!SEMVER.test(value.min_version || "") || !SEMVER.test(value.max_version || "")) fail("invalid_compatibility", "compatibility versions must be semver");
  if (compareSemver(value.min_version, value.max_version) > 0) fail("invalid_compatibility", "minimum exceeds maximum");
  if (!SEMVER.test(current || "")) fail("missing_compatibility_policy", "current protocol version is required");
  if (compareSemver(current, value.min_version) < 0 || compareSemver(current, value.max_version) > 0) fail("incompatible", "package is incompatible with current protocol");
}

function validateCapabilities(values) {
  assertUniqueStringArray(values, LIMITS.capabilities, "capabilities");
  for (const value of values) if (!ALLOWED_CAPABILITIES.has(value)) fail("forbidden_capability", `capability is not declarative: ${value}`);
}

function validateProfilePatch(fields, patch) {
  assertUniqueStringArray(fields, LIMITS.profileFields, "declared_profile_fields");
  if (!isPlainObject(patch)) fail("invalid_profile_patch", "profile_patch must be an object");
  for (const field of fields) if (!ALLOWED_PROFILE_FIELDS.has(field)) fail("forbidden_profile_field", `profile field is not package-controlled: ${field}`);
  exactKeys(patch, fields, "profile_patch");
  if (Buffer.byteLength(canonicalJson(patch)) > 16 * 1024) fail("profile_patch_too_large", "profile patch exceeds byte limit");
  for (const [field, value] of Object.entries(patch)) validateProfileValue(field, value);
}

function validateProfileValue(field, value) {
  if (field === "voice_max_chars") return assertInteger(value, 40, 4000, field);
  if (field === "assistant_name") return assertText(value, 1, 80, field);
  if (field === "voice") return assertText(value, 1, 120, field);
  const choices = {
    response_modality: new Set(["auto", "text", "audio"]),
    tool_policy: new Set(["propose_only"]),
    autonomy_level: new Set(["confirm_actions"]),
    memory_policy: new Set(["off", "recall_only", "recall_and_write"]),
  };
  if (!choices[field]?.has(value)) fail("invalid_profile_value", `profile value is not allowed: ${field}`);
}

function validateAssetDeclarations(values) {
  if (!Array.isArray(values) || values.length > LIMITS.assets) fail("asset_count", "asset count exceeds limit");
  const paths = new Set();
  for (const asset of values) {
    exactKeys(asset, ["path", "media_type", "sha256", "size_bytes", "width", "height"], "asset");
    if (!SAFE_PATH.test(asset.path || "") || asset.path.includes("..") || asset.path.includes("//") || asset.path.startsWith("/")) fail("unsafe_asset_path", "asset path is unsafe");
    if (paths.has(asset.path)) fail("duplicate_asset", "asset paths must be unique");
    paths.add(asset.path);
    if (!ALLOWED_MEDIA.has(asset.media_type)) fail("forbidden_media", "asset media type is not allowed");
    const expectedExtension = MEDIA_EXTENSIONS.get(asset.media_type);
    const normalizedPath = asset.path.toLowerCase();
    const extensionMatches = normalizedPath.endsWith(expectedExtension);
    if (!extensionMatches) fail("media_path_mismatch", "asset path extension does not match media type");
    assertDigest(asset.sha256, "asset.sha256");
    assertInteger(asset.size_bytes, 0, LIMITS.assetBytes, "asset.size_bytes");
    for (const field of ["width", "height"]) {
      if (asset[field] !== null) assertInteger(asset[field], 1, LIMITS.dimension, `asset.${field}`);
    }
  }
}

function validateModeration(value, policy) {
  exactKeys(value, ["status", "policy_version", "review_id"], "moderation");
  if (value.status !== "approved") fail("moderation_required", "package moderation is not approved");
  assertId(value.policy_version, "moderation.policy_version");
  assertId(value.review_id, "moderation.review_id");
  const versions = setOf(policy.acceptedModerationPolicies);
  if (!versions.size || !versions.has(value.policy_version)) fail("moderation_policy_untrusted", "moderation policy is not accepted by caller");
}

function validateSigner(value, signature, policy) {
  exactKeys(value, ["key_id", "algorithm"], "signer");
  assertId(value.key_id, "signer.key_id");
  if (value.algorithm !== "Ed25519") fail("unsupported_signature", "only Ed25519 is supported");
  assertText(signature, 1, 256, "signature");
  if (setOf(policy.revokedSignerIds).has(value.key_id)) fail("revoked_signer", "signer is revoked");
}

function verifySignature(manifest, policy) {
  const trustStore = policy.trustStore instanceof Map ? policy.trustStore : new Map(Object.entries(policy.trustStore || {}));
  const publicKey = trustStore.get(manifest.signer.key_id);
  if (!publicKey) fail("unknown_signer", "signer is not in caller trust store");
  let signature;
  try { signature = Buffer.from(manifest.signature, "base64"); } catch { fail("invalid_signature", "signature is malformed"); }
  if (signature.length !== 64 || !crypto.verify(null, Buffer.from(canonicalJson(unsignedManifest(manifest))), publicKey, signature)) {
    fail("invalid_signature", "manifest signature verification failed");
  }
}

function validateAssets(declarations, bodies) {
  if (!isPlainObject(bodies)) fail("invalid_assets", "asset bodies must be an object");
  exactKeys(bodies, declarations.map((item) => item.path), "assets");
  let total = 0;
  const out = {};
  for (const declaration of declarations) {
    const encoded = bodies[declaration.path];
    if (typeof encoded !== "string" || encoded.length > Math.ceil(LIMITS.assetBytes / 3) * 4 + 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) fail("invalid_asset_body", `invalid base64 body: ${declaration.path}`);
    const bytes = Buffer.from(encoded, "base64");
    total += bytes.length;
    if (bytes.length !== declaration.size_bytes || digest(bytes) !== declaration.sha256) fail("asset_tamper", `asset does not match declaration: ${declaration.path}`);
    validateMediaBytes(declaration, bytes);
    if (total > LIMITS.totalAssetBytes) fail("assets_too_large", "total asset bytes exceed limit");
    out[declaration.path] = encoded;
  }
  return out;
}

function validateMediaBytes(declaration, bytes) {
  const type = declaration.media_type;
  let dimensions = null;
  if (type === "image/png") {
    dimensions = validatePng(bytes);
  } else if (type === "audio/wav") {
    validateWav(bytes);
  }
  if (dimensions) {
    if (dimensions.some((value) => !Number.isSafeInteger(value) || value < 1 || value > LIMITS.dimension)) fail("media_dimensions", "decoded image dimensions exceed limits");
    if (declaration.width !== dimensions[0] || declaration.height !== dimensions[1]) fail("media_dimensions", "declared image dimensions do not match bytes");
  } else if (declaration.width !== null || declaration.height !== null) {
    fail("media_dimensions", "audio assets cannot declare image dimensions");
  }
}

function validatePng(bytes) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(signature)) fail("media_content_mismatch", "asset bytes are not a complete PNG image");
  let offset = 8;
  let dimensions;
  let sawData = false;
  let sawEnd = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) fail("media_content_mismatch", "PNG chunk exceeds asset bounds");
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const chunk = bytes.subarray(offset + 4, offset + 8 + length);
    if (crc32(chunk) !== bytes.readUInt32BE(offset + 8 + length)) fail("media_content_mismatch", "PNG chunk checksum is invalid");
    if (!dimensions) {
      if (type !== "IHDR" || length !== 13) fail("media_content_mismatch", "PNG must begin with one IHDR chunk");
      dimensions = [bytes.readUInt32BE(offset + 8), bytes.readUInt32BE(offset + 12)];
    } else if (type === "IHDR") fail("media_content_mismatch", "PNG contains duplicate IHDR");
    if (type === "IDAT") sawData = true;
    if (type === "IEND") {
      if (length !== 0 || end !== bytes.length) fail("media_content_mismatch", "PNG IEND must terminate the asset");
      sawEnd = true;
      offset = end;
      break;
    }
    offset = end;
  }
  if (!dimensions || !sawData || !sawEnd || offset !== bytes.length) fail("media_content_mismatch", "PNG container is incomplete");
  return dimensions;
}

function validateWav(bytes) {
  if (bytes.length < 44 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE" || bytes.readUInt32LE(4) !== bytes.length - 8) fail("media_content_mismatch", "asset bytes are not a complete WAV container");
  let offset = 12;
  let sawFormat = false;
  let sawData = false;
  while (offset + 8 <= bytes.length) {
    const type = bytes.toString("ascii", offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const end = offset + 8 + length;
    if (end > bytes.length) fail("media_content_mismatch", "WAV chunk exceeds asset bounds");
    if (type === "fmt ") {
      if (sawFormat || sawData || length !== 16) fail("media_content_mismatch", "WAV format chunk is invalid");
      const format = bytes.readUInt16LE(offset + 8);
      const channels = bytes.readUInt16LE(offset + 10);
      const sampleRate = bytes.readUInt32LE(offset + 12);
      const bitsPerSample = bytes.readUInt16LE(offset + 22);
      if (format !== 1 || channels < 1 || channels > 8 || sampleRate < 8000 || sampleRate > 192000 || ![8, 16, 24, 32].includes(bitsPerSample)) fail("media_content_mismatch", "WAV PCM parameters are invalid");
      sawFormat = true;
    } else if (type === "data") {
      if (!sawFormat || sawData || end + (length % 2) !== bytes.length) fail("media_content_mismatch", "WAV data chunk is invalid");
      sawData = true;
    } else fail("media_content_mismatch", "WAV contains an unsupported chunk");
    offset = end + (length % 2);
  }
  if (!sawFormat || !sawData || offset !== bytes.length) fail("media_content_mismatch", "WAV container is incomplete");
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createLifecycleReceipt(kind, input) {
  if (!["preview", "apply_plan", "revert_plan"].includes(kind)) fail("invalid_receipt_kind", "invalid lifecycle receipt kind");
  const verified = input.verified_package;
  if (!verified || !VERIFIED_PACKAGES.has(verified)) fail("unverified_package", "lifecycle receipts require this verifier's package result");
  assertTimestamp(input.created_at, "created_at");
  const fields = verified.manifest.declared_profile_fields;
  const previous = input.previous_receipt;
  if (kind === "preview" && previous !== undefined) fail("invalid_receipt_chain", "preview cannot have a previous receipt");
  if (kind !== "preview") {
    validateReceipt(previous);
    const expectedKind = kind === "apply_plan" ? "preview" : "apply_plan";
    if (previous.kind !== expectedKind || previous.package_digest !== verified.package_digest) fail("invalid_receipt_chain", "receipt chain kind or package does not match");
    if (Date.parse(input.created_at) <= Date.parse(previous.created_at)) fail("invalid_receipt_chain", "receipt timestamps must increase");
  }
  const body = canonicalValue({
    schema: RECEIPT_SCHEMA,
    kind,
    package_digest: verified.package_digest,
    package_id: verified.manifest.package_id,
    version: verified.manifest.version,
    created_at: input.created_at,
    declared_profile_fields: fields,
    mutates_profile: false,
    previous_receipt_digest: kind === "preview" ? null : previous.receipt_digest,
  }, 0);
  const receipt = deepFreeze({ ...body, receipt_digest: digest(body) });
  return receipt;
}

function validateReceipt(receipt) {
  exactKeys(receipt, ["schema", "kind", "package_digest", "package_id", "version", "created_at", "declared_profile_fields", "mutates_profile", "previous_receipt_digest", "receipt_digest"], "receipt");
  if (receipt.schema !== RECEIPT_SCHEMA || !["preview", "apply_plan", "revert_plan"].includes(receipt.kind) || receipt.mutates_profile !== false) fail("invalid_receipt_chain", "receipt schema or kind is invalid");
  assertDigest(receipt.package_digest, "receipt.package_digest");
  assertId(receipt.package_id, "receipt.package_id");
  if (!SEMVER.test(receipt.version || "")) fail("invalid_receipt_chain", "receipt version is invalid");
  assertTimestamp(receipt.created_at, "receipt.created_at");
  assertUniqueStringArray(receipt.declared_profile_fields, LIMITS.profileFields, "receipt.declared_profile_fields");
  if (receipt.previous_receipt_digest !== null) assertDigest(receipt.previous_receipt_digest, "receipt.previous_receipt_digest");
  const body = { ...receipt };
  delete body.receipt_digest;
  if (digest(body) !== receipt.receipt_digest) fail("invalid_receipt_chain", "receipt digest does not match content");
}

function normalizeAssetBodies(assets) {
  if (!isPlainObject(assets)) fail("invalid_assets", "assets must be an object");
  return canonicalValue(assets, 0);
}

function bodiesAsDigests(assets) {
  return Object.fromEntries(Object.entries(assets).map(([name, body]) => [name, digest(Buffer.from(body, "base64"))]));
}

function exactKeys(value, expected, label) {
  if (!isPlainObject(value)) fail("invalid_shape", `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) fail("unknown_or_missing_field", `${label} fields do not match schema`);
}

function assertUniqueStringArray(value, max, label) {
  if (!Array.isArray(value) || value.length > max || value.some((item) => typeof item !== "string" || item.length < 1 || item.length > 100) || new Set(value).size !== value.length) fail("invalid_list", `${label} must be a bounded unique string list`);
}

function assertId(value, label) { if (typeof value !== "string" || !SAFE_ID.test(value)) fail("invalid_id", `${label} is invalid`); }
function assertDigest(value, label) { if (typeof value !== "string" || !SHA256.test(value)) fail("invalid_digest", `${label} is invalid`); }
function assertText(value, min, max, label) { if (typeof value !== "string" || value.length < min || value.length > max) fail("invalid_text", `${label} is invalid`); }
function assertTimestamp(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) fail("invalid_timestamp", `${label} is invalid`);
  const parsed = new Date(value);
  const normalized = value.includes(".") ? value : value.replace("Z", ".000Z");
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== normalized) fail("invalid_timestamp", `${label} is invalid`);
}
function assertInteger(value, min, max, label) { if (!Number.isSafeInteger(value) || value < min || value > max) fail("invalid_integer", `${label} is invalid`); }
function compareSemver(a, b) { const aa = a.split(".").map(Number); const bb = b.split(".").map(Number); return aa[0] - bb[0] || aa[1] - bb[1] || aa[2] - bb[2]; }
function setOf(value) { return new Set(Array.isArray(value) || value instanceof Set ? value : []); }
function isPlainObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function fail(code, message) { throw new CompanionPackageError(code, message); }
function deepFreeze(value) { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child); } return value; }

module.exports = {
  FORMAT,
  MANIFEST_SCHEMA,
  RECEIPT_SCHEMA,
  LIMITS,
  CompanionPackageError,
  canonicalJson,
  digest,
  signManifest,
  exportPackage,
  importPackage,
  verifyPackage,
  createLifecycleReceipt,
};
