"use strict";

import crypto from "node:crypto";
import {
  authorizeReleaseAction,
  artifactForSurface,
  bindExactRelease,
  normalizeAssignmentEvent,
  normalizeChannelHead,
  normalizeInstallReceipt,
  normalizeReleaseBundle,
  normalizeReleaseFeedback,
} from "./domain.mjs";

export function createReleaseControlService({ adapter, now = () => new Date().toISOString(), id = defaultId } = {}) {
  requireMethods(adapter, [
    "listBundles", "listChannelHeads", "listAssignmentEvents", "appendAssignmentEvent",
    "listInstallReceipts", "appendInstallReceipt", "listFeedback", "appendFeedback",
  ]);

  async function view(input) {
    const tenantId = key(input.tenant_id, "tenant_id");
    const applicationId = key(input.application_id, "application_id");
    const deviceId = key(input.device_id, "device_id");
    key(input.surface || input.surface_id, "surface");
    authorize(input, "read", applicationId, "all");
    const [rawBundles, rawHeads, rawAssignments, rawReceipts, feedback] = await Promise.all([
      adapter.listBundles(tenantId, applicationId),
      adapter.listChannelHeads(tenantId, applicationId),
      adapter.listAssignmentEvents(tenantId, applicationId),
      adapter.listInstallReceipts(tenantId, applicationId),
      adapter.listFeedback(tenantId, applicationId),
    ]);
    const bundles = rawBundles.map(normalizeReleaseBundle);
    const heads = latestHeads(rawHeads.map(normalizeChannelHead));
    const assignments = latestAssignments(rawAssignments.map(normalizeAssignmentEvent));
    const effective = effectiveAssignment(assignments, input);
    const installReceipts = rawReceipts.map((item) => normalizeInstallReceipt(item, { allow_unknown_status: true }));
    return {
      schema_version: "release-control-view/v1",
      tenant_id: tenantId,
      application_id: applicationId,
      device_id: deviceId,
      channels: ["stable", "preview"].map((channel) => {
        const head = heads.get(channel) || null;
        return { channel, head, bundle: head ? bundles.find((item) => item.bundle_id === head.bundle_id) || null : null };
      }),
      effective_assignment: effective,
      installation: effective ? installState(effective, installReceipts, bundles) : [],
      feedback_count: feedback.length,
    };
  }

  async function assign(input) {
    const context = await loadContext(input);
    key(input.surface || input.surface_id, "surface");
    const channel = key(input.channel, "channel");
    if (!["stable", "preview"].includes(channel)) throw new Error("channel is invalid");
    authorize(input, "assign_channel", context.applicationId, channel);
    const head = context.heads.get(channel);
    if (!head) throw new Error(`channel head not found: ${channel}`);
    if (input.bundle_id != null && key(input.bundle_id, "bundle_id") !== head.bundle_id) {
      throw mismatch("channel_bundle_mismatch");
    }
    if (input.release_id != null) {
      const bundle = context.bundles.find((item) => item.bundle_id === head.bundle_id);
      const artifact = artifactForSurface(bundle, input.surface || input.surface_id);
      if (!artifact || artifact.release_id !== key(input.release_id, "release_id")) {
        throw mismatch("channel_release_mismatch");
      }
    }
    const stable = context.heads.get("stable");
    if (!stable) throw new Error("stable channel head not found");
    const expected = integer(input.expected_sequence, "expected_sequence", 0);
    const scopeType = key(input.scope_type || "device", "scope_type");
    const scopeId = key(input.scope_id || input.device_id, "scope_id");
    const idempotencyKey = requiredIdempotencyKey(input.idempotency_key);
    const prior = idempotencyKey && context.assignments.find((item) => item.scope_type === scopeType
      && item.scope_id === scopeId && item.idempotency_key === idempotencyKey);
    if (prior) {
      if (prior.channel !== channel || prior.bundle_id !== head.bundle_id) throw mismatch("idempotency_key_reused");
      return prior;
    }
    const event = normalizeAssignmentEvent({
      event_id: input.event_id || idempotentEventId("assign", context, scopeType, scopeId, idempotencyKey) || id("assign"),
      tenant_id: context.tenantId,
      application_id: context.applicationId,
      scope_type: scopeType,
      scope_id: scopeId,
      sequence: expected + 1,
      channel,
      bundle_id: head.bundle_id,
      stable_fallback_bundle_id: stable.bundle_id,
      operation: "assign_channel",
      idempotency_key: idempotencyKey,
      actor_id: input.actor_id,
      created_at: now(),
    });
    return adapter.appendAssignmentEvent(event, expected);
  }

  async function fallback(input) {
    const context = await loadContext(input);
    key(input.surface || input.surface_id, "surface");
    const scopeType = key(input.scope_type || "device", "scope_type");
    const scopeId = key(input.scope_id || input.device_id, "scope_id");
    const current = currentAssignment(context.assignments, scopeType, scopeId);
    if (!current) throw new Error("assignment not found");
    authorize(input, "assign_channel", context.applicationId, "stable");
    const idempotencyKey = requiredIdempotencyKey(input.idempotency_key);
    const prior = idempotencyKey && context.assignments.find((item) => item.scope_type === scopeType
      && item.scope_id === scopeId && item.idempotency_key === idempotencyKey);
    if (prior) {
      if (prior.operation !== "stable_fallback") throw mismatch("idempotency_key_reused");
      return prior;
    }
    const expected = integer(input.expected_sequence, "expected_sequence", 0);
    if (current.sequence !== expected) throw conflict(expected, current.sequence);
    const target = context.bundles.find((bundle) => bundle.bundle_id === current.stable_fallback_bundle_id);
    if (!target) throw new Error("last-known-good stable bundle not found");
    const event = normalizeAssignmentEvent({
      event_id: input.event_id || idempotentEventId("assign", context, scopeType, scopeId, idempotencyKey) || id("assign"),
      tenant_id: context.tenantId,
      application_id: context.applicationId,
      scope_type: scopeType,
      scope_id: scopeId,
      sequence: expected + 1,
      channel: "stable",
      bundle_id: target.bundle_id,
      stable_fallback_bundle_id: target.bundle_id,
      operation: "stable_fallback",
      idempotency_key: idempotencyKey,
      actor_id: input.actor_id,
      created_at: now(),
    });
    return adapter.appendAssignmentEvent(event, expected);
  }

  async function recordInstallReceipt(input) {
    const context = await loadContext(input);
    const idempotencyKey = requiredIdempotencyKey(input.idempotency_key);
    const existingReceipts = (await adapter.listInstallReceipts(context.tenantId, context.applicationId))
      .map((item) => normalizeInstallReceipt(item, { allow_unknown_status: true }));
    const existing = existingReceipts.find((item) => item.device_id === key(input.device_id, "device_id")
      && item.idempotency_key === idempotencyKey);
    if (existing) {
      if (!sameReceiptRequest(existing, input)) throw mismatch("idempotency_key_reused");
      return existing;
    }
    const assignment = assignmentById(context.assignments, input.assignment_event_id);
    if (!assignment) throw new Error("assignment event not found");
    authorize(input, "record_install_receipt", context.applicationId, assignment.channel);
    if (assignment.scope_type === "device" && assignment.scope_id !== key(input.device_id, "device_id")) {
      throw mismatch("assignment_device_mismatch");
    }
    const bundle = context.bundles.find((item) => item.bundle_id === assignment.bundle_id);
    const binding = bindExactRelease(bundle, input);
    if (!binding.accepted) throw mismatch(binding.reason);
    const receipt = normalizeInstallReceipt({
      ...input,
      receipt_id: input.receipt_id || idempotentRecordId("install", context, input.device_id, idempotencyKey) || id("install"),
      tenant_id: context.tenantId,
      application_id: context.applicationId,
      idempotency_key: idempotencyKey,
      created_at: input.created_at || now(),
    });
    return adapter.appendInstallReceipt(receipt);
  }

  async function recordFeedback(input) {
    const context = await loadContext(input);
    const idempotencyKey = requiredIdempotencyKey(input.idempotency_key);
    const existingFeedback = (await adapter.listFeedback(context.tenantId, context.applicationId))
      .map(normalizeReleaseFeedback);
    const existing = existingFeedback.find((item) => item.device_id === key(input.device_id, "device_id")
      && item.idempotency_key === idempotencyKey);
    if (existing) {
      if (!sameFeedbackRequest(existing, input)) throw mismatch("idempotency_key_reused");
      return existing;
    }
    const assignment = assignmentById(context.assignments, input.assignment_event_id);
    if (!assignment) throw new Error("assignment event not found");
    authorize(input, "record_release_feedback", context.applicationId, assignment.channel);
    if (assignment.scope_type === "device" && assignment.scope_id !== key(input.device_id, "device_id")) {
      throw mismatch("assignment_device_mismatch");
    }
    if (assignment.bundle_id !== input.bundle_id) throw mismatch("assignment_bundle_mismatch");
    const bundle = context.bundles.find((item) => item.bundle_id === assignment.bundle_id);
    const binding = bindExactRelease(bundle, input);
    if (!binding.accepted) throw mismatch(binding.reason);
    const feedback = normalizeReleaseFeedback({
      ...input,
      feedback_id: input.feedback_id || idempotentRecordId("feedback", context, input.device_id, idempotencyKey) || id("feedback"),
      tenant_id: context.tenantId,
      application_id: context.applicationId,
      idempotency_key: idempotencyKey,
      created_at: input.created_at || now(),
    });
    return adapter.appendFeedback(feedback);
  }

  async function loadContext(input) {
    const tenantId = key(input.tenant_id, "tenant_id");
    const applicationId = key(input.application_id, "application_id");
    const [bundleRecords, headRecords, assignmentRecords] = await Promise.all([
      adapter.listBundles(tenantId, applicationId),
      adapter.listChannelHeads(tenantId, applicationId),
      adapter.listAssignmentEvents(tenantId, applicationId),
    ]);
    return {
      tenantId,
      applicationId,
      bundles: bundleRecords.map(normalizeReleaseBundle),
      heads: latestHeads(headRecords.map(normalizeChannelHead)),
      assignments: assignmentRecords.map(normalizeAssignmentEvent),
    };
  }

  return Object.freeze({ view, assign, fallback, recordInstallReceipt, recordFeedback });
}

function latestHeads(records) {
  const result = new Map();
  for (const item of records) if (!result.has(item.channel) || result.get(item.channel).sequence < item.sequence) result.set(item.channel, item);
  return result;
}

function latestAssignments(records) {
  const result = new Map();
  for (const item of records) {
    const coordinate = `${item.scope_type}:${item.scope_id}`;
    if (!result.has(coordinate) || result.get(coordinate).sequence < item.sequence) result.set(coordinate, item);
  }
  return result;
}

function effectiveAssignment(assignments, input) {
  const candidates = [];
  for (const type of ["device", "user", "cohort", "tenant"]) {
    const scopeId = input[`${type}_id`];
    if (scopeId) {
      const assignment = assignments.get(`${type}:${key(scopeId, `${type}_id`)}`) || null;
      if (assignment) candidates.push({ source: type, assignment });
    }
  }
  if (!candidates.length) return null;
  return { ...candidates[0].assignment, source: candidates[0].source, install_confirmed: false };
}

function installState(assignment, receipts, bundles) {
  const bundle = bundles.find((item) => item.bundle_id === assignment.bundle_id);
  if (!bundle) return [];
  return bundle.artifacts.map((artifact) => {
    const matches = receipts.filter((receipt) => receipt.assignment_event_id === assignment.event_id
      && receipt.surface_id === artifact.surface_id
      && receipt.release_id === artifact.release_id
      && receipt.artifact_sha256 === artifact.artifact_sha256);
    return {
      surface_id: artifact.surface_id,
      release_id: artifact.release_id,
      artifact_sha256: artifact.artifact_sha256,
      assigned: true,
      installed: matches.some((item) => ["installed", "activated", "smoked"].includes(item.status)),
      activated: matches.some((item) => ["activated", "smoked"].includes(item.status)),
      smoked: matches.some((item) => item.status === "smoked"),
    };
  });
}

function currentAssignment(records, scopeType, scopeId) {
  return records.filter((item) => item.scope_type === scopeType && item.scope_id === scopeId)
    .sort((a, b) => b.sequence - a.sequence)[0] || null;
}

function assignmentById(records, eventId) {
  const wanted = key(eventId, "assignment_event_id");
  return records.find((item) => item.event_id === wanted) || null;
}

function key(value, field) {
  const text = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(text)) throw new Error(`${field} is invalid`);
  return text;
}

function integer(value, field, minimum) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum) throw new Error(`${field} is invalid`);
  return result;
}

function defaultId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function optionalIdempotencyKey(value) {
  if (value == null || value === "") return null;
  const text = String(value).trim();
  if (!text || text.length > 200) throw new Error("idempotency_key is invalid");
  return text;
}

function requiredIdempotencyKey(value) {
  const result = optionalIdempotencyKey(value);
  if (!result) throw new Error("idempotency_key is required");
  return result;
}

function idempotentEventId(prefix, context, scopeType, scopeId, idempotencyKey) {
  if (!idempotencyKey) return null;
  const digest = crypto.createHash("sha256")
    .update(`${context.tenantId}:${context.applicationId}:${scopeType}:${scopeId}:${idempotencyKey}`)
    .digest("hex").slice(0, 40);
  return `${prefix}_${digest}`;
}

function idempotentRecordId(prefix, context, deviceId, idempotencyKey) {
  if (!idempotencyKey) return null;
  const digest = crypto.createHash("sha256")
    .update(`${context.tenantId}:${context.applicationId}:${key(deviceId, "device_id")}:${idempotencyKey}`)
    .digest("hex").slice(0, 40);
  return `${prefix}_${digest}`;
}

function sameReceiptRequest(existing, input) {
  return existing.assignment_event_id === key(input.assignment_event_id, "assignment_event_id")
    && existing.bundle_id === key(input.bundle_id, "bundle_id")
    && existing.surface_id === key(input.surface || input.surface_id, "surface")
    && existing.release_id === key(input.release_id, "release_id")
    && existing.artifact_sha256 === String(input.artifact_sha256 || "").toLowerCase()
    && existing.status === key(input.status, "status");
}

function sameFeedbackRequest(existing, input) {
  return existing.assignment_event_id === key(input.assignment_event_id, "assignment_event_id")
    && existing.bundle_id === key(input.bundle_id, "bundle_id")
    && existing.surface_id === key(input.surface || input.surface_id, "surface")
    && existing.release_id === key(input.release_id, "release_id")
    && existing.artifact_sha256 === String(input.artifact_sha256 || "").toLowerCase()
    && existing.text === String(input.text || "").trim()
    && JSON.stringify(existing.evidence_refs) === JSON.stringify(input.evidence_refs || []);
}

function mismatch(reason) {
  const error = new Error(`exact release binding rejected: ${reason}`);
  error.code = "release_binding_mismatch";
  error.reason = reason;
  return error;
}

function conflict(expected, actual) {
  const error = new Error(`assignment sequence conflict: expected ${expected}, actual ${actual}`);
  error.code = "assignment_sequence_conflict";
  error.expected_sequence = expected;
  error.actual_sequence = actual;
  return error;
}

function requireMethods(adapter, methods) {
  if (!adapter) throw new Error("adapter is required");
  for (const method of methods) if (typeof adapter[method] !== "function") throw new Error(`adapter.${method} is required`);
}

function authorize(input, action, applicationId, channel) {
  const authority = input.authority || {};
  const result = authorizeReleaseAction({
    ...authority,
    actor_id: authority.actor_id,
    tenant_id: input.tenant_id,
    action,
    resource: { application_id: applicationId, channel, cohort_id: input.cohort_id || "all" },
  });
  if (!result.allowed) {
    const error = new Error("release action is not authorized");
    error.code = "release_not_authorized";
    throw error;
  }
  return result;
}
