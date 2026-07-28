"use strict";

import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { createReleaseControlHttpHandler } from "../lib/http.mjs";
import { createMemoryReleaseAdapter } from "../lib/memory-adapter.mjs";
import { createReleaseControlService } from "../lib/service.mjs";

const digestA = "a".repeat(64);
const digestB = "b".repeat(64);
const digestC = "c".repeat(64);
const at = "2026-07-23T00:00:00.000Z";
const authority = { actor_id: "nat", owner_id: "nat" };

function artifact(surface_id, release_id, artifact_sha256, semantic_version) {
  return {
    surface_id, release_id, artifact_sha256, semantic_version,
    artifact_size: 100, git_sha: "1".repeat(40),
    download_url: `https://releases.example/${release_id}`,
    app_id: surface_id === "android" ? "ai.moa.assistant" : "chief-moa",
    version_code: surface_id === "android" ? 100 : null,
    version_name: semantic_version,
  };
}

function seed(overrides = {}) {
  return {
    bundles: [
      {
        tenant_id: "personal", application_id: "chief-moa", bundle_id: "stable-1",
        compatibility_version: 1, created_at: at,
        artifacts: [
          artifact("android", "android-stable-1", digestA, "1.0.0"),
          artifact("browser_extension", "browser-stable-1", digestB, "1.0.0"),
        ],
      },
      {
        tenant_id: "personal", application_id: "chief-moa", bundle_id: "preview-2",
        compatibility_version: 1, created_at: at,
        artifacts: [
          artifact("android", "android-preview-2", digestC, "1.1.0"),
          artifact("browser_extension", "browser-preview-2", digestA, "1.1.0"),
        ],
      },
    ],
    channel_heads: [
      { tenant_id: "personal", application_id: "chief-moa", channel: "stable", bundle_id: "stable-1", sequence: 1, updated_at: at },
      { tenant_id: "personal", application_id: "chief-moa", channel: "preview", bundle_id: "preview-2", sequence: 2, updated_at: at },
    ],
    assignment_events: [],
    install_receipts: [],
    feedback: [],
    ...overrides,
  };
}

function harness(overrides = {}) {
  let next = 0;
  const adapter = createMemoryReleaseAdapter(seed(overrides));
  const service = createReleaseControlService({
    adapter,
    now: () => at,
    id: (prefix) => `${prefix}_${++next}`,
  });
  return {
    adapter,
    service,
    http: createReleaseControlHttpHandler(service, {
      authenticate: async () => ({
        tenant_id: "personal", actor_id: "nat", owner_id: "nat",
        device_id: "phone-1", surface_id: "android",
      }),
    }),
  };
}

async function assignPreview(service, extra = {}) {
  return service.assign({
    tenant_id: "personal", application_id: "chief-moa", device_id: "phone-1",
    actor_id: "nat", expected_sequence: 0, channel: "preview", surface: "android",
    idempotency_key: "assign-preview", authority, ...extra,
  });
}

test("multi-surface channel view is additive-tolerant and assignment does not imply installation", async () => {
  const fixture = seed();
  fixture.bundles[0].future_bundle_field = { ignored_by_v1: true };
  fixture.bundles[0].artifacts[0].future_artifact_field = "ignored";
  fixture.channel_heads[0].future_head_field = 42;
  const { service } = harness(fixture);

  const before = await service.view({
    tenant_id: "personal", application_id: "chief-moa", device_id: "phone-1",
    authority, surface: "android",
  });
  assert.equal(before.channels[0].bundle.artifacts.length, 2);
  assert.equal("future_bundle_field" in before.channels[0].bundle, false);

  const assignment = await assignPreview(service);
  const after = await service.view({
    tenant_id: "personal", application_id: "chief-moa", device_id: "phone-1",
    authority, surface: "android",
  });
  assert.equal(after.effective_assignment.event_id, assignment.event_id);
  assert.equal(after.effective_assignment.channel, "preview");
  assert.equal(after.effective_assignment.install_confirmed, false);
  assert.equal(after.installation.length, 2);
  assert.equal(after.installation.every((item) => item.assigned && !item.installed && !item.smoked), true);
});

test("assignment precedence remains device over user, cohort, and tenant", async () => {
  const records = [
    assignment("tenant-1", "tenant", "personal", 1, "stable", "stable-1"),
    assignment("cohort-1", "cohort", "alpha", 1, "preview", "preview-2"),
    assignment("user-1", "user", "nat", 1, "stable", "stable-1"),
    assignment("device-1", "device", "phone-1", 1, "preview", "preview-2"),
  ];
  const { service } = harness({ assignment_events: records });
  const view = await service.view({
    tenant_id: "personal", application_id: "chief-moa", tenant_id_for_assignment: "ignored",
    device_id: "phone-1", user_id: "nat", cohort_id: "alpha", authority, surface: "android",
  });
  assert.equal(view.effective_assignment.source, "device");
  assert.equal(view.effective_assignment.event_id, "device-1");
});

test("optimistic assignment sequence rejects a stale writer without appending", async () => {
  const { adapter, service } = harness();
  await assignPreview(service, { idempotency_key: "writer-a" });
  await assert.rejects(() => assignPreview(service, { idempotency_key: "writer-b" }), (error) => {
    assert.equal(error.code, "assignment_sequence_conflict");
    assert.equal(error.expected_sequence, 0);
    assert.equal(error.actual_sequence, 1);
    return true;
  });
  assert.equal(adapter.snapshot().assignment_events.length, 1);
});

test("assignment idempotency returns the original append-only receipt", async () => {
  const { adapter, service } = harness();
  const first = await assignPreview(service, { idempotency_key: "mobile-select-preview-1" });
  const retry = await assignPreview(service, { idempotency_key: "mobile-select-preview-1" });
  assert.deepEqual(retry, first);
  assert.equal(adapter.snapshot().assignment_events.length, 1);
});

test("install and smoke receipts bind the exact assigned surface bytes", async () => {
  const { service } = harness();
  const selected = await assignPreview(service);
  const base = {
    tenant_id: "personal", application_id: "chief-moa", device_id: "phone-1",
    authority,
    assignment_event_id: selected.event_id, bundle_id: "preview-2",
    surface_id: "android", release_id: "android-preview-2", artifact_sha256: digestC,
  };
  await service.recordInstallReceipt({ ...base, receipt_id: "install-1", status: "installed", idempotency_key: "install-1" });
  let view = await service.view({
    tenant_id: "personal", application_id: "chief-moa", device_id: "phone-1",
    authority, surface: "android",
  });
  assert.equal(view.installation.find((item) => item.surface_id === "android").installed, true);
  assert.equal(view.installation.find((item) => item.surface_id === "android").smoked, false);

  await service.recordInstallReceipt({ ...base, receipt_id: "smoke-1", status: "smoked", idempotency_key: "smoke-1" });
  view = await service.view({
    tenant_id: "personal", application_id: "chief-moa", device_id: "phone-1",
    authority, surface: "android",
  });
  assert.equal(view.installation.find((item) => item.surface_id === "android").smoked, true);
  await assert.rejects(
    () => service.recordInstallReceipt({ ...base, receipt_id: "bad-1", status: "installed", artifact_sha256: digestB, idempotency_key: "bad-1" }),
    (error) => error.code === "release_binding_mismatch" && error.reason === "artifact_mismatch",
  );
});

test("feedback rejects bundle, release, and digest mismatches and appends an exact anchor", async () => {
  const { adapter, service } = harness();
  const selected = await assignPreview(service);
  const valid = {
    tenant_id: "personal", application_id: "chief-moa", device_id: "phone-1",
    authority,
    assignment_event_id: selected.event_id, bundle_id: "preview-2",
    surface_id: "android", release_id: "android-preview-2", artifact_sha256: digestC,
    text: "The preview capture control obscures the response.", idempotency_key: "feedback-1",
  };
  const saved = await service.recordFeedback({ ...valid, feedback_id: "feedback-1" });
  assert.equal(saved.assignment_event_id, selected.event_id);
  assert.equal(saved.artifact_sha256, digestC);
  await assert.rejects(
    () => service.recordFeedback({ ...valid, feedback_id: "feedback-2", bundle_id: "stable-1", idempotency_key: "feedback-2" }),
    (error) => error.code === "release_binding_mismatch" && error.reason === "assignment_bundle_mismatch",
  );
  await assert.rejects(
    () => service.recordFeedback({ ...valid, feedback_id: "feedback-3", release_id: "android-stable-1", idempotency_key: "feedback-3" }),
    (error) => error.code === "release_binding_mismatch" && error.reason === "release_mismatch",
  );
  assert.equal(adapter.snapshot().feedback.length, 1);
});

test("fallback appends a new assignment to recorded last-known-good and stays install-pending", async () => {
  const { adapter, service } = harness();
  const preview = await assignPreview(service);
  const fallback = await service.fallback({
    tenant_id: "personal", application_id: "chief-moa", device_id: "phone-1",
    actor_id: "nat", expected_sequence: preview.sequence, authority, surface: "android",
    idempotency_key: "fallback-1",
  });
  assert.equal(fallback.operation, "stable_fallback");
  assert.equal(fallback.bundle_id, "stable-1");
  assert.equal(fallback.sequence, 2);
  assert.equal(adapter.snapshot().assignment_events.length, 2);
  const view = await service.view({
    tenant_id: "personal", application_id: "chief-moa", device_id: "phone-1",
    authority, surface: "android",
  });
  assert.equal(view.effective_assignment.bundle_id, "stable-1");
  assert.equal(view.installation.every((item) => !item.installed), true);
});

test("HTTP abstraction exposes frozen view and append endpoints with bounded conflicts", async () => {
  const { http } = harness();
  const selected = await http({
    method: "POST",
    path: "/v1/release-control/apps/chief-moa/assignments",
    body: { tenant_id: "forged", device_id: "phone-1", actor_id: "attacker", expected_assignment_sequence: 0, channel: "preview", surface: "android", bundle_id: "preview-2", release_id: "android-preview-2", idempotency_key: "http-assign-1" },
  });
  assert.equal(selected.status, 201);
  assert.equal(selected.body.assignment_receipt.tenant_id, "personal");
  assert.equal(selected.body.assignment_receipt.actor_id, "nat");
  assert.equal(selected.body.platform_action.kind, "android_install_review");
  assert.equal(selected.body.effective_assignment.release_id, "android-preview-2");
  const stale = await http({
    method: "POST",
    path: "/v1/release-control/apps/chief-moa/assignments",
    body: { tenant_id: "personal", device_id: "phone-1", actor_id: "nat", expected_assignment_sequence: 0, channel: "stable", surface: "android", idempotency_key: "http-assign-2" },
  });
  assert.deepEqual(stale.body, {
    error: "assignment_sequence_conflict", expected_assignment_sequence: 0, actual_assignment_sequence: 1,
  });
  const view = await http({
    method: "GET",
    path: "/v1/release-control/apps/chief-moa/view",
    query: { tenant_id: "evil", device_id: "phone-1", surface: "android" },
  });
  assert.equal(view.status, 200);
  assert.equal(view.body.effective_assignment.bundle_id, "preview-2");
  assert.equal(view.body.schema_version, 1);
  assert.equal(view.body.channels.preview.sequence, 2);
  assert.equal(view.body.candidates.find((item) => item.artifact.surface === "android").artifact.app_id, "ai.moa.assistant");
});

test("HTTP authentication rejects missing identity and ignores forged tenant and actor fields", async () => {
  const { service } = harness();
  const unauthenticated = createReleaseControlHttpHandler(service, { authenticate: async () => null });
  const missing = await unauthenticated({
    method: "GET", path: "/v1/release-control/apps/chief-moa/view",
    query: { tenant_id: "personal", device_id: "phone-1" },
  });
  assert.equal(missing.status, 401);

  const scopedElsewhere = createReleaseControlHttpHandler(service, {
    authenticate: async () => ({
      tenant_id: "personal", actor_id: "attacker", owner_id: "nat",
      device_id: "phone-1", surface_id: "android",
      role_bindings: [{
        tenant_id: "other-tenant", principal_id: "attacker", role: "viewer",
        scope: { application_id: "chief-moa" },
      }],
    }),
  });
  const denied = await scopedElsewhere({
    method: "GET", path: "/v1/release-control/apps/chief-moa/view",
    query: { tenant_id: "other-tenant", actor_id: "nat", device_id: "phone-1" },
  });
  assert.deepEqual(denied, {
    status: 403,
    headers: { "content-type": "application/json" },
    body: { error: "release_not_authorized" },
  });
});

test("HTTP accepts assignment_id, surface, sha256, and bounded evidence refs aliases", async () => {
  const { http } = harness();
  const assigned = await http({
    method: "POST", path: "/v1/release-control/apps/chief-moa/assignments",
    body: {
      device_id: "phone-1", expected_assignment_sequence: 0, channel: "preview",
      surface: "android", bundle_id: "preview-2", release_id: "android-preview-2",
      idempotency_key: "alias-assign-1",
    },
  });
  const assignmentId = assigned.body.effective_assignment.assignment_id;
  const installed = await http({
    method: "POST", path: "/v1/release-control/apps/chief-moa/install-receipts",
    body: {
      device_id: "phone-1", assignment_id: assignmentId, bundle_id: "preview-2",
      surface: "android", release_id: "android-preview-2", sha256: digestC, status: "smoked",
      idempotency_key: "alias-install-1",
    },
  });
  assert.equal(installed.status, 201);
  assert.equal(installed.body.install_receipt.assignment_id, assignmentId);

  const feedback = await http({
    method: "POST", path: "/v1/release-control/apps/chief-moa/feedback",
    body: {
      device_id: "phone-1", assignment_id: assignmentId, bundle_id: "preview-2",
      surface: "android", release_id: "android-preview-2", artifact_sha256: digestC,
      text: "The preview is clipped.", evidence_refs: ["evidence://capture-1"],
      idempotency_key: "alias-feedback-1",
    },
  });
  assert.equal(feedback.status, 201);
  assert.deepEqual(feedback.body.feedback.evidence_refs, ["evidence://capture-1"]);
});

test("trusted browser surface filters candidates and chooses browser reload action", async () => {
  const { service } = harness();
  const browserHttp = createReleaseControlHttpHandler(service, {
    authenticate: async () => ({
      tenant_id: "personal", actor_id: "nat", owner_id: "nat", surface_id: "browser_extension",
      device_id: "browser-1",
    }),
  });
  const view = await browserHttp({
    method: "GET", path: "/v1/release-control/apps/chief-moa/view",
    query: { device_id: "browser-1" },
  });
  assert.equal(view.status, 200);
  assert.equal(view.body.candidates.length, 2);
  assert.equal(view.body.candidates.every((item) => item.artifact.surface === "browser_extension"), true);
  assert.equal(view.body.installed, null);

  const selected = await browserHttp({
    method: "POST", path: "/v1/release-control/apps/chief-moa/assignments",
    body: {
      device_id: "browser-1", expected_assignment_sequence: 0, channel: "preview",
      bundle_id: "preview-2", release_id: "browser-preview-2", idempotency_key: "browser-assign-1",
    },
  });
  assert.equal(selected.status, 201);
  assert.equal(selected.body.platform_action.kind, "browser_binary_reload_required");
  assert.equal(selected.body.effective_assignment.scope, "device");
  assert.equal(selected.body.effective_assignment.release_id, "browser-preview-2");
  assert.equal(selected.body.last_known_good, undefined);
});

test("unsupported bundle compatibility blocks readiness and additive lifecycle status reads as unknown", async () => {
  const fixture = seed({
    assignment_events: [assignment("device-1", "device", "phone-1", 1, "preview", "preview-2")],
    install_receipts: [{
      receipt_id: "future-1", tenant_id: "personal", application_id: "chief-moa",
      device_id: "phone-1", assignment_event_id: "device-1", bundle_id: "preview-2",
      surface_id: "android", release_id: "android-preview-2", artifact_sha256: digestC,
      status: "future_native_state", idempotency_key: "future-1", created_at: at,
      future_receipt_field: true,
    }],
  });
  fixture.bundles.find((item) => item.bundle_id === "preview-2").compatibility_version = 99;
  const { service } = harness(fixture);
  const http = createReleaseControlHttpHandler(service, {
    authenticate: async () => ({
      tenant_id: "personal", actor_id: "nat", owner_id: "nat",
      device_id: "phone-1", surface_id: "android",
    }),
  });
  const result = await http({
    method: "GET", path: "/v1/release-control/apps/chief-moa/view", query: { device_id: "forged" },
  });
  const preview = result.body.candidates.find((item) => item.channel === "preview");
  assert.equal(preview.compatibility.eligible, false);
  assert.equal(preview.readiness.ready, false);
  assert.equal(result.body.installed, null);
  assert.equal(result.body.device_id, "phone-1");
});

test("canonical Android and browser fixtures exactly match public HTTP views", async () => {
  for (const target of [
    {
      fixture: "android-view-v1.json", device_id: "phone-1", surface_id: "android",
      release_id: "android-preview-2", artifact_sha256: digestC,
    },
    {
      fixture: "browser-view-v1.json", device_id: "browser-1", surface_id: "browser_extension",
      release_id: "browser-preview-2", artifact_sha256: digestA,
    },
  ]) {
    const expected = JSON.parse(fs.readFileSync(
      new URL(`./fixtures/${target.fixture}`, import.meta.url),
      "utf8",
    ));
    const assignmentRecord = assignment("device-1", "device", target.device_id, 1, "preview", "preview-2");
    const { service } = harness({
      assignment_events: [assignmentRecord],
      install_receipts: [{
        receipt_id: "install-1", tenant_id: "personal", application_id: "chief-moa",
        device_id: target.device_id, assignment_event_id: "device-1", bundle_id: "preview-2",
        surface_id: target.surface_id, release_id: target.release_id,
        artifact_sha256: target.artifact_sha256, status: "activated",
        idempotency_key: "fixture-install", created_at: at,
      }],
    });
    const http = createReleaseControlHttpHandler(service, {
      authenticate: async () => ({
        tenant_id: "personal", actor_id: "nat", owner_id: "nat",
        device_id: target.device_id, surface_id: target.surface_id,
      }),
    });
    const result = await http({
      method: "GET", path: "/v1/release-control/apps/chief-moa/view",
      query: { device_id: "forged", surface: "forged" },
    });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, expected);
    if (target.surface_id === "android") {
      assert.equal(result.body.installed.app_id, "ai.moa.assistant");
      assert.equal(result.body.installed.version_code, 100);
      assert.equal(result.body.installed.version_name, "1.1.0");
    } else {
      assert.equal(result.body.installed.version, "1.1.0");
    }
  }
});

function assignment(event_id, scope_type, scope_id, sequence, channel, bundle_id) {
  return {
    event_id, tenant_id: "personal", application_id: "chief-moa",
    scope_type, scope_id, sequence, channel, bundle_id,
    stable_fallback_bundle_id: "stable-1", operation: "assign_channel",
    actor_id: "nat", created_at: at, future_assignment_field: "ignored",
  };
}

test("published sibling and composed candidates remain paginated and exactly selectable after preview moves", async () => {
  const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/candidate-catalog-v1.json", import.meta.url), "utf8"));
  const created = ["2026-07-24T00:00:00Z", "2026-07-25T00:00:00Z", "2026-07-26T00:00:00Z"];
  const ids = ["bundle-sibling-a", "bundle-sibling-b", "bundle-composed"];
  const bundles = seed().bundles.concat(ids.map((bundle_id, index) => ({
    tenant_id: "personal", application_id: "chief-moa", bundle_id,
    compatibility_version: 1, created_at: created[index], lineage: fixture.lineage[bundle_id],
    artifacts: [artifact("android", `android-${bundle_id}`, [digestA, digestB, digestC][index], `2.0.${index}`)],
  })), {
    tenant_id: "personal", application_id: "chief-moa", bundle_id: "draft-unpublished",
    compatibility_version: 1, created_at: "2026-07-27T00:00:00Z",
    artifacts: [artifact("android", "android-draft", digestA, "3.0.0")],
  });
  const publication_receipts = ids.map((bundle_id, index) => ({
    receipt_id: `published-${index}`, tenant_id: "personal", application_id: "chief-moa",
    bundle_id, channel: "preview", new_sequence: index + 1, created_at: created[index],
  }));
  const { service, http } = harness({
    bundles,
    publication_receipts,
    channel_heads: seed().channel_heads.concat([
      { tenant_id: "personal", application_id: "chief-moa", channel: "preview", bundle_id: "bundle-composed", sequence: 3, updated_at: created[2] },
    ]),
  });
  const first = await http({ method: "GET", path: "/v1/release-control/apps/chief-moa/candidates", query: { limit: 2 } });
  const second = await http({ method: "GET", path: "/v1/release-control/apps/chief-moa/candidates", query: { limit: 2, cursor: first.body.next_cursor } });
  assert.deepEqual([...first.body.candidates, ...second.body.candidates].map((item) => item.bundle_id), fixture.candidate_order);
  assert.deepEqual(first.body.candidates[0].lineage, fixture.lineage["bundle-composed"]);

  const selected = await http({
    method: "POST", path: "/v1/release-control/apps/chief-moa/candidate-selections",
    body: { expected_assignment_sequence: 0, bundle_id: "bundle-sibling-a", release_id: "android-bundle-sibling-a", idempotency_key: "pick-sibling-a" },
  });
  assert.equal(selected.status, 201);
  assert.equal(selected.body.assignment_receipt.bundle_id, "bundle-sibling-a");
  assert.equal(selected.body.assignment_receipt.sequence, 1);
  assert.equal(selected.body.assignment_receipt.release_id, "android-bundle-sibling-a");
  assert.equal(selected.body.platform_action.kind, "android_install_review");

  await assert.rejects(() => service.selectCandidate({
    tenant_id: "personal", application_id: "chief-moa", device_id: "phone-1", actor_id: "nat",
    authority, surface: "android", expected_sequence: 0, bundle_id: "bundle-sibling-b", idempotency_key: "stale",
  }), (error) => error.code === "assignment_sequence_conflict");
  for (const [bundle_id, reason] of [["missing", "candidate_unknown"], ["draft-unpublished", "candidate_not_published"]]) {
    await assert.rejects(() => service.selectCandidate({
      tenant_id: "personal", application_id: "chief-moa", device_id: "phone-2", actor_id: "nat",
      authority, surface: "android", expected_sequence: 0, bundle_id, idempotency_key: `reject-${bundle_id}`,
    }), (error) => error.reason === reason);
  }

  await assert.rejects(() => service.selectCandidate({
    tenant_id: "other-tenant", application_id: "chief-moa", device_id: "phone-1", actor_id: "other-owner",
    authority: { actor_id: "other-owner", owner_id: "other-owner" }, surface: "android",
    expected_sequence: 0, bundle_id: "bundle-sibling-a", idempotency_key: "cross-tenant",
  }), (error) => error.reason === "candidate_unknown");
});
