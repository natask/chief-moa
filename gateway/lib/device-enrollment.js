"use strict";

const crypto = require("node:crypto");

const CAPABILITY_PREFIX = "ag_enroll_v1";
const DEVICE_TOKEN_PREFIX = "ag_dev_v1";
const CAPABILITY_PATTERN = /^ag_enroll_v1\.[A-Za-z0-9_-]{43}$/;
const DEVICE_TOKEN_PATTERN = /^ag_dev_v1\.[A-Za-z0-9_-]{43}$/;
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const ALLOWED_APPLICATIONS = new Set(["ag.companion"]);
const ALLOWED_SURFACES = new Set(["android", "browser_extension", "desktop"]);
const DEFAULT_TTL_MS = 5 * 60 * 1000;
const MAX_TTL_MS = 10 * 60 * 1000;

function createDeviceEnrollmentService(options = {}) {
  const store = options.store;
  if (!store || typeof store.insertCapability !== "function"
      || typeof store.exchangeCapability !== "function") {
    throw new Error("device enrollment store is required");
  }
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const randomBytes = typeof options.randomBytes === "function" ? options.randomBytes : crypto.randomBytes;

  async function issue(input = {}) {
    const issuedAtMs = validTime(now());
    const tenantId = requiredId(input.tenant_id, "tenant_id");
    const ownerId = requiredId(input.owner_id, "owner_id");
    const deviceId = requiredId(input.device_id, "device_id");
    const surfaceId = requiredSet(input.surface_id, "surface_id", ALLOWED_SURFACES);
    const applicationId = requiredSet(input.application_id, "application_id", ALLOWED_APPLICATIONS);
    const ttlMs = boundedTtl(input.ttl_ms);
    const capability = `${CAPABILITY_PREFIX}.${randomBytes(32).toString("base64url")}`;
    const record = Object.freeze({
      capability_id: `enrc_${digest(capability).slice(0, 32)}`,
      capability_hash: digest(capability),
      binding_key: digest(`${tenantId}\0${deviceId}\0${surfaceId}\0${applicationId}`),
      tenant_id: tenantId,
      owner_id: ownerId,
      device_id: deviceId,
      surface_id: surfaceId,
      application_id: applicationId,
      scopes: scopesFor(applicationId, surfaceId),
      issued_at: new Date(issuedAtMs).toISOString(),
      expires_at: new Date(issuedAtMs + ttlMs).toISOString(),
    });
    if (!await store.insertCapability(record)) {
      throw enrollmentError("enrollment_conflict", "could not issue enrollment capability");
    }
    return Object.freeze({
      schema_version: 1,
      enrollment_capability: capability,
      enrollment: publicCapability(record),
    });
  }

  async function exchange(input = {}) {
    const exchangedAtMs = validTime(now());
    const capability = requiredSecret(input.enrollment_capability, CAPABILITY_PATTERN,
      "invalid_enrollment_capability");
    const credential = requiredSecret(input.credential_token, DEVICE_TOKEN_PATTERN,
      "invalid_device_credential");
    const result = await store.exchangeCapability({
      capability_hash: digest(capability),
      credential_hash: digest(credential),
      exchanged_at: new Date(exchangedAtMs).toISOString(),
    });
    if (!result) throw enrollmentError("invalid_enrollment_capability", "enrollment capability is invalid");
    if (result.error) throw enrollmentError(result.error, messageFor(result.error));
    return Object.freeze({
      schema_version: 1,
      device_credential: Object.freeze({
        credential_id: result.credential_id,
        device_id: result.device_id,
        surface_id: result.surface_id,
        application_id: result.application_id,
        scopes: Object.freeze([...result.scopes]),
        created_at: result.created_at,
      }),
      continuity: Object.freeze({
        account_id: result.owner_id,
        tenant_id: result.tenant_id,
        restore: Object.freeze(["conversations", "sessions", "runs", "profile"]),
        local_state_transferred: false,
      }),
    });
  }

  return Object.freeze({ issue, exchange });
}

function createMemoryDeviceEnrollmentStore() {
  const capabilities = new Map();
  const credentialHashes = new Set();
  return Object.freeze({
    async insertCapability(record) {
      if (capabilities.has(record.capability_hash)) return false;
      capabilities.set(record.capability_hash, { ...record, consumed_at: null });
      return true;
    },
    async exchangeCapability(input) {
      const record = capabilities.get(input.capability_hash);
      if (!record) return null;
      if (record.consumed_at) return { error: "enrollment_capability_consumed" };
      if (Date.parse(record.expires_at) < Date.parse(input.exchanged_at)) {
        return { error: "enrollment_capability_expired" };
      }
      if (credentialHashes.has(input.credential_hash)) return { error: "device_credential_conflict" };
      record.consumed_at = input.exchanged_at;
      credentialHashes.add(input.credential_hash);
      return credentialResult(record, input.credential_hash, input.exchanged_at);
    },
  });
}

function createPostgresDeviceEnrollmentStore(pool) {
  if (!pool || typeof pool.query !== "function") throw new Error("Postgres pool is required");
  return Object.freeze({
    async insertCapability(record) {
      const result = await pool.query(
        `insert into device_enrollment_capabilities
          (capability_id, capability_hash, binding_key, tenant_id, owner_id, device_id,
           surface_id, application_id, scopes, issued_at, expires_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         on conflict do nothing returning capability_id`,
        [record.capability_id, record.capability_hash, record.binding_key,
          record.tenant_id, record.owner_id,
          record.device_id, record.surface_id, record.application_id, record.scopes,
          record.issued_at, record.expires_at],
      );
      return result.rowCount === 1;
    },
    async exchangeCapability(input) {
      const result = await pool.query(
        "select * from exchange_device_enrollment_capability($1,$2,$3)",
        [input.capability_hash, input.credential_hash, input.exchanged_at],
      );
      return normalizeExchangeRow(result.rows?.[0]);
    },
  });
}

function publicCapability(record) {
  return Object.freeze({
    capability_id: record.capability_id,
    device_id: record.device_id,
    surface_id: record.surface_id,
    application_id: record.application_id,
    expires_at: record.expires_at,
  });
}

function credentialResult(record, credentialHash, createdAt) {
  return Object.freeze({
    credential_id: `devc_${credentialHash.slice(0, 32)}`,
    tenant_id: record.tenant_id,
    owner_id: record.owner_id,
    device_id: record.device_id,
    surface_id: record.surface_id,
    application_id: record.application_id,
    scopes: Object.freeze([...record.scopes]),
    created_at: createdAt,
  });
}

function normalizeExchangeRow(row) {
  if (!row) return null;
  if (row.error_code) return Object.freeze({ error: row.error_code });
  return Object.freeze({
    ...row,
    scopes: Object.freeze(Array.isArray(row.scopes) ? row.scopes.map(String) : []),
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  });
}

function scopesFor(applicationId, surfaceId) {
  const scopes = ["continuity.read", "conversation.read", "conversation.write", "profile.read"];
  if (applicationId === "ag.companion") {
    scopes.push("release.read", "release.recovery.read", "development.request");
  }
  if (surfaceId === "android") scopes.push("device.receipts.write");
  return Object.freeze(scopes);
}

function requiredId(value, name) {
  const result = String(value || "").trim().toLowerCase();
  if (!ID_PATTERN.test(result)) throw enrollmentError("invalid_enrollment_request", `${name} is invalid`);
  return result;
}

function requiredSet(value, name, allowed) {
  const result = requiredId(value, name);
  if (!allowed.has(result)) throw enrollmentError("invalid_enrollment_request", `${name} is unsupported`);
  return result;
}

function requiredSecret(value, pattern, code) {
  const result = String(value || "").trim();
  if (!pattern.test(result)) throw enrollmentError(code, code.replaceAll("_", " "));
  return result;
}

function boundedTtl(value) {
  if (value === undefined || value === null || value === "") return DEFAULT_TTL_MS;
  const ttl = Number(value);
  if (!Number.isSafeInteger(ttl) || ttl < 30_000 || ttl > MAX_TTL_MS) {
    throw enrollmentError("invalid_enrollment_request", "ttl_ms must be between 30000 and 600000");
  }
  return ttl;
}

function validTime(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("clock returned an invalid time");
  return value;
}

function digest(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function messageFor(code) {
  return ({
    enrollment_capability_consumed: "enrollment capability was already used",
    enrollment_capability_expired: "enrollment capability expired",
    device_credential_conflict: "device credential already exists",
  })[code] || "device enrollment failed";
}

function enrollmentError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

module.exports = {
  CAPABILITY_PREFIX,
  DEVICE_TOKEN_PREFIX,
  createDeviceEnrollmentService,
  createMemoryDeviceEnrollmentStore,
  createPostgresDeviceEnrollmentStore,
};
