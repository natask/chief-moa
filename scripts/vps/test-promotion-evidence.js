#!/usr/bin/env node
"use strict";
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const validator = path.join(__dirname, "validate-promotion-evidence.js");
const receiptWriter = path.join(__dirname, "record-promotion-receipt.js");
const base = {
  schema_version: 1, candidate_commit: "a".repeat(40), target: "gateway", review_decision: "approved",
  preview_verification_status: "passed", drain_status: "drained", resume_status: "verified",
  compatibility_status: "compatible", backup_restore_status: "not_required", rollback_status: "verified",
  post_apply_smoke_plan_status: "ready", active_url: "https://api.example.test",
  request_id: "request-1", review_id: "review-1", preview_claim_id: "preview-claim-1",
  preview_deployment_id: "preview-deployment-1", preview_verification_id: "preview-verification-1",
  apply_claim_id: "apply-claim-1", apply_worker_id: "apply-worker-1", apply_effect_id: "apply-effect-1",
  preview_url: "https://preview.example.test",
  isolated_database_ref: "verification://database/preview-1",
  isolated_queue_ref: "verification://queue/preview-1",
  isolated_storage_ref: "verification://storage/preview-1",
  isolated_worker_pool_ref: "verification://workers/preview-1",
  drain_resume_ref: "verification://drain-resume/preview-1",
  compatibility_ref: "verification://compatibility/additive-state-contract",
  backup_restore_ref: "verification://state-preservation/persistent-volumes-preserved",
  rollback_ref: "rollback://git/previous",
  post_apply_smoke_ref: "smoke://active/health",
};
function run(value) {
  const file = path.join(os.tmpdir(), `moa-promotion-${process.pid}.json`);
  const snapshot = path.join(os.tmpdir(), `moa-promotion-snapshot-${process.pid}.json`);
  fs.writeFileSync(file, JSON.stringify(value));
  fs.writeFileSync(snapshot, JSON.stringify({
    request: { request_id: value.request_id, commit_sha: value.candidate_commit, target: value.target },
    review: { decision: value.review_decision },
    latest_preview: { deployment_id: value.preview_deployment_id, preview_url: value.preview_url },
    latest_preview_verification: {
      verification_id: value.preview_verification_id, status: value.preview_verification_status,
      extra_refs: [value.isolated_database_ref, value.isolated_queue_ref, value.isolated_storage_ref,
        value.isolated_worker_pool_ref, value.drain_resume_ref, value.compatibility_ref,
        value.backup_restore_ref, value.rollback_ref, value.post_apply_smoke_ref],
    },
    claims: [
      { operation: "preview", claim_id: value.preview_claim_id },
      { operation: "apply", claim_id: value.apply_claim_id, worker_id: value.apply_worker_id, lease_expires_at: "2099-01-01T00:00:00Z" },
    ],
  }));
  const result = spawnSync(process.execPath, [validator, "--file", file, "--commit", base.candidate_commit, "--target", "gateway", "--control-plane-snapshot", snapshot], {
    encoding: "utf8", env: { ...process.env, MOA_ALLOW_OFFLINE_PROMOTION_EVIDENCE_TEST: "1" },
  });
  fs.rmSync(file, { force: true });
  fs.rmSync(snapshot, { force: true });
  return result;
}
assert.equal(run(base).status, 0);
for (const mutation of [
  { preview_verification_status: "failed" }, { candidate_commit: "b".repeat(40) },
  { isolated_queue_ref: base.isolated_database_ref }, { preview_url: base.active_url },
  { backup_restore_ref: "x\nforged" }, { apply_claim_id: "" },
]) assert.notEqual(run({ ...base, ...mutation }).status, 0, JSON.stringify(mutation));
const evidenceFile = path.join(os.tmpdir(), `moa-promotion-receipt-evidence-${process.pid}.json`);
const receiptFile = path.join(os.tmpdir(), `moa-promotion-receipt-${process.pid}.json`);
const journalFile = path.join(os.tmpdir(), `moa-promotion-journal-${process.pid}.json`);
fs.writeFileSync(evidenceFile, JSON.stringify(base));
let receiptResult = spawnSync(process.execPath, [receiptWriter,
  "--evidence", evidenceFile, "--commit", base.candidate_commit,
  "--previous", "b".repeat(40), "--receipt", receiptFile,
  "--journal", journalFile,
  "--health-url", "http://127.0.0.1:8787/health",
], { encoding: "utf8", env: { ...process.env, MOA_ALLOW_OFFLINE_PROMOTION_EVIDENCE_TEST: "1" } });
assert.equal(receiptResult.status, 0, receiptResult.stderr);
const receipt = JSON.parse(fs.readFileSync(receiptFile, "utf8"));
assert.equal(receipt.request_id, base.request_id);
assert.equal(receipt.apply_claim_id, base.apply_claim_id);
assert.equal(receipt.post_apply_smoke.status, "passed");
receiptResult = spawnSync(process.execPath, [receiptWriter,
  "--evidence", evidenceFile, "--commit", "c".repeat(40),
  "--previous", "b".repeat(40), "--receipt", `${receiptFile}.bad`,
  "--journal", `${journalFile}.bad`,
  "--health-url", "http://127.0.0.1:8787/health",
], { encoding: "utf8", env: { ...process.env, MOA_ALLOW_OFFLINE_PROMOTION_EVIDENCE_TEST: "1" } });
assert.notEqual(receiptResult.status, 0);
fs.rmSync(evidenceFile, { force: true });
fs.rmSync(receiptFile, { force: true });
fs.rmSync(`${receiptFile}.bad`, { force: true });
fs.rmSync(journalFile, { force: true });
fs.rmSync(`${journalFile}.bad`, { force: true });
process.stdout.write("promotion evidence hostile tests passed (9 cases)\n");
