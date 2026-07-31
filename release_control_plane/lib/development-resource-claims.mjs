"use strict";

import crypto from "node:crypto";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RESOURCE_KINDS = new Set(["file", "tree"]);

export class DevelopmentResourceClaimError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function normalizeDevelopmentResources(resources) {
  if (!Array.isArray(resources) || resources.length === 0) {
    throw invalid("resources_required", "at least one development resource is required");
  }
  const normalized = resources.map((resource, index) => {
    if (!resource || typeof resource !== "object" || Array.isArray(resource)) {
      throw invalid("invalid_resource", `resources[${index}] must be an object`);
    }
    const kind = String(resource.kind || "").trim();
    if (!RESOURCE_KINDS.has(kind)) {
      throw invalid("invalid_resource_kind", `resources[${index}].kind is invalid`);
    }
    return Object.freeze({ kind, path: normalizeRepositoryPath(resource.path, index) });
  });

  normalized.sort((left, right) => left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind));
  const result = [];
  for (const resource of normalized) {
    const previous = result.at(-1);
    if (previous?.kind === resource.kind && previous.path === resource.path) continue;
    if (result.some((owned) => owned.kind === "tree" && contains(owned.path, resource.path))) continue;
    if (resource.kind === "tree") {
      for (let index = result.length - 1; index >= 0; index -= 1) {
        if (contains(resource.path, result[index].path)) result.splice(index, 1);
      }
    }
    result.push(resource);
  }
  return Object.freeze(result);
}

export function developmentResourcesConflict(left, right) {
  const leftResources = normalizeDevelopmentResources(left);
  const rightResources = normalizeDevelopmentResources(right);
  const conflicts = [];
  for (const leftResource of leftResources) {
    for (const rightResource of rightResources) {
      if (!resourcesOverlap(leftResource, rightResource)) continue;
      conflicts.push(Object.freeze({ left: leftResource, right: rightResource }));
    }
  }
  return Object.freeze(conflicts);
}

export function createDevelopmentResourceClaimStore({ now = Date.now, id = defaultId } = {}) {
  const claims = new Map();
  const idempotency = new Map();
  const events = [];

  function acquire(input) {
    const request = normalizeRequest(input, now());
    expireClaims(request.now_ms);
    const replayKey = requestKey(request);
    const replayId = idempotency.get(replayKey);
    if (replayId) {
      const replay = claims.get(replayId);
      if (!sameResources(replay.resources, request.resources)) {
        throw invalid("idempotency_mismatch", "idempotency key was already used with different resources");
      }
      return Object.freeze({ acquired: true, replayed: true, claim: publicClaim(replay), conflicts: Object.freeze([]) });
    }

    const conflicts = activeClaims(request.now_ms)
      .filter((claim) => claim.repository_id === request.repository_id)
      .flatMap((claim) => developmentResourcesConflict(request.resources, claim.resources)
        .map((overlap) => Object.freeze({ claim_id: claim.claim_id, claimant_id: claim.claimant_id, ...overlap })));
    if (conflicts.length > 0) {
      return Object.freeze({ acquired: false, replayed: false, claim: null, conflicts: Object.freeze(conflicts) });
    }

    const claimId = cleanId(id("drc"), "claim_id");
    const claim = Object.freeze({
      claim_id: claimId,
      repository_id: request.repository_id,
      claimant_id: request.claimant_id,
      idempotency_key: request.idempotency_key,
      resources: request.resources,
      acquired_at_ms: request.now_ms,
      lease_expires_at_ms: request.lease_expires_at_ms,
      released_at_ms: null,
    });
    claims.set(claimId, claim);
    idempotency.set(replayKey, claimId);
    appendEvent("development_resource_claim_acquired", claim, request.now_ms);
    return Object.freeze({ acquired: true, replayed: false, claim: publicClaim(claim), conflicts: Object.freeze([]) });
  }

  function renew(input) {
    const at = cleanTime(input?.now_ms ?? now(), "now_ms");
    expireClaims(at);
    const claim = ownedActiveClaim(input, at);
    const leaseExpiresAt = cleanTime(input.lease_expires_at_ms, "lease_expires_at_ms");
    if (leaseExpiresAt <= at || leaseExpiresAt <= claim.lease_expires_at_ms) {
      throw invalid("invalid_lease", "renewed lease must extend the active lease into the future");
    }
    const renewed = Object.freeze({ ...claim, lease_expires_at_ms: leaseExpiresAt });
    claims.set(claim.claim_id, renewed);
    appendEvent("development_resource_claim_renewed", renewed, at);
    return publicClaim(renewed);
  }

  function release(input) {
    const at = cleanTime(input?.now_ms ?? now(), "now_ms");
    expireClaims(at);
    const claim = ownedActiveClaim(input, at);
    const released = Object.freeze({ ...claim, released_at_ms: at });
    claims.set(claim.claim_id, released);
    appendEvent("development_resource_claim_released", released, at);
    return publicClaim(released);
  }

  function ownedActiveClaim(input, at) {
    const claimId = cleanId(input?.claim_id, "claim_id");
    const claimantId = cleanId(input?.claimant_id, "claimant_id");
    const claim = claims.get(claimId);
    if (!claim || claim.released_at_ms != null || claim.lease_expires_at_ms <= at) {
      throw invalid("claim_not_active", "development resource claim is not active");
    }
    if (claim.claimant_id !== claimantId) {
      throw invalid("claim_not_owned", "development resource claim belongs to another claimant");
    }
    return claim;
  }

  function expireClaims(at) {
    for (const claim of claims.values()) {
      if (claim.released_at_ms != null || claim.lease_expires_at_ms > at) continue;
      const expired = Object.freeze({ ...claim, released_at_ms: claim.lease_expires_at_ms });
      claims.set(claim.claim_id, expired);
      appendEvent("development_resource_claim_expired", expired, claim.lease_expires_at_ms);
    }
  }

  function activeClaims(at = cleanTime(now(), "now_ms")) {
    expireClaims(at);
    return [...claims.values()].filter((claim) => claim.released_at_ms == null && claim.lease_expires_at_ms > at);
  }

  function appendEvent(eventType, claim, occurredAtMs) {
    events.push(Object.freeze({
      sequence: events.length + 1,
      event_type: eventType,
      claim_id: claim.claim_id,
      claimant_id: claim.claimant_id,
      repository_id: claim.repository_id,
      occurred_at_ms: occurredAtMs,
    }));
  }

  return Object.freeze({
    acquire,
    renew,
    release,
    listActive: (at) => Object.freeze(activeClaims(at).map(publicClaim)),
    listEvents: () => Object.freeze([...events]),
  });
}

function normalizeRequest(input, defaultNow) {
  const nowMs = cleanTime(input?.now_ms ?? defaultNow, "now_ms");
  const leaseExpiresAtMs = cleanTime(input?.lease_expires_at_ms, "lease_expires_at_ms");
  if (leaseExpiresAtMs <= nowMs) throw invalid("invalid_lease", "lease must expire after acquisition");
  return Object.freeze({
    repository_id: cleanId(input?.repository_id, "repository_id"),
    claimant_id: cleanId(input?.claimant_id, "claimant_id"),
    idempotency_key: cleanId(input?.idempotency_key, "idempotency_key"),
    resources: normalizeDevelopmentResources(input?.resources),
    now_ms: nowMs,
    lease_expires_at_ms: leaseExpiresAtMs,
  });
}

function normalizeRepositoryPath(value, index) {
  const text = String(value || "").trim();
  if (!text || text.length > 512 || text.includes("\0") || text.includes("\\") || text.startsWith("/") || text.endsWith("/")) {
    throw invalid("invalid_resource_path", `resources[${index}].path is invalid`);
  }
  const segments = text.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw invalid("invalid_resource_path", `resources[${index}].path is invalid`);
  }
  return text;
}

function resourcesOverlap(left, right) {
  if (left.kind === "file" && right.kind === "file") return left.path === right.path;
  if (left.kind === "tree" && right.kind === "tree") return contains(left.path, right.path) || contains(right.path, left.path);
  const tree = left.kind === "tree" ? left : right;
  const file = left.kind === "file" ? left : right;
  return contains(tree.path, file.path);
}

function contains(treePath, candidatePath) {
  return candidatePath === treePath || candidatePath.startsWith(`${treePath}/`);
}

function sameResources(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function requestKey(request) {
  return `${request.repository_id}\0${request.claimant_id}\0${request.idempotency_key}`;
}

function publicClaim(claim) {
  return Object.freeze({ ...claim, resources: Object.freeze([...claim.resources]) });
}

function cleanId(value, field) {
  const text = String(value || "").trim();
  if (!ID.test(text)) throw invalid("invalid_identifier", `${field} is invalid`);
  return text;
}

function cleanTime(value, field) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw invalid("invalid_time", `${field} is invalid`);
  return number;
}

function invalid(code, message) {
  return new DevelopmentResourceClaimError(code, message);
}

function defaultId(prefix) {
  return `${prefix}:${crypto.randomUUID()}`;
}
