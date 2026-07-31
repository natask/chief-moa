"use strict";

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createDevelopmentResourceClaimStore,
  developmentResourcesConflict,
  normalizeDevelopmentResources,
} from "../lib/development-resource-claims.mjs";

const file = (path) => ({ kind: "file", path });
const tree = (path) => ({ kind: "tree", path });

function store() {
  let sequence = 0;
  return createDevelopmentResourceClaimStore({ now: () => 100, id: () => `drc:${++sequence}` });
}

function request(overrides = {}) {
  return {
    repository_id: "chief-moa",
    claimant_id: "agent:browser",
    idempotency_key: "ticket:browser-1",
    resources: [tree("browser_extension")],
    now_ms: 100,
    lease_expires_at_ms: 200,
    ...overrides,
  };
}

test("normalization is deterministic, collapses covered paths, and rejects escapes", () => {
  assert.deepEqual(normalizeDevelopmentResources([
    file("gateway/server.js"), tree("browser_extension"), file("browser_extension/content.js"),
    file("gateway/server.js"),
  ]), [tree("browser_extension"), file("gateway/server.js")]);
  for (const path of ["/tmp/file", "../file", "gateway/../file", "gateway\\file", "gateway//file", "gateway/"]) {
    assert.throws(() => normalizeDevelopmentResources([file(path)]), (error) => error.code === "invalid_resource_path");
  }
});

test("file and tree overlap is symmetric while disjoint paths do not conflict", () => {
  assert.equal(developmentResourcesConflict([file("gateway/server.js")], [file("gateway/server.js")]).length, 1);
  assert.equal(developmentResourcesConflict([tree("gateway")], [file("gateway/server.js")]).length, 1);
  assert.equal(developmentResourcesConflict([file("gateway/server.js")], [tree("gateway")]).length, 1);
  assert.equal(developmentResourcesConflict([tree("gateway/lib")], [tree("gateway")]).length, 1);
  assert.equal(developmentResourcesConflict([tree("gateway")], [tree("browser_extension")]).length, 0);
  assert.equal(developmentResourcesConflict([file("gateway/server.js")], [file("gateway/server.test.js")]).length, 0);
});

test("store admits disjoint work and rejects any active overlapping claim", () => {
  const claims = store();
  const first = claims.acquire(request());
  assert.equal(first.acquired, true);
  assert.equal(claims.acquire(request({
    claimant_id: "agent:gateway",
    idempotency_key: "ticket:gateway-1",
    resources: [tree("gateway")],
  })).acquired, true);
  const blocked = claims.acquire(request({
    claimant_id: "agent:ui",
    idempotency_key: "ticket:ui-1",
    resources: [file("browser_extension/extension/content.js")],
  }));
  assert.equal(blocked.acquired, false);
  assert.equal(blocked.conflicts[0].claim_id, first.claim.claim_id);
});

test("idempotent replay returns the same claim and rejects a changed resource set", () => {
  const claims = store();
  const first = claims.acquire(request());
  const replay = claims.acquire(request({ lease_expires_at_ms: 300 }));
  assert.equal(replay.replayed, true);
  assert.equal(replay.claim.claim_id, first.claim.claim_id);
  assert.equal(replay.claim.lease_expires_at_ms, 200, "replay must not silently renew a lease");
  assert.throws(() => claims.acquire(request({ resources: [tree("gateway")] })), (error) => error.code === "idempotency_mismatch");
});

test("expiry and explicit release unblock successors while ownership gates mutation", () => {
  const claims = store();
  const first = claims.acquire(request());
  assert.throws(() => claims.renew({
    claim_id: first.claim.claim_id, claimant_id: "agent:other", now_ms: 150, lease_expires_at_ms: 300,
  }), (error) => error.code === "claim_not_owned");
  const renewed = claims.renew({
    claim_id: first.claim.claim_id, claimant_id: "agent:browser", now_ms: 150, lease_expires_at_ms: 300,
  });
  assert.equal(renewed.lease_expires_at_ms, 300);
  claims.release({ claim_id: first.claim.claim_id, claimant_id: "agent:browser", now_ms: 175 });
  assert.equal(claims.acquire(request({ claimant_id: "agent:next", idempotency_key: "ticket:next", now_ms: 176, lease_expires_at_ms: 250 })).acquired, true);

  const expiring = store();
  expiring.acquire(request());
  assert.equal(expiring.acquire(request({ claimant_id: "agent:after", idempotency_key: "ticket:after", now_ms: 200, lease_expires_at_ms: 300 })).acquired, true);
  assert.deepEqual(expiring.listEvents().map((event) => event.event_type), [
    "development_resource_claim_acquired",
    "development_resource_claim_expired",
    "development_resource_claim_acquired",
  ]);
});

test("claims are repository-scoped", () => {
  const claims = store();
  claims.acquire(request());
  const other = claims.acquire(request({
    repository_id: "another-repo", claimant_id: "agent:other", idempotency_key: "ticket:other",
  }));
  assert.equal(other.acquired, true);
});
