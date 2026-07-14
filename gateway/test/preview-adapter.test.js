"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createPreviewResourcePlan } = require("../lib/preview-resource-plan");
const { createPreviewAdapter } = require("../lib/preview-adapter");
const { createComposePreviewProvider, validateComposeConfig } = require("../lib/preview-provider-compose");
const { createPreviewPoller } = require("../scripts/preview-worker");

const active = { project: "moa-active", hostname: "app.example.test", database: "moa_prod", queue: "prod-queue", storage: "prod-storage", worker_pool: "prod-workers" };
const base = { request_id: "req-1", commit_sha: "a".repeat(40), image_repository: "registry.example/moa", image_digest: "b".repeat(64), database_image_repository: "registry.example/postgres", database_image_digest: "d".repeat(64), preview_domain: "example.test", active_identity: active };

test("resource plans are deterministic, unique, immutable-image addressed, and collision guarded", () => {
  const one = createPreviewResourcePlan(base);
  assert.deepEqual(createPreviewResourcePlan(base), one);
  assert.notEqual(createPreviewResourcePlan({ ...base, request_id: "req-2" }).project, one.project);
  assert.match(one.image_ref, /@sha256:/);
  assert.throws(() => createPreviewResourcePlan({ ...base, commit_sha: "main" }), /full lowercase Git SHA/);
  assert.throws(() => createPreviewResourcePlan({ ...base, image_digest: "latest" }), /sha256 digest/);
  assert.throws(() => createPreviewResourcePlan({ ...base, active_identity: { ...active, queue: one.queue } }), /collides/);
  assert.throws(() => createPreviewResourcePlan({ ...base, active_identity: {} }), /all active baseline/);
  assert.throws(() => createPreviewResourcePlan({ ...base, active_identity: { ...active, storage: active.queue } }), /mutually distinct/);
  assert.throws(() => createPreviewResourcePlan({ ...base, request_id: "x; docker rm" }), /unsupported/);
});

function fakeProvider({ healthy = true, existing = false } = {}) {
  const calls = [];
  let present = existing;
  return { calls,
    async create() { calls.push("create"); present = true; },
    async inspect(plan) { calls.push("inspect"); return present ? { exists: true, ...plan } : { exists: false }; },
    async health() { calls.push("health"); return healthy; },
    async cleanup() { calls.push("cleanup"); present = false; },
  };
}

test("adapter succeeds from provider evidence and reuses an already healthy preview", async () => {
  const plan = createPreviewResourcePlan(base);
  const activeBefore = structuredClone(active);
  const fresh = fakeProvider();
  assert.equal((await createPreviewAdapter({ provider: fresh, poll: { attempts: 1 } }).deploy(plan, active)).reused, false);
  assert.deepEqual(active, activeBefore, "preview execution must not mutate active identity");
  const existing = fakeProvider({ existing: true });
  assert.equal((await createPreviewAdapter({ provider: existing }).deploy(plan, active)).reused, true);
  assert.equal(existing.calls.includes("create"), false);
});

test("every provider operation is bounded and receives abort plus timeout", async () => {
  const plan = createPreviewResourcePlan(base);
  const seen = [];
  const hung = fakeProvider();
  hung.inspect = (_plan, options) => { seen.push(options); return new Promise(() => {}); };
  await assert.rejects(createPreviewAdapter({ provider: hung, poll: { operation_timeout_ms: 10 } }).deploy(plan, active), /timed out/);
  assert.equal(seen[0].signal.aborted, true);
  assert.equal(seen[0].timeout_ms, 10);
});

test("partial create failure always attempts exact cleanup and preserves both failures", async () => {
  const plan = createPreviewResourcePlan(base);
  const partial = fakeProvider();
  partial.create = async () => { partial.calls.push("create"); throw new Error("partial create"); };
  partial.cleanup = async () => { partial.calls.push("cleanup"); throw new Error("cleanup failed"); };
  await assert.rejects(createPreviewAdapter({ provider: partial, poll: { operation_timeout_ms: 50 } }).deploy(plan, active), (error) => {
    assert.equal(error instanceof AggregateError, true);
    assert.match(error.message, /partial create.*cleanup failed/);
    return true;
  });
  assert.deepEqual(partial.calls.slice(-2), ["create", "cleanup"]);
});

test("adapter performs exact cleanup after bounded health failure and abort", async () => {
  const plan = createPreviewResourcePlan(base);
  const failed = fakeProvider({ healthy: false });
  await assert.rejects(createPreviewAdapter({ provider: failed, poll: { attempts: 2, interval_ms: 0, sleep: async () => {} } }).deploy(plan, active), /bounded health/);
  assert.equal(failed.calls.filter((call) => call === "cleanup").length, 1);
  const controller = new AbortController();
  const aborted = fakeProvider();
  aborted.create = async () => { aborted.calls.push("create"); controller.abort(); };
  await assert.rejects(createPreviewAdapter({ provider: aborted, signal: controller.signal }).deploy(plan, active), { name: "AbortError" });
  assert.equal(aborted.calls.filter((call) => call === "cleanup").length, 1);
});

test("compose provider uses fixed executable argv, inspects labels, and refuses production operations", async () => {
  const plan = createPreviewResourcePlan(base);
  const secret = "x".repeat(32);
  const invocations = [];
  const evidenceLabels = Object.fromEntries(["project", "hostname", "database", "queue", "queue_status", "storage", "worker_pool", "worker_pool_status", "image_ref", "database_image_ref"].map((field) => [`moa.preview.${field}`, plan[field]]));
  const rows = ["gateway", "database"].map((service, index) => ({ ID: String(index + 1).repeat(12), Service: service, Project: plan.project, Name: `${plan.project}-${service}-1`, Health: "healthy", Labels: evidenceLabels }));
  const refs = { gateway: plan.image_ref, database: plan.database_image_ref };
  const ids = { gateway: "sha256:" + "1".repeat(64), database: "sha256:" + "2".repeat(64) };
  const containers = rows.map((row) => ({ Image: ids[row.Service], Config: { Image: refs[row.Service], Labels: { "com.docker.compose.service": row.Service }, Env: row.Service === "database" ? ["POSTGRES_USER=preview", `POSTGRES_PASSWORD=${secret}`, `POSTGRES_DB=${plan.database}`] : row.Service === "gateway" ? [`DATABASE_URL=postgres://preview:${secret}@database:5432/${plan.database}`, "DATA_DIR=/app/data/preview", `MOA_QUEUE_NAMESPACE=${plan.queue}`, "MOA_QUEUE_STATUS=disabled-but-isolated", `MOA_STORAGE_NAMESPACE=${plan.storage}`, `MOA_WORKER_POOL=${plan.worker_pool}`, "MOA_WORKER_POOL_STATUS=disabled-but-isolated"] : [] }, NetworkSettings: { Networks: { [`${plan.project}_default`]: {} } }, Mounts: row.Service === "database" ? [{ Type: "volume", Name: `${plan.project}_preview-db` }] : [{ Type: "volume", Name: `${plan.project}_preview-storage` }] }));
  const mounts = { gateway: [{ type: "volume", source: "preview-storage", target: "/app/data/preview" }], database: [{ type: "volume", source: "preview-db", target: "/var/lib/postgresql/data" }], queue: [{ type: "volume", source: "preview-queue", target: "/data" }] };
  const config = { services: { gateway: { image: plan.image_ref, labels: evidenceLabels, environment: { DATABASE_URL: `postgres://preview:${secret}@database:5432/${plan.database}`, DATA_DIR: "/app/data/preview", MOA_QUEUE_NAMESPACE: plan.queue, MOA_QUEUE_STATUS: "disabled-but-isolated", MOA_STORAGE_NAMESPACE: plan.storage, MOA_WORKER_POOL: plan.worker_pool, MOA_WORKER_POOL_STATUS: "disabled-but-isolated" }, volumes: mounts.gateway }, database: { image: plan.database_image_ref, labels: evidenceLabels, environment: { POSTGRES_USER: "preview", POSTGRES_PASSWORD: secret, POSTGRES_DB: plan.database }, volumes: mounts.database } }, networks: { default: { name: `${plan.project}_default` } }, volumes: { "preview-db": { name: `${plan.project}_preview-db` }, "preview-storage": { name: `${plan.project}_preview-storage` } } };
  const provider = createComposePreviewProvider({ dbPassword: secret, run: async (exe, argv, options) => {
    invocations.push({ exe, argv, options });
    if (argv[0] === "container") return { stdout: JSON.stringify(containers) };
    if (argv[0] === "image") { const ref = argv.at(-1); const service = Object.entries(refs).find(([, value]) => value === ref)[0]; return { stdout: JSON.stringify([{ Id: ids[service], RepoDigests: [ref], Config: { Labels: service === "gateway" ? { "org.opencontainers.image.revision": plan.commit_sha } : {} } }]) }; }
    if (argv.includes("config")) return { stdout: JSON.stringify(config) };
    return { stdout: JSON.stringify(rows) };
  } });
  await provider.create(plan, { timeout_ms: 123 });
  const inspected = await provider.inspect(plan, { timeout_ms: 123 });
  assert.equal(inspected.hostname, plan.hostname);
  assert.equal(invocations[0].exe, "docker");
  assert.equal(invocations[0].options.shell, false);
  assert.equal(invocations[0].argv.includes("config"), true);
  assert.equal(invocations[0].argv.includes("safe.yml"), false, "caller cannot select a compose path");
  assert.deepEqual(invocations[0].argv.slice(0, 5), ["compose", "--project-directory", require("node:path").resolve(__dirname, "../.."), "--file", "-"]);
  const capturedCompose = Buffer.from(invocations[0].options.input);
  assert.equal(invocations[0].options.max_input_bytes, capturedCompose.length);
  assert.equal(invocations[0].options.timeout, 123);
  assert.throws(() => provider.apply(), /cannot apply/);
  assert.throws(() => provider.rollback(), /cannot roll back/);
  await assert.rejects(provider.create({ ...plan, project: "--project-directory=/" }), /invalid preview Compose/);
  invocations[0].options.input.fill(0);
  await provider.health(plan, null, {});
  assert.deepEqual(invocations.at(-1).options.input, capturedCompose, "runner mutation cannot alter captured Compose bytes");
});

test("poller has an injected, abortable preview-only seam", async () => {
  const handled = [];
  const poller = createPreviewPoller({ listPending: async () => [{ request_id: "r1" }], handleRequest: async (item) => handled.push(item.request_id) });
  assert.deepEqual(await poller.pollOnce(), { stopped: false, handled: 1 });
  assert.deepEqual(handled, ["r1"]);
});

test("Compose preflight rejects privilege, host resources, production identities, and mutable images", () => {
  const plan = createPreviewResourcePlan(base);
  const secret = "x".repeat(32);
  const labels = Object.fromEntries(["project", "hostname", "database", "queue", "storage", "worker_pool", "image_ref", "database_image_ref", "queue_status", "worker_pool_status"].map((field) => [`moa.preview.${field}`, plan[field]]));
  const gatewayEnv = { DATABASE_URL: `postgres://preview:${secret}@database:5432/${plan.database}`, DATA_DIR: "/app/data/preview", MOA_QUEUE_NAMESPACE: plan.queue, MOA_QUEUE_STATUS: "disabled-but-isolated", MOA_STORAGE_NAMESPACE: plan.storage, MOA_WORKER_POOL: plan.worker_pool, MOA_WORKER_POOL_STATUS: "disabled-but-isolated" };
  const valid = { services: { gateway: { image: plan.image_ref, labels, environment: gatewayEnv, volumes: [{ type: "volume", source: "preview-storage", target: "/app/data/preview" }] }, database: { image: plan.database_image_ref, labels, environment: { POSTGRES_USER: "preview", POSTGRES_PASSWORD: secret, POSTGRES_DB: plan.database }, volumes: [{ type: "volume", source: "preview-db", target: "/var/lib/postgresql/data" }] } }, networks: { default: { name: `${plan.project}_default` } }, volumes: { "preview-db": { name: `${plan.project}_preview-db` }, "preview-storage": { name: `${plan.project}_preview-storage` } } };
  assert.doesNotThrow(() => validateComposeConfig(JSON.stringify(valid), plan, secret));
  assert.throws(() => validateComposeConfig(JSON.stringify({ ...valid, services: { ...valid.services, gateway: { ...valid.services.gateway, privileged: true } } }), plan, secret), /forbidden field/);
  assert.throws(() => validateComposeConfig(JSON.stringify({ ...valid, services: { ...valid.services, gateway: { ...valid.services.gateway, volumes: [{ type: "bind", source: "/var/run/docker.sock" }] } } }), plan, secret), /non-allowlisted volume/);
  assert.throws(() => validateComposeConfig(JSON.stringify({ ...valid, networks: { default: { external: true } } }), plan, secret), /non-preview network/);
  assert.throws(() => validateComposeConfig(JSON.stringify({ ...valid, services: { ...valid.services, gateway: { ...valid.services.gateway, environment: { PRODUCTION_TOKEN: "x" } } } }), plan, secret), /non-allowlisted environment/);
  assert.throws(() => validateComposeConfig(JSON.stringify({ ...valid, services: { ...valid.services, gateway: { ...valid.services.gateway, image: "registry.example/moa:latest" } } }), plan, secret), /image digest mismatch/);
  for (const databaseUrl of [`postgres://preview:${secret}@production-db:5432/${plan.database}`, `postgres://preview:wrong@database:5432/${plan.database}`, `postgres://preview:${secret}@database:5432/${plan.database}?sslmode=disable`, `postgres://preview:${secret}@database:5432/${plan.database}#fragment`]) {
    assert.throws(() => validateComposeConfig(JSON.stringify({ ...valid, services: { ...valid.services, gateway: { ...valid.services.gateway, environment: { ...gatewayEnv, DATABASE_URL: databaseUrl } } } }), plan, secret), /does not exactly match/);
  }
  assert.throws(() => validateComposeConfig(JSON.stringify({ ...valid, services: { ...valid.services, gateway: { ...valid.services.gateway, environment: { ...gatewayEnv, MOA_STORAGE_NAMESPACE: "production-storage" } } } }), plan, secret), /isolation environment mismatch/);
});
