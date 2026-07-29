"use strict";

const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const SHA = /^[0-9a-f]{40}$/;
const BASE_REF = "origin/master";
const LEASE_MS = 15 * 60 * 1000;

function createAndroidFeedbackFixCoordinator(options = {}) {
  const { events, intentWorkflow, releaseControlService } = options;
  if (!events?.appendEvent || !events?.listEvents || !events?.withStreamLock) throw new Error("feedback fix coordinator requires the event substrate");
  if (!intentWorkflow?.createWork || !intentWorkflow?.delivery) throw new Error("feedback fix coordinator requires the intent workflow");
  if (!releaseControlService?.feedbackDetail) throw new Error("feedback fix coordinator requires release feedback lookup");
  const now = typeof options.now === "function" ? options.now : () => new Date();
  const resolveBaseCommit = options.resolveBaseCommit || defaultBaseCommitResolver;

  async function create(input = {}) {
    const authorization = normalizeAuthorization(input.authorization, now);
    const key = required(input.idempotency_key, "idempotency_key", 200);
    const feedbackId = required(input.feedback_id, "feedback_id", 160);
    const objective = required(input.objective, "objective", 2_000);
    const deviceId = required(input.device_id, "device_id", 160);
    const applicationId = required(input.application_id, "application_id", 160);
    const tenantId = required(input.tenant_id, "tenant_id", 160);
    const surface = required(input.surface_id || input.surface, "surface", 80);
    if (surface !== "android") throw conflict("surface_mismatch");
    const digest = hash(`${tenantId}\n${applicationId}\n${deviceId}\n${key}`);
    const requestId = `mreq_${digest.slice(0, 32)}`;

    return events.withStreamLock(`modification-request:${requestId}`, async () => {
      const fingerprint = requestFingerprint(input, authorization, { tenantId, applicationId, deviceId, surface });
      const existing = await requestEvent(requestId);
      if (existing) {
        if (existing.payload.request_fingerprint !== fingerprint) throw conflict("idempotency_key_reused");
        const current = await status(requestId);
        if (current?.identities?.run_id && current?.identities?.owner_id) return current;
      }
      let request = existing?.payload || null;
      if (!request) {
        const feedback = await releaseControlService.feedbackDetail({ ...input, tenant_id: tenantId, application_id: applicationId, device_id: deviceId, surface_id: surface });
        assertExactFeedback(feedback, input, { deviceId, surface });
        const baseCommit = String(await resolveBaseCommit(BASE_REF)).trim().toLowerCase();
        if (!SHA.test(baseCommit)) throw blocked("base_ref_unresolved", `${BASE_REF} did not resolve to a 40-character commit`);
        const createdAt = iso(now());
        request = {
          schema: "modification_request.v1", request_id: requestId, request_fingerprint: fingerprint,
          feedback_id: feedback.feedback_id, assignment_id: feedback.assignment_event_id,
          bundle_id: feedback.bundle_id, surface: feedback.surface_id, release_id: feedback.release_id,
          artifact_sha256: feedback.artifact_sha256, objective, authorization,
          base_ref: BASE_REF, base_commit: baseCommit, status: "creating", blocking_reason: "",
          device_id: deviceId, application_id: applicationId, tenant_id: tenantId, created_at: createdAt,
        };
        await append("modification.request.created", requestId, "created", request, input.actor_id || deviceId, createdAt);
      }
      const createdAt = request.created_at;
      const baseCommit = request.base_commit;
      const intentId = `intent_fix_${digest.slice(0, 32)}`;
      const ownerId = "software-factory/android";
      const leaseId = `lease_${digest.slice(0, 32)}`;
      let linked;
      try {
        linked = await intentWorkflow.createWork({
          intent_id: intentId, title: objective.split(/\r?\n/)[0].slice(0, 200), statement: objective, objective,
          project_id: "chief-moa", turn_id: requestId, surface: "android-feedback-create-fix",
          acceptance_contract_ref: `modification-request://${requestId}`,
          completion_criteria: [
            "Implement the authorized fix from the exact feedback evidence.",
            `Start from ${BASE_REF} at ${baseCommit} and stop on base drift.`,
            "Produce a continuity-signed Android candidate and exact-artifact QA evidence.",
          ],
          owner_hint: ownerId, harness_hint: "codex", wants_run: true,
          workspace_base: { ref: BASE_REF, commit: baseCommit, modification_request_id: requestId, feedback_id: request.feedback_id },
          actor: { kind: "user", id: deviceId },
        });
      } catch (error) {
        await append("modification.request.blocked", requestId, "blocked:create", {
          request_id: requestId, status: "blocked",
          blocking_reason: `lifecycle creation failed: ${String(error.message || error).slice(0, 500)}`,
          partial: error.intent_workflow_partial || null,
        }, "feedback-fix-coordinator", iso(now()));
        throw error;
      }
      if (!linked.run || linked.run.status !== "queued") throw blocked("ownerless_queued_state", "authorized modification did not produce one queued run");
      const lease = {
        schema: "modification_owner_lease.v1", request_id: requestId, owner_id: ownerId, lease_id: leaseId,
        run_id: linked.run.run_id, status: "active", acquired_at: createdAt,
        lease_expires_at: new Date(new Date(createdAt).getTime() + LEASE_MS).toISOString(),
      };
      await append("modification.owner_leased", requestId, "owner", lease, "feedback-fix-coordinator", createdAt);
      await append("modification.request.queued", requestId, "queued", {
        request_id: requestId, status: "queued", intent_id: linked.intent.intent_id,
        task_id: linked.task.task_id, run_id: linked.run.run_id, owner_id: ownerId, lease_id: leaseId,
      }, "feedback-fix-coordinator", createdAt);
      return status(requestId);
    });
  }

  async function status(requestId, scope = null) {
    const safeId = required(requestId, "request_id", 160);
    const all = await events.listEvents({ stream_id: `modification-request:${safeId}`, limit: 100, order: "asc" });
    const created = all.find((event) => event.event_type === "modification.request.created")?.payload;
    if (!created) return null;
    if (scope && (created.tenant_id !== scope.tenant_id
        || created.application_id !== scope.application_id
        || created.device_id !== scope.device_id
        || created.surface !== (scope.surface_id || scope.surface))) return null;
    const queued = all.find((event) => event.event_type === "modification.request.queued")?.payload || null;
    const blockedEvent = [...all].reverse().find((event) => event.event_type === "modification.request.blocked")?.payload || null;
    const lease = [...all].reverse().find((event) => event.event_type === "modification.owner_leased")?.payload || null;
    const delivery = queued?.intent_id ? await intentWorkflow.delivery(queued.intent_id) : null;
    const run = delivery?.run_refs?.find((item) => item.run_id === queued?.run_id) || null;
    const expired = lease?.status === "active" && Date.parse(lease.lease_expires_at) <= new Date(now()).getTime()
      && run && !["completed", "failed", "canceled"].includes(run.status);
    let state = queued ? (expired ? "reclaimable" : run?.status || "queued") : blockedEvent ? "blocked" : "creating";
    let blockingReason = queued ? (expired ? "owner lease expired; request is reclaimable" : "") : blockedEvent?.blocking_reason || "";
    if (state === "queued" && (!lease || !queued.run_id || !queued.owner_id)) {
      state = "blocked"; blockingReason = "ownerless queued state rejected";
    }
    return {
      schema: "modification_status.v1", state, blocking_reason: blockingReason, request: publicRequest(created),
      identities: { request_id: safeId, intent_id: queued?.intent_id || "", task_id: queued?.task_id || "", run_id: queued?.run_id || "", owner_id: queued?.owner_id || lease?.owner_id || "", lease_id: queued?.lease_id || lease?.lease_id || "" },
      intent: delivery ? { intent_id: delivery.intent_id, revision: delivery.intent_revision, state: delivery.lifecycle_state } : null,
      task: delivery?.task_refs?.find((item) => item.task_id === queued?.task_id) || null,
      run, owner_lease: lease ? { ...lease, status: expired ? "expired" : lease.status } : null,
      qa: null, artifact: null, preview: null,
    };
  }

  async function requestEvent(requestId) {
    const rows = await events.listEvents({ stream_id: `modification-request:${requestId}`, event_type: "modification.request.created", limit: 2, order: "asc" });
    if (rows.length > 1) throw blocked("duplicate_request", "multiple request records share one idempotency identity");
    return rows[0] || null;
  }

  function append(type, requestId, suffix, payload, actorId, occurredAt) {
    return events.appendEvent({ event_type: type, stream_id: `modification-request:${requestId}`, occurred_at: occurredAt,
      actor: { kind: "gateway", id: actorId }, correlation_id: requestId,
      idempotency_key: `feedback-fix:${requestId}:${suffix}`, payload });
  }
  return { create, status };
}

function normalizeAuthorization(input, now) {
  if (!input || typeof input !== "object" || Array.isArray(input) || input.kind !== "implementation_authorized" || input.authorized !== true) {
    throw blocked("implementation_not_authorized", "explicit current implementation_authorized Create fix input is required");
  }
  const authorizedAt = iso(input.authorized_at);
  const delta = new Date(now()).getTime() - Date.parse(authorizedAt);
  if (delta > 10 * 60 * 1000 || delta < -60_000) throw blocked("authorization_not_current", "Create fix authorization is not current");
  return { kind: "implementation_authorized", authorized: true, authorized_at: authorizedAt };
}

function assertExactFeedback(feedback, input, trusted) {
  if (!feedback) throw conflict("feedback_not_found");
  const checks = [[feedback.device_id, trusted.deviceId, "feedback_device_mismatch"], [feedback.surface_id, trusted.surface, "surface_mismatch"],
    [feedback.assignment_event_id, input.assignment_id || input.assignment_event_id, "assignment_mismatch"], [feedback.bundle_id, input.bundle_id, "bundle_mismatch"],
    [feedback.release_id, input.release_id, "release_mismatch"], [feedback.artifact_sha256, String(input.artifact_sha256 || input.sha256 || "").toLowerCase(), "artifact_mismatch"]];
  for (const [actual, expected, reason] of checks) if (!expected || actual !== expected) throw conflict(reason);
}

function requestFingerprint(input, authorization, trusted) {
  return hash(JSON.stringify({ feedback_id: String(input.feedback_id || ""), assignment_id: String(input.assignment_id || input.assignment_event_id || ""),
    bundle_id: String(input.bundle_id || ""), release_id: String(input.release_id || ""), artifact_sha256: String(input.artifact_sha256 || input.sha256 || "").toLowerCase(),
    objective: String(input.objective || "").trim(), authorization, ...trusted }));
}

function publicRequest(request) { const { request_fingerprint, tenant_id, device_id, ...visible } = request; return visible; }
function defaultBaseCommitResolver(ref) { const configured = String(process.env.MOA_BUILD_SHA || "").trim().toLowerCase(); return SHA.test(configured) ? configured : execFileSync("git", ["rev-parse", "--verify", ref], { encoding: "utf8", timeout: 5_000 }).trim(); }
function required(value, field, max) { const text = String(value || "").trim(); if (!text || text.length > max) throw new Error(`${field} is invalid`); return text; }
function iso(value) { const date = value instanceof Date ? value : new Date(value); if (!Number.isFinite(date.getTime())) throw new Error("timestamp is invalid"); return date.toISOString(); }
function hash(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function conflict(reason) { const error = new Error(reason); error.code = "modification_request_conflict"; error.reason = reason; return error; }
function blocked(reason, message) { const error = new Error(message || reason); error.code = "modification_request_blocked"; error.reason = reason; return error; }

module.exports = { BASE_REF, createAndroidFeedbackFixCoordinator };
