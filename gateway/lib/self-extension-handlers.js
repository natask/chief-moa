"use strict";

function createSelfExtensionHandlers(deps) {
  const {
    artifacts,
    authorizedAgent,
    agentAuthError,
    readJsonBody,
    sendJson,
    cleanError,
    recordProductEventBestEffort,
    now = () => new Date().toISOString(),
  } = deps;

  async function routeSelfExtensions(request, response, url) {
    const pathname = url.pathname;
    const isCollection = pathname === "/v1/self-extension/artifacts";
    const isRuntime = pathname === "/v1/self-extension/runtime";
    const applyMatch = pathname.match(/^\/v1\/self-extension\/artifacts\/([^/]+)\/apply$/);
    if (!(isCollection || isRuntime || applyMatch)) return false;
    if (!authorizedAgent(request)) {
      sendJson(response, 401, agentAuthError());
      return true;
    }
    if (isCollection && request.method === "GET") {
      sendJson(response, 200, {
        artifacts: artifacts.list({
          type: url.searchParams.get("type") || "",
          status: url.searchParams.get("status") || "",
          limit: Number(url.searchParams.get("limit") || 100),
        }),
        active: artifacts.runtime().active,
        known: artifacts.known(),
      });
      return true;
    }
    if (isCollection && request.method === "POST") {
      await handleCreate(request, response);
      return true;
    }
    if (isRuntime && request.method === "GET") {
      sendJson(response, 200, {
        runtime: artifacts.runtime(url.searchParams.get("shell_protocol") || ""),
      });
      return true;
    }
    if (applyMatch && request.method === "POST") {
      await handleApply(request, response, decodeURIComponent(applyMatch[1]));
      return true;
    }
    return false;
  }

  async function handleCreate(request, response) {
    const body = await readJsonBody(request);
    const incoming = body && typeof body === "object" ? (body.artifact || body) : {};
    try {
      const artifact = artifacts.createCandidate(incoming);
      recordProductEventBestEffort({
        event_type: "self_extension.artifact.created",
        stream_id: `self-extension:${artifact.type}`,
        idempotency_key: `self-extension-artifact-created:${artifact.id}`,
        occurred_at: artifact.created_at,
        actor: { kind: "agent", id: "self-extension" },
        correlation_id: artifact.variant_group_id,
        payload: {
          id: artifact.id,
          type: artifact.type,
          title: artifact.title,
          status: artifact.status,
          variant_group_id: artifact.variant_group_id,
          parent_id: artifact.parent_id,
          prompt: artifact.prompt,
          spec: artifact.spec,
          preview: artifact.preview,
          validation: artifact.validation,
          created_at: artifact.created_at,
        },
      });
      sendJson(response, 201, { artifact });
    } catch (error) {
      sendJson(response, 400, { error: cleanError(error) });
    }
  }

  async function handleApply(request, response, id) {
    const body = await readJsonBody(request);
    const applyContext = applyContextFromBody(body, now);
    if (!applyContext.ok) {
      sendJson(response, 400, { error: `invalid self-extension apply metadata: ${applyContext.errors.join("; ")}` });
      return;
    }
    try {
      const artifact = artifacts.apply(id, applyContext.context);
      if (!artifact) {
        sendJson(response, 404, { error: "self-extension artifact not found" });
        return;
      }
      const runtime = artifacts.runtime();
      recordProductEventBestEffort({
        event_type: "self_extension.artifact.applied",
        stream_id: `self-extension:${artifact.type}`,
        idempotency_key: `self-extension-artifact-applied:${artifact.id}:${artifact.applied_at}`,
        occurred_at: artifact.applied_at,
        actor: applyActor(artifact.apply_context),
        correlation_id: artifact.variant_group_id,
        payload: {
          id: artifact.id,
          type: artifact.type,
          title: artifact.title,
          variant_group_id: artifact.variant_group_id,
          spec: artifact.spec,
          preview: artifact.preview,
          applied_at: artifact.applied_at,
          apply_context: artifact.apply_context,
          runtime: runtime.active[artifact.type],
        },
      });
      sendJson(response, 200, { artifact, runtime });
    } catch (error) {
      sendJson(response, 400, { error: cleanError(error) });
    }
  }

  return { routeSelfExtensions, handleCreate, handleApply };
}

function applyActor(applyContext) {
  const mode = cleanToken(applyContext?.approval?.mode, 40);
  const approvedBy = cleanText(applyContext?.approval?.approved_by, 120);
  if (mode === "explicit_user") return { kind: "user", id: approvedBy || "unknown" };
  return { kind: "agent", id: approvedBy || "self-extension", mode: mode || "unknown" };
}

function applyContextFromBody(body, now = () => new Date().toISOString()) {
  const input = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const source = input.source && typeof input.source === "object" && !Array.isArray(input.source)
    ? input.source
    : input.provenance && typeof input.provenance === "object" && !Array.isArray(input.provenance)
      ? input.provenance
      : {};
  const approval = input.approval && typeof input.approval === "object" && !Array.isArray(input.approval)
    ? input.approval
    : {};
  const sourceKind = cleanToken(source.kind || input.source_kind, 40);
  const approvalMode = cleanToken(approval.mode || input.approval_mode, 40);
  const errors = [];
  const sourceKinds = ["user_turn", "agent_run", "manual_api", "smoke"];
  const approvalModes = ["explicit_user", "developer", "test"];
  if (!sourceKind) errors.push("source.kind is required");
  else if (!sourceKinds.includes(sourceKind)) errors.push(`source.kind must be one of: ${sourceKinds.join(", ")}`);
  if (!approvalMode) errors.push("approval.mode is required");
  else if (!approvalModes.includes(approvalMode)) errors.push(`approval.mode must be one of: ${approvalModes.join(", ")}`);
  const approvedBy = cleanText(approval.approved_by || approval.approvedBy || input.approved_by, 120);
  if (!approvedBy) errors.push("approval.approved_by is required");
  if (errors.length > 0) return { ok: false, errors, context: {} };
  return {
    ok: true,
    errors: [],
    context: {
      source: {
        kind: sourceKind,
        turn_id: cleanToken(source.turn_id || source.turnId, 120),
        broker_event_id: cleanToken(source.broker_event_id || source.brokerEventId, 120),
        agent_run_id: cleanToken(source.agent_run_id || source.agentRunId, 120),
        session_id: cleanToken(source.session_id || source.sessionId, 120),
        branch_id: cleanToken(source.branch_id || source.branchId, 120),
        device_id: cleanToken(source.device_id || source.deviceId, 120),
        surface: cleanToken(source.surface, 80),
      },
      approval: {
        mode: approvalMode,
        approved_by: approvedBy,
        approval_id: cleanToken(approval.approval_id || approval.approvalId, 120),
        policy: "self_extension_apply_requires_source_and_approval",
      },
      reason: cleanText(input.reason || approval.reason || source.reason, 240),
      requested_by: cleanText(input.requested_by || input.requestedBy || "", 120),
      recorded_at: now(),
    },
  };
}

function cleanToken(value, max) {
  return typeof value === "string" ? value.trim().replace(/[^a-zA-Z0-9_:-]/g, "").slice(0, max) : "";
}

function cleanText(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

module.exports = { createSelfExtensionHandlers, applyActor, applyContextFromBody };
