"use strict";

const crypto = require("node:crypto");

const TOKEN_SCHEME = "Device";
const TOKEN_PREFIX = "moa_dev_v1";
const SURFACES = new Set(["android", "browser_extension", "desktop"]);
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const DEVICE_TOKEN_PATTERN = /^(?:moa|ag)_dev_v1\.[A-Za-z0-9_-]{43}$/;

function createDeviceCredentialRegistry(options = {}) {
  const store = options.store;
  if (!store || typeof store.findByBinding !== "function"
      || typeof store.findByTokenHash !== "function"
      || typeof store.insert !== "function") {
    throw new Error("device credential store is required");
  }
  const now = typeof options.now === "function" ? options.now : () => Date.now();

  async function register(input = {}) {
    const tenantId = requiredId(input.tenant_id, "tenant_id");
    const deviceId = requiredId(input.device_id, "device_id");
    const surfaceId = requiredSurface(input.surface_id);
    const idempotencyKey = requiredIdempotencyKey(input.idempotency_key);
    const token = requiredDeviceToken(input.credential_token);
    const bindingKey = bindingDigest(tenantId, deviceId, surfaceId);
    const tokenHash = digest(token);
    const idempotencyHash = digest(idempotencyKey);
    const existing = await store.findByBinding(tenantId, bindingKey);
    if (existing) {
      if (!safeEqual(existing.idempotency_hash, idempotencyHash)
          || !safeEqual(existing.token_hash, tokenHash)) {
        throw credentialError("device_already_registered",
          "device credential already exists; rotate it explicitly");
      }
      return Object.freeze({ receipt: publicReceipt(existing), replay: true });
    }

    const createdAtMs = now();
    if (!Number.isSafeInteger(createdAtMs) || createdAtMs <= 0) throw new Error("clock returned an invalid time");
    const record = Object.freeze({
      schema_version: 1,
      credential_id: `devc_${tokenHash.slice(0, 32)}`,
      binding_key: bindingKey,
      tenant_id: tenantId,
      device_id: deviceId,
      surface_id: surfaceId,
      token_hash: tokenHash,
      idempotency_hash: idempotencyHash,
      status: "active",
      created_at: new Date(createdAtMs).toISOString(),
    });
    const inserted = await store.insert(record);
    if (!inserted) {
      const raced = await store.findByBinding(tenantId, bindingKey);
      if (raced && safeEqual(raced.idempotency_hash, idempotencyHash)
          && safeEqual(raced.token_hash, tokenHash)) {
        return Object.freeze({ receipt: publicReceipt(raced), replay: true });
      }
      throw credentialError("device_already_registered", "device credential registration conflicted");
    }
    return Object.freeze({ receipt: publicReceipt(record), replay: false });
  }

  async function authenticateRequest(request = {}) {
    const token = parseDeviceAuthorization(header(request, "authorization"));
    if (!token) return null;
    const record = await store.findByTokenHash(digest(token));
    if (!record || record.status !== "active") return null;

    const assertedDevice = optionalHeaderId(request, "x-moa-device-id");
    const assertedSurface = optionalHeaderId(request, "x-moa-surface");
    if (assertedDevice === false || assertedSurface === false) return null;
    if (assertedDevice && assertedDevice !== record.device_id) return null;
    if (assertedSurface && assertedSurface !== record.surface_id) return null;

    return Object.freeze({
      tenant_id: record.tenant_id,
      device_id: record.device_id,
      surface_id: record.surface_id,
      credential_id: record.credential_id,
      owner_id: record.owner_id || "",
      application_id: record.application_id || "chief-moa",
      scopes: Object.freeze(Array.isArray(record.scopes) ? record.scopes.map(String) : ["release.read"]),
    });
  }

  return Object.freeze({ register, authenticateRequest });
}

function createMemoryDeviceCredentialStore(initial = []) {
  const byTokenHash = new Map();
  const byBinding = new Map();
  for (const item of initial) {
    const record = frozenCopy(item);
    byTokenHash.set(record.token_hash, record);
    byBinding.set(record.binding_key, record);
  }
  return Object.freeze({
    async findByBinding(_tenantId, bindingKey) { return byBinding.get(bindingKey) || null; },
    async findByTokenHash(tokenHash) { return byTokenHash.get(tokenHash) || null; },
    async insert(record) {
      if (byBinding.has(record.binding_key) || byTokenHash.has(record.token_hash)) return false;
      const copy = frozenCopy(record);
      byBinding.set(copy.binding_key, copy);
      byTokenHash.set(copy.token_hash, copy);
      return true;
    },
  });
}

function createPostgresDeviceCredentialStore(pool) {
  if (!pool || typeof pool.query !== "function" || typeof pool.connect !== "function") {
    throw new Error("Postgres pool is required");
  }
  return Object.freeze({
    async findByBinding(tenantId, bindingKey) {
      return tenantQuery(pool, tenantId, async (client) => {
        const result = await client.query(
          `select credential_id, binding_key, tenant_id, device_id, surface_id,
                  token_hash, idempotency_hash, status, created_at
             from release_device_credentials
            where tenant_id = $1 and binding_key = $2 limit 1`,
          [tenantId, bindingKey],
        );
        return normalizeDatabaseRecord(result.rows?.[0]);
      });
    },
    async findByTokenHash(tokenHash) {
      const result = await pool.query(
        "select * from release_authenticate_device_credential($1)",
        [tokenHash],
      );
      return normalizeDatabaseRecord(result.rows?.[0]);
    },
    async insert(record) {
      return tenantQuery(pool, record.tenant_id, async (client) => {
        const result = await client.query(
          `insert into release_device_credentials
            (credential_id, binding_key, tenant_id, device_id, surface_id,
             token_hash, idempotency_hash, status, created_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           on conflict do nothing
           returning credential_id`,
          [
            record.credential_id, record.binding_key, record.tenant_id, record.device_id,
            record.surface_id, record.token_hash, record.idempotency_hash, record.status,
            record.created_at,
          ],
        );
        return result.rowCount === 1;
      });
    },
  });
}

async function tenantQuery(pool, tenantId, operation) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('moa.tenant_id', $1, true)", [tenantId]);
    const value = await operation(client);
    await client.query("commit");
    return value;
  } catch (error) {
    try { await client.query("rollback"); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

function publicReceipt(record) {
  return Object.freeze({
    credential_id: record.credential_id,
    device_id: record.device_id,
    surface_id: record.surface_id,
    status: record.status,
    created_at: record.created_at instanceof Date
      ? record.created_at.toISOString() : String(record.created_at),
  });
}

function parseDeviceAuthorization(value) {
  const match = String(value || "").match(/^Device ((?:moa|ag)_dev_v1\.[A-Za-z0-9_-]{43})$/);
  return match ? match[1] : "";
}

function requiredDeviceToken(value) {
  const token = String(value || "").trim();
  if (!DEVICE_TOKEN_PATTERN.test(token)) {
    throw credentialError("invalid_device_registration", "credential_token is invalid");
  }
  return token;
}

function requiredId(value, name) {
  const result = String(value || "").trim().toLowerCase();
  if (!ID_PATTERN.test(result)) throw credentialError("invalid_device_registration", `${name} is invalid`);
  return result;
}

function requiredSurface(value) {
  const result = requiredId(value, "surface_id");
  if (!SURFACES.has(result)) throw credentialError("invalid_device_registration", "surface_id is unsupported");
  return result;
}

function requiredIdempotencyKey(value) {
  const result = String(value || "").trim();
  if (!IDEMPOTENCY_PATTERN.test(result)) {
    throw credentialError("invalid_device_registration", "idempotency_key is invalid");
  }
  return result;
}

function optionalHeaderId(request, name) {
  const value = header(request, name);
  if (value === false) return false;
  if (!value) return "";
  const normalized = String(value).trim().toLowerCase();
  return ID_PATTERN.test(normalized) ? normalized : false;
}

function header(request, name) {
  const headers = request?.headers || {};
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? false : String(value || "").trim();
}

function bindingDigest(tenantId, deviceId, surfaceId) {
  return digest(`${tenantId}\0${deviceId}\0${surfaceId}`);
}

function digest(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function frozenCopy(value) {
  return Object.freeze({ ...value });
}

function normalizeDatabaseRecord(row) {
  if (!row) return null;
  return Object.freeze({
    ...row,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  });
}

function credentialError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

module.exports = {
  TOKEN_SCHEME,
  createDeviceCredentialRegistry,
  createMemoryDeviceCredentialStore,
  createPostgresDeviceCredentialStore,
};
