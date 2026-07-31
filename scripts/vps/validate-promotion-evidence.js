#!/usr/bin/env node
"use strict";

const fs = require("node:fs");

function fail(message) {
  process.stderr.write(`promotion evidence blocked: ${message}\n`);
  process.exit(1);
}

const args = Object.fromEntries(process.argv.slice(2).reduce((rows, value, i, all) => {
  if (value.startsWith("--")) rows.push([value.slice(2), all[i + 1]]);
  return rows;
}, []));
if (!args.file || !args.commit || !args.target) fail("--file, --commit and --target are required");
let evidence;
try { evidence = JSON.parse(fs.readFileSync(args.file, "utf8")); } catch { fail("manifest must be readable strict JSON"); }

const exact = (name, expected) => {
  if (evidence[name] !== expected) fail(`${name} must equal ${expected}`);
};
const ref = (name) => {
  const value = evidence[name];
  if (typeof value !== "string" || value.length < 8 || value.length > 1024 || /[\r\n\0]/.test(value)) fail(`${name} must be a bounded evidence reference`);
};
exact("schema_version", 1);
exact("candidate_commit", args.commit);
exact("target", args.target);
exact("review_decision", "approved");
exact("preview_verification_status", "passed");
exact("drain_status", "drained");
exact("resume_status", "verified");
exact("compatibility_status", "compatible");
exact("backup_restore_status", "not_required");
exact("rollback_status", "verified");
exact("post_apply_smoke_plan_status", "ready");
for (const name of [
  "request_id", "preview_claim_id", "preview_deployment_id",
  "preview_verification_id", "apply_claim_id", "apply_worker_id", "apply_effect_id", "preview_url",
  "isolated_database_ref", "isolated_queue_ref", "isolated_storage_ref",
  "isolated_worker_pool_ref", "drain_resume_ref", "compatibility_ref",
  "backup_restore_ref", "rollback_ref", "post_apply_smoke_ref",
]) ref(name);
ref("active_url");
if (evidence.preview_url === evidence.active_url) fail("preview URL must differ from active URL");
const isolation = ["isolated_database_ref", "isolated_queue_ref", "isolated_storage_ref", "isolated_worker_pool_ref"];
if (new Set(isolation.map((key) => evidence[key])).size !== isolation.length) fail("preview resources must use distinct evidence references");

async function loadControlPlaneDetail() {
  if (process.env.MOA_ALLOW_OFFLINE_PROMOTION_EVIDENCE_TEST === "1" && args["control-plane-snapshot"]) {
    return JSON.parse(fs.readFileSync(args["control-plane-snapshot"], "utf8"));
  }
  const token = process.env.MOA_CONTROL_PLANE_TOKEN;
  if (!args["control-plane-url"] || !token) fail("live M4 control-plane URL and token are required");
  const base = new URL(args["control-plane-url"]);
  const url = new URL(`/v1/work-history/deployments/requests/${encodeURIComponent(evidence.request_id)}`, base);
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) });
  if (!response.ok) fail(`M4 control-plane lookup returned HTTP ${response.status}`);
  return response.json();
}

(async () => {
  const detail = await loadControlPlaneDetail();
  if (detail.request?.request_id !== evidence.request_id) fail("M4 request mismatch");
  if (detail.request?.commit_sha !== evidence.candidate_commit || detail.request?.target !== evidence.target) fail("M4 request candidate mismatch");
  if (detail.review?.decision !== "approved") fail("M4 review is not approved");
  if (detail.latest_preview?.deployment_id !== evidence.preview_deployment_id || detail.latest_preview?.preview_url !== evidence.preview_url) fail("M4 preview mismatch");
  if (detail.latest_preview_verification?.verification_id !== evidence.preview_verification_id || detail.latest_preview_verification?.status !== "passed") fail("M4 preview verification mismatch");
  const previewClaim = detail.claims?.find((claim) => claim.operation === "preview" && claim.claim_id === evidence.preview_claim_id);
  const applyClaims = detail.claims?.filter((claim) => claim.operation === "apply") || [];
  const applyClaim = applyClaims.at(-1);
  if (!previewClaim || applyClaim?.claim_id !== evidence.apply_claim_id || applyClaim?.worker_id !== evidence.apply_worker_id) fail("M4 preview/current apply claims do not match");
  if (!applyClaim.lease_expires_at || Date.parse(applyClaim.lease_expires_at) <= Date.now()) fail("M4 apply claim is not fresh");
  const requiredRefs = isolation.map((key) => evidence[key]).concat([
    evidence.drain_resume_ref, evidence.compatibility_ref, evidence.backup_restore_ref,
    evidence.rollback_ref, evidence.post_apply_smoke_ref,
  ]);
  const recordedRefs = new Set(detail.latest_preview_verification?.extra_refs || []);
  if (requiredRefs.some((value) => !recordedRefs.has(value))) fail("M4 preview verification does not bind all operational evidence references");
  process.stdout.write(`promotion evidence verified against M4 for ${args.target} ${args.commit}\n`);
})().catch((error) => fail(error.message));
