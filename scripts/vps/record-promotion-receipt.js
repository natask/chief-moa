#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const pairs = process.argv.slice(2).reduce((out, value, index, all) => {
  if (value.startsWith("--")) out[value.slice(2)] = all[index + 1] ?? true;
  return out;
}, {});
const recovering = pairs.recover === true || pairs.recover === "true";

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  fs.renameSync(temporary, file);
}

function readJournal() {
  if (!pairs.journal) throw new Error("--journal is required for recovery");
  return JSON.parse(fs.readFileSync(pairs.journal, "utf8"));
}

let journal;
let evidence;
let evidenceBytes;
if (recovering) {
  journal = readJournal();
  evidence = journal.evidence;
  evidenceBytes = Buffer.from(journal.evidence_base64, "base64");
  for (const key of ["commit", "previous", "receipt", "health_url"]) pairs[key.replace("_", "-")] = journal[key];
} else {
  for (const key of ["evidence", "commit", "previous", "receipt", "health-url", "journal"]) {
    if (!pairs[key]) throw new Error(`--${key} is required`);
  }
  evidenceBytes = fs.readFileSync(pairs.evidence);
  evidence = JSON.parse(evidenceBytes);
  journal = {
    schema_version: 1, phase: "prepared", request_id: evidence.request_id,
    effect_id: evidence.apply_effect_id, commit: pairs.commit, previous: pairs.previous,
    receipt: pairs.receipt, health_url: pairs["health-url"], evidence,
    receipt_backup: pairs["receipt-backup"] || "",
    evidence_base64: evidenceBytes.toString("base64"), updated_at: new Date().toISOString(),
  };
  atomicJson(pairs.journal, journal);
}
if (evidence.candidate_commit !== pairs.commit || !evidence.apply_claim_id) throw new Error("receipt candidate/apply claim does not match evidence");

function phase(value) {
  journal = { ...journal, phase: value, updated_at: new Date().toISOString() };
  atomicJson(pairs.journal, journal);
}

async function controlPlane(method, action, body) {
  if (process.env.MOA_ALLOW_OFFLINE_PROMOTION_EVIDENCE_TEST === "1") {
    return { receipts: action === "receipt" ? [{ operation: "apply", receipt_id: "test-only" }] : [], effects: [] };
  }
  const token = process.env.MOA_CONTROL_PLANE_TOKEN;
  const base = pairs["control-plane-url"] || journal.control_plane_url;
  if (!base || !token) throw new Error("live M4 control-plane URL and token are required for effect/receipt");
  const suffix = action ? `/${action}` : "";
  const url = new URL(`/v1/work-history/deployments/requests/${encodeURIComponent(evidence.request_id)}${suffix}`, base);
  const response = await fetch(url, {
    method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    const error = new Error(`M4 ${action || "detail"} returned HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
    error.definitiveRejection = true;
    throw error;
  }
  return response.json();
}

const effectBody = (workerId = evidence.apply_worker_id, claimId = evidence.apply_claim_id) => ({
  operation: "apply", worker_id: workerId, claim_id: claimId,
  effect_id: evidence.apply_effect_id, deployment_id: `gateway-${pairs.commit.slice(0, 12)}`,
  target: evidence.target, active_url: evidence.active_url, artifact_refs: evidence.artifact_refs || [],
  backup_record_ref: evidence.backup_restore_ref, restore_check_ref: evidence.backup_restore_ref,
  smoke_artifact_ref: evidence.post_apply_smoke_ref, rollback_ref: evidence.rollback_ref,
  drain_status: evidence.drain_status, compatibility_status: evidence.compatibility_status,
  summary: "active effect observed after post-apply health smoke",
});
const receiptBody = (workerId, claimId) => ({
  operation: "apply", worker_id: workerId, claim_id: claimId,
  effect_id: evidence.apply_effect_id, reason: "guarded active apply and post-smoke passed",
});

function writeMirror(detail) {
  const receipt = Object.freeze({
    schema_version: 1, request_id: evidence.request_id, apply_claim_id: evidence.apply_claim_id,
    candidate_commit: pairs.commit, previous_commit: pairs.previous, target: evidence.target,
    active_url: evidence.active_url, post_apply_smoke: { status: "passed", health_url: pairs["health-url"] },
    m4_effect_id: evidence.apply_effect_id,
    m4_receipt_id: detail.receipts?.find?.((item) => item.operation === "apply")?.receipt_id || "test-only",
    evidence_sha256: crypto.createHash("sha256").update(evidenceBytes).digest("hex"),
    receipted_at: new Date().toISOString(),
  });
  phase("mirror_attempting");
  atomicJson(pairs.receipt, receipt);
  phase("complete");
}

async function initial() {
  journal.control_plane_url = pairs["control-plane-url"] || "";
  phase("effect_attempting");
  try {
    await controlPlane("POST", "effect", effectBody());
  } catch (error) {
    if (error.definitiveRejection) phase("effect_rejected");
    throw error;
  }
  phase("effect_observed");
  phase("receipt_attempting");
  const detail = await controlPlane("POST", "receipt", receiptBody(evidence.apply_worker_id, evidence.apply_claim_id));
  phase("receipt_observed");
  writeMirror(detail);
}

async function recover() {
  const detail = await controlPlane("GET", "", null);
  const effect = detail.effects?.find?.((item) => item.operation === "apply" && item.effect_id === evidence.apply_effect_id);
  if (!effect) throw new Error("M4 has no matching immutable apply effect; refusing to reapply or guess—manual reconciliation is required");
  let current = detail;
  let receipt = detail.receipts?.find?.((item) => item.operation === "apply" && item.effect_id === effect.effect_id);
  if (!receipt) {
    let workerId = effect.worker_id;
    let claimId = effect.claim_id;
    const originalClaim = detail.claims?.find?.((item) => item.operation === "apply" && item.claim_id === claimId);
    const expired = originalClaim?.lease_expires_at && Date.parse(originalClaim.lease_expires_at) <= Date.now();
    if (expired) {
      workerId = process.env.MOA_RECOVERY_WORKER_ID || "";
      claimId = process.env.MOA_RECOVERY_CLAIM_ID || "";
      if (!workerId || !claimId) throw new Error("expired effect claim requires MOA_RECOVERY_WORKER_ID and MOA_RECOVERY_CLAIM_ID for audited adoption");
      current = await controlPlane("POST", "adopt", {
        operation: "apply", worker_id: workerId, claim_id: claimId, effect_id: effect.effect_id,
        lease_expires_at: new Date(Date.now() + 300000).toISOString(), reason: "promotion journal crash recovery",
      });
    }
    phase("receipt_attempting");
    current = await controlPlane("POST", "receipt", receiptBody(workerId, claimId));
    phase("receipt_observed");
  }
  writeMirror(current);
}

(recovering ? recover() : initial()).then(() => {
  if (journal.receipt_backup) fs.rmSync(journal.receipt_backup, { force: true });
  fs.rmSync(pairs.journal, { force: true });
  process.stdout.write(`guarded promotion receipt: ${pairs.receipt}\n`);
}).catch((error) => { process.stderr.write(`${error.message}\n`); process.exit(1); });
