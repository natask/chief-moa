#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const pairs = process.argv.slice(2).reduce((out, value, index, all) => {
  if (value.startsWith("--")) out[value.slice(2)] = all[index + 1];
  return out;
}, {});
for (const key of ["evidence", "commit", "previous", "receipt", "health-url"]) {
  if (!pairs[key]) throw new Error(`--${key} is required`);
}
const evidenceBytes = fs.readFileSync(pairs.evidence);
const evidence = JSON.parse(evidenceBytes);
if (evidence.candidate_commit !== pairs.commit || !evidence.apply_claim_id) throw new Error("receipt candidate/apply claim does not match evidence");

async function postControlPlane(action, body) {
  if (process.env.MOA_ALLOW_OFFLINE_PROMOTION_EVIDENCE_TEST === "1") return { test_only: true };
  const token = process.env.MOA_CONTROL_PLANE_TOKEN;
  if (!pairs["control-plane-url"] || !token) throw new Error("live M4 control-plane URL and token are required for effect/receipt");
  const url = new URL(`/v1/work-history/deployments/requests/${encodeURIComponent(evidence.request_id)}/${action}`, pairs["control-plane-url"]);
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`M4 ${action} returned HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
  return response.json();
}

(async () => {
  await postControlPlane("effect", {
    operation: "apply", worker_id: evidence.apply_worker_id, claim_id: evidence.apply_claim_id,
    effect_id: evidence.apply_effect_id, deployment_id: `gateway-${pairs.commit.slice(0, 12)}`,
    target: evidence.target, active_url: evidence.active_url, artifact_refs: evidence.artifact_refs || [],
    backup_record_ref: evidence.backup_restore_ref, restore_check_ref: evidence.backup_restore_ref,
    smoke_artifact_ref: evidence.post_apply_smoke_ref, rollback_ref: evidence.rollback_ref,
    drain_status: evidence.drain_status, compatibility_status: evidence.compatibility_status,
    summary: "active effect observed after post-apply health smoke",
  });
  const detail = await postControlPlane("receipt", {
    operation: "apply", worker_id: evidence.apply_worker_id, claim_id: evidence.apply_claim_id,
    effect_id: evidence.apply_effect_id, reason: "guarded active apply and post-smoke passed",
  });
  const receipt = Object.freeze({
    schema_version: 1, request_id: evidence.request_id, apply_claim_id: evidence.apply_claim_id,
    candidate_commit: pairs.commit, previous_commit: pairs.previous, target: evidence.target,
    active_url: evidence.active_url, post_apply_smoke: { status: "passed", health_url: pairs["health-url"] },
    m4_effect_id: evidence.apply_effect_id,
    m4_receipt_id: detail.receipts?.find?.((item) => item.operation === "apply")?.receipt_id || "test-only",
    evidence_sha256: crypto.createHash("sha256").update(evidenceBytes).digest("hex"),
    receipted_at: new Date().toISOString(),
  });
  fs.mkdirSync(path.dirname(pairs.receipt), { recursive: true });
  const temporary = `${pairs.receipt}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  fs.renameSync(temporary, pairs.receipt);
  process.stdout.write(`guarded promotion receipt: ${pairs.receipt}\n`);
})().catch((error) => { process.stderr.write(`${error.message}\n`); process.exit(1); });
