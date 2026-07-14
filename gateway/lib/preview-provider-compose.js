"use strict";

const fs = require("node:fs");
const path = require("node:path");

const TRUSTED_ROOT = path.resolve(__dirname, "../..");
const TRUSTED_COMPOSE = path.join(TRUSTED_ROOT, "docker-compose.preview.yml");
const EXPECTED_SERVICES = new Set(["gateway", "database"]);
const FORBIDDEN_ENV = /(?:PRODUCTION|PROMOTER|DEPLOY_REVIEWER|GATEWAY_TOKEN|ACTIVE_URL)/i;

// This module never invokes a shell and accepts no caller-selected Compose or
// env file. The injected runner must use spawn/execFile with shell:false.
function createComposePreviewProvider({ run, dbPassword } = {}) {
  if (typeof run !== "function") throw new Error("compose provider requires an injected argv runner");
  const password = String(dbPassword || "");
  if (password.length < 24 || /[\r\n\0]/.test(password)) throw new Error("a 24+ character preview-only database secret is required");
  const composeBytes = readTrustedCompose();
  const base = ["compose", "--project-directory", TRUSTED_ROOT, "--file", "-"];
  const invoke = (plan, args, options = {}) => {
    assertProject(plan);
    return run("docker", [...base, "--project-name", plan.project, ...args], {
      shell: false, signal: options.signal, timeout: options.timeout_ms,
      env: previewEnv(plan, password), input: Buffer.from(composeBytes), max_input_bytes: composeBytes.length,
    });
  };
  return {
    async create(plan, options) {
      const configured = await invoke(plan, ["config", "--format", "json"], options);
      validateComposeConfig(configured?.stdout, plan, password);
      await invoke(plan, ["up", "--detach", "--no-build", "--pull", "never"], options);
    },
    async inspect(plan, options) {
      const result = await invoke(plan, ["ps", "--all", "--format", "json"], options);
      const rows = parseRows(result?.stdout);
      if (!rows.length) return { exists: false };
      validateServiceRows(rows, plan);
      const ids = rows.map((row) => String(row.ID || row.Id || ""));
      if (ids.some((id) => !/^[a-f0-9]{12,64}$/.test(id))) throw new Error("provider returned an invalid container identity");
      const containers = parseJson((await run("docker", ["container", "inspect", ...ids], { shell: false, signal: options?.signal, timeout: options?.timeout_ms })).stdout);
      const image = parseJson((await run("docker", ["image", "inspect", plan.image_ref], { shell: false, signal: options?.signal, timeout: options?.timeout_ms })).stdout)[0];
      const databaseImage = parseJson((await run("docker", ["image", "inspect", plan.database_image_ref], { shell: false, signal: options?.signal, timeout: options?.timeout_ms })).stdout)[0];
      validateRuntimeInspection(containers, { gateway: image, database: databaseImage }, plan);
      return { exists: true, ...plan };
    },
    async health(plan, _inspection, options) {
      const rows = parseRows((await invoke(plan, ["ps", "--format", "json"], options))?.stdout);
      validateServiceRows(rows, plan);
      return rows.every((row) => {
        const health = String(row.Health || "").toLowerCase();
        return health ? health === "healthy" : String(row.State || "").toLowerCase() === "running";
      });
    },
    async cleanup(plan, options) { await invoke(plan, ["down", "--volumes", "--remove-orphans"], options); },
    apply() { throw new Error("preview provider cannot apply production deployments"); },
    rollback() { throw new Error("preview provider cannot roll back production deployments"); },
  };
}

function readTrustedCompose() {
  if (path.relative(TRUSTED_ROOT, TRUSTED_COMPOSE).startsWith("..") || fs.realpathSync(TRUSTED_COMPOSE) !== TRUSTED_COMPOSE) throw new Error("trusted preview Compose path escaped its root or is a symlink");
  return readRegularNoFollow(TRUSTED_COMPOSE);
}
function readRegularNoFollow(filePath) {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  const fd = fs.openSync(filePath, flags);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error("preview Compose descriptor is not a regular file");
    return Buffer.from(fs.readFileSync(fd));
  } finally { fs.closeSync(fd); }
}
function assertProject(plan) {
  if (!/^moa-preview-[a-f0-9]{12}$/.test(String(plan?.project || ""))) throw new Error("invalid preview Compose project identity");
}
function previewEnv(plan, password) {
  return {
    PATH: process.env.PATH || "/usr/bin:/bin",
    MOA_PREVIEW_IMAGE_REF: plan.image_ref, MOA_PREVIEW_PROJECT: plan.project,
    MOA_PREVIEW_DATABASE_IMAGE_REF: plan.database_image_ref,
    MOA_PREVIEW_HOSTNAME: plan.hostname, MOA_PREVIEW_DATABASE: plan.database,
    MOA_PREVIEW_QUEUE: plan.queue, MOA_PREVIEW_STORAGE: plan.storage,
    MOA_PREVIEW_WORKER_POOL: plan.worker_pool, MOA_PREVIEW_DB_PASSWORD: password,
  };
}
function validateComposeConfig(stdout, plan, dbPassword) {
  const config = parseJson(stdout);
  const services = config.services || {};
  if (new Set(Object.keys(services)).size !== EXPECTED_SERVICES.size || [...EXPECTED_SERVICES].some((name) => !services[name])) throw new Error("preview Compose config has unexpected services");
  const allowedKeys = new Set(["image", "restart", "labels", "environment", "depends_on", "volumes", "healthcheck", "command"]);
  for (const [name, service] of Object.entries(services)) {
    for (const key of Object.keys(service)) if (!allowedKeys.has(key)) throw new Error(`preview Compose service ${name} contains forbidden field ${key}`);
    const allowedEnv = name === "gateway"
      ? new Set(["DATABASE_URL", "DATA_DIR", "MOA_QUEUE_NAMESPACE", "MOA_QUEUE_STATUS", "MOA_STORAGE_NAMESPACE", "MOA_WORKER_POOL", "MOA_WORKER_POOL_STATUS"])
      : new Set(["POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DB"]);
    for (const [key] of Object.entries(service.environment || {})) {
      if (!allowedEnv.has(key) || FORBIDDEN_ENV.test(key)) throw new Error(`preview Compose config contains non-allowlisted environment identity: ${key}`);
    }
    const expectedLabels = new Set(["moa.preview.project", "moa.preview.hostname", "moa.preview.database", "moa.preview.queue", "moa.preview.storage", "moa.preview.worker_pool", "moa.preview.image_ref", "moa.preview.database_image_ref", "moa.preview.queue_status", "moa.preview.worker_pool_status"]);
    if (Object.keys(service.labels || {}).length !== expectedLabels.size || Object.keys(service.labels || {}).some((key) => !expectedLabels.has(key))) throw new Error(`preview Compose service ${name} labels are not strictly allowlisted`);
    if (!Array.isArray(service.volumes) || service.volumes.length !== 1) throw new Error(`preview Compose service ${name} must have exactly one isolated volume`);
    for (const mount of service.volumes) {
      const expected = name === "gateway" ? ["preview-storage", "/app/data/preview"] : ["preview-db", "/var/lib/postgresql/data"];
      if (mount.type !== "volume" || mount.source !== expected[0] || mount.target !== expected[1] || String(mount.source).includes("sock")) throw new Error(`preview Compose service ${name} contains a non-allowlisted volume`);
    }
  }
  if (services.gateway.image !== plan.image_ref || services.database.image !== plan.database_image_ref) throw new Error("preview Compose config image digest mismatch");
  validateDatabaseEndpoint(services.gateway.environment?.DATABASE_URL, plan, dbPassword);
  if (services.gateway.environment?.DATA_DIR !== "/app/data/preview" || services.gateway.environment?.MOA_QUEUE_STATUS !== "disabled-but-isolated" || services.gateway.environment?.MOA_WORKER_POOL_STATUS !== "disabled-but-isolated" || services.gateway.environment?.MOA_QUEUE_NAMESPACE !== plan.queue || services.gateway.environment?.MOA_STORAGE_NAMESPACE !== plan.storage || services.gateway.environment?.MOA_WORKER_POOL !== plan.worker_pool) throw new Error("preview Compose gateway isolation environment mismatch");
  if (services.database.environment?.POSTGRES_USER !== "preview" || services.database.environment?.POSTGRES_DB !== plan.database || services.database.environment?.POSTGRES_PASSWORD !== dbPassword) throw new Error("preview Compose database identity mismatch");
  if (Object.keys(config.networks || {}).some((key) => key !== "default") || config.networks?.default?.external === true || config.networks?.default?.name !== `${plan.project}_default`) throw new Error("preview Compose config contains a non-preview network");
  const expectedVolumes = new Set(["preview-db", "preview-storage"]);
  if (Object.keys(config.volumes || {}).length !== 2 || Object.entries(config.volumes || {}).some(([key, value]) => !expectedVolumes.has(key) || value.external === true || value.name !== `${plan.project}_${key}`)) throw new Error("preview Compose config contains a non-preview volume");
}
function validateServiceRows(rows, plan) {
  const names = rows.map((row) => String(row.Service || ""));
  if (rows.length !== EXPECTED_SERVICES.size || new Set(names).size !== EXPECTED_SERVICES.size || names.some((name) => !EXPECTED_SERVICES.has(name))) throw new Error("provider inspection is missing or duplicates an expected preview service");
  for (const row of rows) {
    if (String(row.Project || "") !== plan.project) throw new Error("provider inspection project mismatch");
    if (!String(row.Name || "").startsWith(`${plan.project}-`)) throw new Error("provider inspection container identity mismatch");
    const labels = parseLabelMap(row.Labels);
    for (const field of ["project", "hostname", "database", "queue", "queue_status", "storage", "worker_pool", "worker_pool_status", "image_ref", "database_image_ref"]) {
      if (labels[`moa.preview.${field}`] !== plan[field]) throw new Error(`provider inspection has missing or conflicting ${field} label`);
    }
  }
}
function validateRuntimeInspection(containers, images, plan) {
  if (!Array.isArray(containers) || containers.length !== EXPECTED_SERVICES.size) throw new Error("provider container inspection incomplete");
  const network = `${plan.project}_default`;
  const volume = `${plan.project}_preview-db`;
  const storageVolume = `${plan.project}_preview-storage`;
  if (containers.some((item) => !item.NetworkSettings?.Networks?.[network])) throw new Error("preview container is not on its isolated project network");
  const db = containers.find((item) => String(item.Config?.Labels?.["com.docker.compose.service"]) === "database");
  const gateway = containers.find((item) => String(item.Config?.Labels?.["com.docker.compose.service"]) === "gateway");
  if (!db?.Mounts?.some((mount) => mount.Type === "volume" && mount.Name === volume)) throw new Error("preview database volume identity mismatch");
  if (!gateway?.Mounts?.some((mount) => mount.Type === "volume" && mount.Name === storageVolume)) throw new Error("preview storage volume identity mismatch");
  const dbEnv = envMap(db.Config?.Env);
  const gatewayEnv = envMap(gateway?.Config?.Env);
  validateDatabaseEndpoint(gatewayEnv.DATABASE_URL, plan, dbEnv.POSTGRES_PASSWORD);
  if (dbEnv.POSTGRES_USER !== "preview" || dbEnv.POSTGRES_DB !== plan.database || !String(dbEnv.POSTGRES_PASSWORD || "")) throw new Error("runtime database identity mismatch");
  if (gatewayEnv.DATA_DIR !== "/app/data/preview") throw new Error("runtime DATA_DIR is not bound to preview storage");
  if (gatewayEnv.MOA_QUEUE_NAMESPACE !== plan.queue || gatewayEnv.MOA_QUEUE_STATUS !== "disabled-but-isolated" || gatewayEnv.MOA_STORAGE_NAMESPACE !== plan.storage || gatewayEnv.MOA_WORKER_POOL !== plan.worker_pool || gatewayEnv.MOA_WORKER_POOL_STATUS !== "disabled-but-isolated") throw new Error("runtime preview namespaces do not match the plan");
  const expectedRefs = { gateway: plan.image_ref, database: plan.database_image_ref };
  for (const container of containers) {
    const service = container.Config?.Labels?.["com.docker.compose.service"];
    const inspected = images[service];
    if (!inspected?.RepoDigests?.includes(expectedRefs[service]) || container.Config?.Image !== expectedRefs[service] || container.Image !== inspected.Id) throw new Error(`running ${service} image identity does not match its immutable digest`);
  }
  if (images.gateway?.Config?.Labels?.["org.opencontainers.image.revision"] !== plan.commit_sha) throw new Error("runtime image revision does not match commit_sha");
}
function envMap(values) { return Object.fromEntries((values || []).map((item) => String(item).split(/=(.*)/s).slice(0, 2))); }
function validateDatabaseEndpoint(value, plan, expectedPassword) {
  let parsed;
  try { parsed = new URL(String(value || "")); } catch { throw new Error("preview DATABASE_URL is malformed"); }
  if (parsed.protocol !== "postgres:" || decodeURIComponent(parsed.username) !== "preview" || decodeURIComponent(parsed.password) !== String(expectedPassword || "") || !parsed.password || parsed.hostname !== "database" || parsed.port !== "5432" || decodeURIComponent(parsed.pathname) !== `/${plan.database}` || parsed.search || parsed.hash) throw new Error("preview DATABASE_URL endpoint does not exactly match the isolated database");
}
function parseLabelMap(value) {
  if (value && typeof value === "object") return value;
  return Object.fromEntries(String(value || "").split(",").map((item) => item.split(/=(.*)/s).slice(0, 2)).filter(([key, item]) => key && item));
}
function parseRows(stdout) { const parsed = parseJson(stdout, true); return Array.isArray(parsed) ? parsed : [parsed]; }
function parseJson(stdout, allowLines = false) {
  const value = String(stdout || "").trim();
  if (!value) return allowLines ? [] : {};
  try { return JSON.parse(value); } catch (error) {
    if (allowLines) return value.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    throw error;
  }
}

module.exports = { createComposePreviewProvider, validateComposeConfig };
