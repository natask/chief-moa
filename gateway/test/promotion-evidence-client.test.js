"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createPromotionEvidence } = require("../../scripts/vps/create-promotion-evidence");

const input = (output) => ({
  commit: "a".repeat(40), "control-plane-url": "https://control.example.test", output,
  "preview-url": "http://127.0.0.1:18787", "active-url": "https://api.example.test",
  "database-ref": "database://preview", "queue-ref": "queue://preview",
  "storage-ref": "storage://preview", "worker-pool-ref": "workers://preview",
  "drain-resume-ref": "health://drained", "compatibility-ref": "restore://compatible",
  "backup-restore-ref": "backup://passed", "rollback-ref": "git://rollback",
  "post-apply-smoke-ref": "smoke://planned",
});
const env = {
  MOA_DEPLOY_USER_TOKEN: "user-token-distinct-1234567890123456",
  MOA_DEPLOY_REVIEWER_TOKEN: "review-token-distinct-12345678901234",
  MOA_PREVIEW_DEPLOYER_TOKEN: "preview-token-distinct-123456789012",
  MOA_PRODUCTION_PROMOTER_TOKEN: "apply-token-distinct-12345678901234",
  MOA_PRODUCTION_PROMOTER_ID: "production-promoter",
};

test("promotion evidence client binds each M4 transition to its scoped role", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moa-promotion-client-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const output = path.join(directory, "evidence.json");
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ pathname: new URL(url).pathname, token: options.headers.authorization, body: JSON.parse(options.body) });
    const payload = calls.length === 1 ? { request: { request_id: "request-1" } } : {};
    return new Response(JSON.stringify(payload), { status: calls.length === 1 ? 202 : 200, headers: { "content-type": "application/json" } });
  };
  t.after(() => { global.fetch = originalFetch; });
  const evidence = await createPromotionEvidence(input(output), env);
  assert.equal(evidence.request_id, "request-1");
  assert.deepEqual(calls.map((call) => call.token), [
    `Bearer ${env.MOA_DEPLOY_USER_TOKEN}`,
    `Bearer ${env.MOA_DEPLOY_REVIEWER_TOKEN}`,
    `Bearer ${env.MOA_PREVIEW_DEPLOYER_TOKEN}`,
    `Bearer ${env.MOA_PREVIEW_DEPLOYER_TOKEN}`,
    `Bearer ${env.MOA_PREVIEW_DEPLOYER_TOKEN}`,
    `Bearer ${env.MOA_PRODUCTION_PROMOTER_TOKEN}`,
  ]);
  assert.equal(JSON.parse(fs.readFileSync(output, "utf8")).candidate_commit, "a".repeat(40));
  assert.equal(fs.statSync(output).mode & 0o777, 0o600);
});

test("promotion evidence client rejects aliased role credentials", async () => {
  const duplicate = { ...env, MOA_DEPLOY_REVIEWER_TOKEN: env.MOA_DEPLOY_USER_TOKEN };
  await assert.rejects(createPromotionEvidence(input("/tmp/not-written.json"), duplicate), /must be distinct/);
});
