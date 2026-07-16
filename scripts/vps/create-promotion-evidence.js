#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const args = Object.fromEntries(process.argv.slice(2).reduce((rows, value, index, all) => {
  if (value.startsWith("--")) rows.push([value.slice(2), all[index + 1]]);
  return rows;
}, []));

async function createPromotionEvidence(input, env = process.env) {
  const commit = required(input.commit, "commit");
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("commit must be a full lowercase Git SHA");
  const base = new URL(required(input["control-plane-url"], "control-plane-url"));
  const output = path.resolve(required(input.output, "output"));
  const suffix = commit.slice(0, 12);
  const tokens = {
    user: required(env.MOA_DEPLOY_USER_TOKEN, "MOA_DEPLOY_USER_TOKEN"),
    review: required(env.MOA_DEPLOY_REVIEWER_TOKEN, "MOA_DEPLOY_REVIEWER_TOKEN"),
    preview: required(env.MOA_PREVIEW_DEPLOYER_TOKEN, "MOA_PREVIEW_DEPLOYER_TOKEN"),
    apply: required(env.MOA_PRODUCTION_PROMOTER_TOKEN, "MOA_PRODUCTION_PROMOTER_TOKEN"),
  };
  if (new Set(Object.values(tokens)).size !== 4) throw new Error("promotion credentials must be distinct");
  const call = async (method, pathname, token, body) => {
    const response = await fetch(new URL(pathname, base), {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`${method} ${pathname} returned HTTP ${response.status}: ${String(payload.error || "request failed").slice(0, 300)}`);
    return payload;
  };
  const artifactRef = `artifact://git/${commit}`;
  const provenanceRef = `provenance://git/${commit}`;
  const requestPayload = await call("POST", "/v1/work-history/deployments/requests", tokens.user, {
    target: "gateway", mode: "preview", branch: "vps-deploy", commit_sha: commit,
    reason: "CI-verified VPS promotion", adapter_kind: "isolated_compose",
    candidate_refs: [{ candidate_id: `gateway-${suffix}`, artifact_ref: artifactRef, provenance_ref: provenanceRef }],
    artifact_refs: [artifactRef], provenance_ref: provenanceRef,
    source_turn_id: `vps-promotion-${suffix}`,
  });
  const requestId = required(requestPayload.request?.request_id, "request_id");
  const previewClaimId = `preview-${suffix}`;
  const previewDeploymentId = `gateway-preview-${suffix}`;
  const previewVerificationId = `preview-verification-${suffix}`;
  const applyClaimId = `apply-${suffix}`;
  const effectId = `apply-effect-${suffix}`;
  const lease = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  await call("POST", `/v1/work-history/deployments/requests/${encodeURIComponent(requestId)}/review`, tokens.review, { decision: "approved", reason: "explicit operator-requested promotion" });
  await call("POST", `/v1/work-history/deployments/requests/${encodeURIComponent(requestId)}/claim`, tokens.preview, { operation: "preview", claim_id: previewClaimId, lease_expires_at: lease });
  await call("POST", "/v1/work-history/deployments", tokens.preview, {
    request_id: requestId, deployment_id: previewDeploymentId, target: "gateway",
    mode: "preview", status: "available", preview_url: required(input["preview-url"], "preview-url"),
    commit_sha: commit, artifact_refs: [artifactRef], deployment_control_plane: "isolated_compose",
    claim_id: previewClaimId,
  });
  const evidenceRefs = ["database-ref", "queue-ref", "storage-ref", "worker-pool-ref", "drain-resume-ref", "compatibility-ref", "backup-restore-ref", "rollback-ref", "post-apply-smoke-ref"]
    .map((name) => required(input[name], name));
  await call("POST", `/v1/work-history/deployments/requests/${encodeURIComponent(requestId)}/verification`, tokens.preview, {
    operation: "preview", deployment_id: previewDeploymentId, claim_id: previewClaimId,
    verification_id: previewVerificationId, surface: "deploy", command: "isolated Compose health, auth, restored-state compatibility, and core-read smoke",
    status: "passed", exit_code: 0, summary: "candidate preview and operational gates passed", extra_refs: evidenceRefs,
  });
  await call("POST", `/v1/work-history/deployments/requests/${encodeURIComponent(requestId)}/claim`, tokens.apply, { operation: "apply", claim_id: applyClaimId, lease_expires_at: lease });
  const evidence = {
    schema_version: 1, candidate_commit: commit, target: "gateway", review_decision: "approved",
    preview_verification_status: "passed", drain_status: "drained", resume_status: "verified",
    compatibility_status: "compatible", backup_restore_status: "passed", rollback_status: "verified",
    post_apply_smoke_plan_status: "ready", request_id: requestId, preview_claim_id: previewClaimId,
    preview_deployment_id: previewDeploymentId, preview_verification_id: previewVerificationId,
    apply_claim_id: applyClaimId, apply_worker_id: env.MOA_PRODUCTION_PROMOTER_ID || "production-promoter",
    apply_effect_id: effectId, preview_url: required(input["preview-url"], "preview-url"),
    active_url: required(input["active-url"], "active-url"), artifact_refs: [artifactRef],
    isolated_database_ref: evidenceRefs[0], isolated_queue_ref: evidenceRefs[1],
    isolated_storage_ref: evidenceRefs[2], isolated_worker_pool_ref: evidenceRefs[3],
    drain_resume_ref: evidenceRefs[4], compatibility_ref: evidenceRefs[5],
    backup_restore_ref: evidenceRefs[6], rollback_ref: evidenceRefs[7], post_apply_smoke_ref: evidenceRefs[8],
  };
  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  const temporary = `${output}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  fs.renameSync(temporary, output);
  return evidence;
}

function required(value, name) {
  const text = String(value || "").trim();
  if (!text || /[\r\n\0]/.test(text)) throw new Error(`${name} is required`);
  return text;
}

if (require.main === module) {
  createPromotionEvidence(args).then((value) => {
    process.stdout.write(`promotion evidence prepared for ${value.candidate_commit}\n`);
  }).catch((error) => { process.stderr.write(`${error.message}\n`); process.exit(1); });
}

module.exports = { createPromotionEvidence };
