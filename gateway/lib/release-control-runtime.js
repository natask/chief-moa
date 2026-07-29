"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { Pool } = require("pg");
const { createAndroidFeedbackFixCoordinator } = require("./android-feedback-fix-coordinator");

const RELEASE_CONTROL_PREFIX = "/v1/release-control/";
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const MIGRATION_LOCK_KEY = 1_936_025_188;
const AUTHORITY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;

async function createReleaseControlRuntime(options = {}) {
  const enabled = options.enabled ?? process.env.MOA_RELEASE_CONTROL_ENABLED === "1";
  if (!enabled) return disabledRuntime();

  const databaseUrl = String(
    options.databaseUrl || process.env.RELEASE_CONTROL_DATABASE_URL || "",
  ).trim();
  if (!databaseUrl) {
    throw new Error(
      "RELEASE_CONTROL_DATABASE_URL is required when MOA_RELEASE_CONTROL_ENABLED=1",
    );
  }
  assertSeparateDatabase(databaseUrl, options.gatewayDatabaseUrl ?? process.env.DATABASE_URL);
  const authority = stableAuthority({
    tenantId: options.tenantId ?? process.env.MOA_RELEASE_CONTROL_TENANT_ID,
    ownerId: options.ownerId ?? process.env.MOA_RELEASE_CONTROL_OWNER_ID,
  });
  if (typeof options.authenticate !== "function"
      && typeof options.createAuthentication !== "function") {
    throw new Error(
      "release-control authenticate(request) or createAuthentication(pool) is required",
    );
  }

  const componentDir = path.resolve(options.componentDir || resolveComponentDir());
  const migrationDir = path.resolve(
    options.migrationDir
      || path.join(componentDir, "migrations"),
  );
  const pool = options.pool || new Pool({
    connectionString: databaseUrl,
    max: positiveInteger(options.poolMax ?? process.env.RELEASE_CONTROL_POOL_MAX, 8),
    connectionTimeoutMillis: positiveInteger(
      options.connectionTimeoutMs ?? process.env.RELEASE_CONTROL_CONNECT_TIMEOUT_MS,
      10_000,
    ),
  });
  const ownsPool = !options.pool;

  try {
    if (options.migrate !== false) {
      await applyMigrations(pool, migrationDir);
    } else {
      await assertSchemaReady(pool);
    }
    const authentication = typeof options.createAuthentication === "function"
      ? await options.createAuthentication(pool, authority)
      : null;
    const authenticate = options.authenticate || authentication?.authenticate;
    if (typeof authenticate !== "function") {
      throw new Error("release-control authenticate(request) is required");
    }
    const [
      { createPostgresReleaseAdapter },
      { createReleaseControlService },
      { createReleaseControlHttpHandler },
    ] = await Promise.all([
      importModule(componentDir, "lib/postgres-adapter.mjs"),
      importModule(componentDir, "lib/service.mjs"),
      importModule(componentDir, "lib/http.mjs"),
    ]);
    const adapter = createPostgresReleaseAdapter(pool);
    const service = createReleaseControlService({ adapter });
    const modificationCoordinator = options.events && options.intentWorkflow
      ? createAndroidFeedbackFixCoordinator({
        events: options.events,
        intentWorkflow: options.intentWorkflow,
        releaseControlService: service,
        resolveBaseCommit: options.resolveBaseCommit,
        now: options.now,
      })
      : null;
    const handle = createReleaseControlHttpHandler(service, {
      authenticate,
      modificationCoordinator,
    });

    return Object.freeze({
      enabled: true,
      storage: "postgres",
      registrationAuthority: authentication?.registrationAuthority || null,
      authority,
      async route(request, response, url, transport = {}) {
        if (!String(url?.pathname || "").startsWith(RELEASE_CONTROL_PREFIX)) return false;
        const method = String(request.method || "GET").toUpperCase();
        const requestShape = {
          method,
          path: url.pathname,
          headers: request.headers || {},
          query: queryObject(url.searchParams),
        };
        if (method !== "GET" && method !== "HEAD") {
          const readJsonBody = requiredFunction(transport.readJsonBody, "readJsonBody");
          requestShape.body = await readJsonBody(request);
        }
        const result = await handle(requestShape);
        requiredFunction(transport.sendJson, "sendJson")(
          response,
          result.status,
          result.body,
        );
        return true;
      },
      async close() {
        if (ownsPool) await pool.end();
      },
    });
  } catch (error) {
    if (ownsPool) await pool.end().catch(() => {});
    throw error;
  }
}

function stableAuthority(input = {}) {
  const tenantId = String(input.tenantId || "").trim().toLowerCase();
  const ownerId = String(input.ownerId || "").trim().toLowerCase();
  if (!AUTHORITY_ID_PATTERN.test(tenantId)) {
    throw new Error(
      "MOA_RELEASE_CONTROL_TENANT_ID is required and must be a stable identifier",
    );
  }
  if (!AUTHORITY_ID_PATTERN.test(ownerId)) {
    throw new Error(
      "MOA_RELEASE_CONTROL_OWNER_ID is required and must be a stable identifier",
    );
  }
  return Object.freeze({ tenant_id: tenantId, owner_id: ownerId });
}

async function applyMigrations(pool, migrationDir) {
  const migrations = (await fs.promises.readdir(migrationDir))
    .filter((name) => /^\d+_[a-z0-9_-]+\.sql$/i.test(name))
    .sort();
  if (migrations.length === 0) throw new Error("no release-control migrations found");
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    for (const migration of migrations) {
      const sql = await fs.promises.readFile(path.join(migrationDir, migration), "utf8");
      try {
        await client.query(sql);
      } catch (error) {
        try { await client.query("rollback"); } catch {}
        error.message = `${migration}: ${error.message}`;
        throw error;
      }
    }
  } finally {
    try {
      await client.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
    } finally {
      client.release();
    }
  }
}

async function assertSchemaReady(pool) {
  await pool.query(
    `select to_regclass('public.release_bundles') as bundles,
            to_regclass('public.release_assignment_events') as assignments`,
  ).then((result) => {
    if (!result.rows[0]?.bundles || !result.rows[0]?.assignments) {
      throw new Error("release-control schema is not ready");
    }
  });
}

function resolveComponentDir() {
  const candidates = [
    path.resolve(__dirname, "..", "release_control_plane"),
    path.resolve(__dirname, "..", "..", "release_control_plane"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

function importModule(componentDir, relativePath) {
  const target = path.resolve(componentDir, relativePath);
  return import(pathToFileURL(target).href);
}

function queryObject(searchParams) {
  const result = {};
  for (const [key, value] of searchParams || []) {
    if (Object.prototype.hasOwnProperty.call(result, key)) continue;
    result[key] = value;
  }
  return result;
}

function assertSeparateDatabase(releaseUrl, gatewayUrl) {
  const gateway = String(gatewayUrl || "").trim();
  if (!gateway) return;
  if (databaseIdentity(releaseUrl) === databaseIdentity(gateway)) {
    throw new Error(
      "RELEASE_CONTROL_DATABASE_URL must name a database separate from DATABASE_URL",
    );
  }
}

function databaseIdentity(value) {
  const parsed = new URL(value);
  parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function requiredFunction(value, name) {
  if (typeof value !== "function") throw new Error(`${name} is required`);
  return value;
}

function disabledRuntime() {
  return Object.freeze({
    enabled: false,
    storage: "disabled",
    async route() {
      return false;
    },
    async close() {},
  });
}

module.exports = {
  RELEASE_CONTROL_PREFIX,
  applyMigrations,
  assertSchemaReady,
  assertSeparateDatabase,
  createReleaseControlRuntime,
  stableAuthority,
};
