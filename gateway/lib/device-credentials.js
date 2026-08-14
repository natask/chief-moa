"use strict";

const crypto = require("node:crypto");

const TOKEN_SCHEME = "Device";
const TOKEN_PREFIX = "moa_dev_v1";
const SURFACES = new Set(["android", "browser_extension", "desktop"]);
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const DEVICE_TOKEN_PATTERN = /^(?:moa|ag)_dev_v1\.[A-Za-z0-9_-]{43}$/;
const REVOCATION_REASONS = new Set(["owner_requested", "device_lost", "credential_rotated", "security_response"]);

function createDeviceCredentialRegistry(options = {}) {
  const store = options.store;
  if (!store || typeof store.findByBinding !== "function"
      || typeof store.findByTokenHash !== "function"
      || typeof store.insert !== "function" || typeof store.revoke !== "function"
      || typeof store.list !== "function") {
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
    if (existing && existing.status !== "revoked") {
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

  async function revoke(input = {}) {
    const tenantId = requiredId(input.tenant_id, "tenant_id");
    const credentialId = requiredId(input.credential_id, "credential_id");
    const reason = requiredRevocationReason(input.reason);
    const revokedAtMs = now();
    if (!Number.isSafeInteger(revokedAtMs) || revokedAtMs <= 0) throw new Error("clock returned an invalid time");
    const result = await store.revoke({
      tenant_id: tenantId,
      credential_id: credentialId,
      reason,
      revoked_at: new Date(revokedAtMs).toISOString(),
    });
    if (!result?.record) {
      throw credentialError("device_credential_not_found", "device credential was not found");
    }
    return Object.freeze({
      receipt: publicReceipt(result.record),
      replay: !result.newly_revoked,
    });
  }

  async function list(input = {}) {
    const tenantId = requiredId(input.tenant_id, "tenant_id");
    const limit = Math.max(1, Math.min(Number.parseInt(input.limit, 10) || 20, 50));
    const cursor = Math.max(0, Number.parseInt(input.cursor, 10) || 0);
    const page = await store.list({ tenant_id: tenantId, limit: limit + 1, cursor });
    const rows = Array.isArray(page) ? page : [];
    return Object.freeze({
      schema: "moa.device-credential-list.v1",
      items: Object.freeze(rows.slice(0, limit).map(credentialProjection)),
      next_cursor: rows.length > limit ? String(cursor + limit) : "",
    });
  }

  // HTTP requests and WebSocket upgrade requests use the same headers and the
  // same read-time credential check. Expose both names so callers cannot drift.
  return Object.freeze({
    register,
    list,
    revoke,
    authenticateRequest,
    authenticateHttpRequest: authenticateRequest,
    authenticateWebSocketRequest: authenticateRequest,
  });
}

function createMemoryDeviceCredentialStore(initial = []) {
  const byTokenHash = new Map();
  const byBinding = new Map();
  const byCredentialId = new Map();
  const revoked = new Map();
  for (const item of initial) {
    const record = frozenCopy(item);
    byTokenHash.set(record.token_hash, record);
    byBinding.set(record.binding_key, record);
    byCredentialId.set(record.credential_id, record);
    if (record.status === "revoked") revoked.set(record.credential_id, record);
  }
  return Object.freeze({
    async findByBinding(tenantId, bindingKey) {
      const record = byBinding.get(bindingKey);
      if (!record || record.tenant_id !== tenantId) return null;
      return projectedMemoryRecord(record, revoked.has(record.credential_id));
    },
    async findByTokenHash(tokenHash) {
      const record = byTokenHash.get(tokenHash);
      if (!record || revoked.has(record.credential_id)) return null;
      return record;
    },
    async insert(record) {
      const current = byBinding.get(record.binding_key);
      if ((current && !revoked.has(current.credential_id)) || byTokenHash.has(record.token_hash)) return false;
      const copy = frozenCopy(record);
      byBinding.set(copy.binding_key, copy);
      byTokenHash.set(copy.token_hash, copy);
      byCredentialId.set(copy.credential_id, copy);
      return true;
    },
    async revoke(event) {
      const record = byCredentialId.get(event.credential_id);
      if (!record || record.tenant_id !== event.tenant_id) return null;
      const newlyRevoked = !revoked.has(record.credential_id);
      if (newlyRevoked) revoked.set(record.credential_id, frozenCopy(event));
      return Object.freeze({
        record: projectedMemoryRecord(record, true),
        newly_revoked: newlyRevoked,
      });
    },
    async list({ tenant_id: tenantId, limit, cursor }) {
      return [...byCredentialId.values()]
        .filter((record) => record.tenant_id === tenantId)
        .map((record) => projectedMemoryRecord(record, revoked.has(record.credential_id)))
        .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at))
          || right.credential_id.localeCompare(left.credential_id))
        .slice(cursor, cursor + limit);
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
          `select c.credential_id, g.binding_key, c.tenant_id, c.device_id, c.surface_id,
                  c.token_hash, c.idempotency_hash,
                  case when exists (
                    select 1 from release_device_credential_revocations r
                     where r.credential_id = c.credential_id
                  ) then 'revoked' else c.status end as status,
                  c.created_at, c.application_id, c.scopes, c.owner_id
             from release_device_credential_generations g
             join release_device_credentials c on c.credential_id = g.credential_id
            where g.tenant_id = $1 and g.binding_key = $2
            order by g.generation desc limit 1`,
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
        await client.query(
          "select pg_advisory_xact_lock(hashtextextended($1, 0))",
          [record.binding_key],
        );
        const result = await client.query(
          `with active_generation as (
             select 1
               from release_device_credential_generations g
               join release_device_credentials c on c.credential_id = g.credential_id
              where g.tenant_id = $3 and g.binding_key = $2
                and not exists (
                  select 1 from release_device_credential_revocations r
                   where r.credential_id = c.credential_id
                )
              limit 1
           ), next_generation as (
             select coalesce(max(g.generation), 0) + 1 as generation
               from release_device_credential_generations g
              where g.tenant_id = $3 and g.binding_key = $2
           ), inserted_credential as (
             insert into release_device_credentials
               (credential_id, binding_key, tenant_id, device_id, surface_id,
                token_hash, idempotency_hash, status, created_at)
             select $1,
                    case when exists (
                      select 1 from release_device_credentials where binding_key = $2
                    ) then $6 else $2 end,
                    $3,$4,$5,$6,$7,$8,$9
              where not exists (select 1 from active_generation)
             on conflict do nothing
             returning credential_id
           )
           insert into release_device_credential_generations
             (credential_id, tenant_id, binding_key, generation, created_at)
           select i.credential_id, $3, $2, n.generation, $9
             from inserted_credential i cross join next_generation n
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
    async revoke(event) {
      return tenantQuery(pool, event.tenant_id, async (client) => {
        const result = await client.query(
          `with inserted as (
             insert into release_device_credential_revocations
               (credential_id, tenant_id, reason, revoked_at)
             select c.credential_id, c.tenant_id, $3, $4
               from release_device_credentials c
              where c.tenant_id = $1 and c.credential_id = $2
             on conflict (credential_id) do nothing
             returning credential_id
           )
           select c.credential_id, c.binding_key, c.tenant_id, c.device_id, c.surface_id,
                  c.token_hash, c.idempotency_hash, 'revoked'::text as status,
                  c.created_at, c.application_id, c.scopes, c.owner_id,
                  exists (select 1 from inserted) as newly_revoked
             from release_device_credentials c
            where c.tenant_id = $1 and c.credential_id = $2
            limit 1`,
          [event.tenant_id, event.credential_id, event.reason, event.revoked_at],
        );
        const row = result.rows?.[0];
        if (!row) return null;
        return Object.freeze({
          record: normalizeDatabaseRecord(row),
          newly_revoked: row.newly_revoked === true,
        });
      });
    },
    async list({ tenant_id: tenantId, limit, cursor }) {
      return tenantQuery(pool, tenantId, async (client) => {
        const result = await client.query(
          `select c.credential_id, c.tenant_id, c.device_id, c.surface_id,
                  case when exists (
                    select 1 from release_device_credential_revocations r
                     where r.credential_id = c.credential_id
                  ) then 'revoked' else c.status end as status,
                  c.created_at, c.application_id
             from release_device_credentials c
            where c.tenant_id = $1
            order by c.created_at desc, c.credential_id desc
            offset $2 limit $3`,
          [tenantId, cursor, limit],
        );
        return result.rows.map(normalizeDatabaseRecord);
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

function credentialProjection(record) {
  return Object.freeze({
    credential_id: String(record.credential_id),
    device_id: String(record.device_id),
    surface_id: String(record.surface_id),
    application_id: String(record.application_id || "chief-moa"),
    status: String(record.status),
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

function requiredRevocationReason(value) {
  const result = String(value || "owner_requested").trim().toLowerCase();
  if (!REVOCATION_REASONS.has(result)) {
    throw credentialError("invalid_device_revocation", "revocation reason is invalid");
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

function projectedMemoryRecord(record, isRevoked) {
  return isRevoked ? Object.freeze({ ...record, status: "revoked" }) : record;
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
