"use strict";

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { evaluateReleaseEvidence } from "../../scripts/release/release-evidence.mjs";
import { createMemoryReleaseAdapter } from "../lib/memory-adapter.mjs";
import {
  dedicatedReleaseDatabaseUrl,
  parsePublicationCommand,
  repositoryAuthorityFromEnvironment,
} from "../lib/publication-command.mjs";
import {
  createReleaseBundlePublisher,
  normalizePublicationManifest,
} from "../lib/publisher.mjs";
import { createLocalRepositoryPublicationInputs } from "../lib/repository-inputs.mjs";

const GIT_SHA = "a".repeat(40);
const ARTIFACT_SHA = "b".repeat(64);
const CREATED_AT = "2026-07-23T12:00:00Z";
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PUBLICATION_STATES = [
  "built", "verified", "platform_signed", "packaged", "device_qa",
  "rollback_ready", "state_compatible", "no_interruption",
];

function manifest(overrides = {}) {
  return {
    version: "moa-release-bundle-publication/v1",
    tenant_id: "tenant_one",
    application_id: "chief-moa",
    bundle_id: "bundle_20260723",
    channel: "preview",
    expected_head_sequence: 0,
    source_ref: "refs/heads/candidate",
    git_sha: GIT_SHA,
    tracked_paths: ["android_app"],
    compatibility_version: 1,
    created_at: CREATED_AT,
    artifacts: [{
      surface_id: "android",
      release_id: "android_20260723",
      semantic_version: "0.2.0",
      artifact_ref: "artifact://android.apk",
      artifact_sha256: ARTIFACT_SHA,
      artifact_size: 321,
      evidence_ref: "evidence://android.json",
      download_url: "https://preview.example/android.apk",
      app_id: "ag.companion",
      version_code: 20260723,
      version_name: "0.2.0",
    }],
    ...overrides,
  };
}

function evidence(overrides = {}) {
  return {
    version: "moa-release-evidence/v1",
    surface: "android",
    release_id: "android_20260723",
    channel: "preview",
    artifact: {
      artifact_id: "android_apk",
      sha256: ARTIFACT_SHA,
      git_sha: GIT_SHA,
    },
    evidence: PUBLICATION_STATES.map((state) => ({
      state,
      release_id: "android_20260723",
      artifact_sha256: ARTIFACT_SHA,
      verifier: "release-ci",
      evidence_ref: `ci://run/1/${state}`,
      occurred_at: CREATED_AT,
    })),
    ...overrides,
  };
}

function promotionEvidence(overrides = {}) {
  return {
    schema_version: "moa-bundle-promotion-evidence/v1",
    application_id: "chief-moa",
    bundle_id: "bundle_20260723",
    channel: "stable",
    git_sha: GIT_SHA,
    gate_result: "passed",
    artifact_digests: [{
      surface: "android",
      release_id: "android_20260723",
      sha256: ARTIFACT_SHA,
      size_bytes: 321,
    }],
    evidence: [
      ["previewed", "preview_smoked"],
      ["backup_restored", "backup_restore_passed"],
      ["state_compatible", "n_minus_one_compatible"],
      ["no_interruption", "drain_safe"],
      ["rollback_ready", "rollback_ready"],
      ["smoked", "exact_artifact_smoked"],
    ].map(([state, assertion]) => ({
      state,
      assertion,
      verifier: "release-ci",
      evidence_ref: `ci://promotion/1/${state}`,
      occurred_at: CREATED_AT,
    })),
    ...overrides,
  };
}

function publisher(adapter, overrides = {}) {
  return createReleaseBundlePublisher({
    adapter,
    authorizePublication: async () => ({
      allowed: true,
      authority_kind: "repository_release",
      authority_id: "release_ci",
      authorized_git_sha: GIT_SHA,
      authorized_source_refs: ["refs/heads/candidate"],
      authorized_channels: ["preview"],
    }),
    inspectSource: async () => ({
      commit_exists: true,
      ref_git_sha: GIT_SHA,
      tracked_paths_clean: true,
    }),
    inspectArtifact: async () => ({ sha256: ARTIFACT_SHA, size_bytes: 321 }),
    loadEvidence: async () => evidence(),
    loadPromotionEvidence: async () => ({
      document: promotionEvidence(),
      sha256: "d".repeat(64),
    }),
    evaluateEvidence: evaluateReleaseEvidence,
    ...overrides,
  });
}

test("publisher atomically appends an exact bundle, channel head, and audit receipt", async () => {
  const adapter = createMemoryReleaseAdapter();
  const result = await publisher(adapter).publish(manifest(), { job_id: "trusted_job" });
  assert.equal(result.status, "published");
  assert.equal(result.head.sequence, 1);
  assert.equal(result.head.bundle_id, "bundle_20260723");
  assert.equal(result.receipt.authority_kind, "repository_release");
  assert.deepEqual(result.receipt.artifact_bindings, [{
    surface_id: "android",
    release_id: "android_20260723",
    artifact_sha256: ARTIFACT_SHA,
  }]);
  const state = adapter.snapshot();
  assert.equal(state.bundles.length, 1);
  assert.equal(state.channel_heads.length, 1);
  assert.equal(state.publication_receipts.length, 1);
});

test("an exact retry returns the existing immutable publication", async () => {
  const adapter = createMemoryReleaseAdapter();
  const releasePublisher = publisher(adapter);
  const first = await releasePublisher.publish(manifest());
  const second = await releasePublisher.publish(manifest());
  assert.deepEqual(second, first);
  assert.equal(adapter.snapshot().channel_heads.length, 1);
});

test("publisher denies device or caller-asserted authority", async () => {
  const adapter = createMemoryReleaseAdapter();
  const releasePublisher = publisher(adapter, {
    authorizePublication: async () => ({
      allowed: true,
      authority_kind: "device",
      authority_id: "phone_one",
      authorized_git_sha: GIT_SHA,
      authorized_source_refs: ["refs/heads/candidate"],
      authorized_channels: ["preview"],
    }),
  });
  await assert.rejects(
    releasePublisher.publish(manifest()),
    (error) => error.reason === "repository_release_authority_required",
  );
  assert.equal(adapter.snapshot().bundles.length, 0);
});

test("publisher rejects dirty source paths, wrong bytes, and incomplete evidence", async () => {
  const cases = [
    {
      overrides: { inspectSource: async () => ({ commit_exists: true, ref_git_sha: GIT_SHA, tracked_paths_clean: false }) },
      reason: "source_paths_not_exact_commit",
    },
    {
      overrides: { inspectArtifact: async () => ({ sha256: "c".repeat(64), size_bytes: 321 }) },
      reason: "artifact_digest_mismatch",
    },
    {
      overrides: { loadEvidence: async () => evidence({ evidence: evidence().evidence.slice(0, 2) }) },
      reason: "evidence_not_publication_ready",
    },
  ];
  for (const item of cases) {
    const adapter = createMemoryReleaseAdapter();
    await assert.rejects(
      publisher(adapter, item.overrides).publish(manifest()),
      (error) => error.reason === item.reason,
    );
    assert.equal(adapter.snapshot().channel_heads.length, 0);
  }
});

test("a stale head sequence cannot partially append the bundle", async () => {
  const adapter = createMemoryReleaseAdapter({
    channel_heads: [{
      tenant_id: "tenant_one",
      application_id: "chief-moa",
      channel: "preview",
      bundle_id: "prior_bundle",
      sequence: 1,
      updated_at: "2026-07-22T12:00:00Z",
    }],
  });
  await assert.rejects(
    publisher(adapter).publish(manifest()),
    (error) => error.code === "channel_head_sequence_conflict"
      && error.expected_sequence === 0
      && error.actual_sequence === 1,
  );
  assert.equal(adapter.snapshot().bundles.length, 0);
  assert.equal(adapter.snapshot().publication_receipts.length, 0);
});

test("manifest parser rejects unknown fields and duplicate surfaces", () => {
  assert.throws(
    () => normalizePublicationManifest(manifest({ claimed_authority: "owner" })),
    /claimed_authority is not allowed/,
  );
  const duplicate = manifest();
  duplicate.artifacts = [duplicate.artifacts[0], { ...duplicate.artifacts[0] }];
  assert.throws(() => normalizePublicationManifest(duplicate), /surface_id is invalid/);
});

test("operational command requires explicit confirmation and a separate Postgres database", () => {
  assert.deepEqual(
    parsePublicationCommand([
      "publish-manifest",
      "release.json",
      "--confirm-publish-exact-release",
    ]),
    { command: "publish-manifest", manifest_path: "release.json" },
  );
  assert.throws(
    () => parsePublicationCommand(["publish-manifest", "release.json"]),
    /requires --confirm-publish-exact-release/,
  );
  assert.equal(
    dedicatedReleaseDatabaseUrl({
      RELEASE_CONTROL_DATABASE_URL: "postgresql://control@example/release",
      DATABASE_URL: "postgresql://gateway@example/moa",
    }),
    "postgresql://control@example/release",
  );
  assert.throws(
    () => dedicatedReleaseDatabaseUrl({
      RELEASE_CONTROL_DATABASE_URL: "postgresql://same@example/moa",
      DATABASE_URL: "postgresql://same@example/moa",
    }),
    /must be separate/,
  );
  assert.throws(
    () => dedicatedReleaseDatabaseUrl({
      RELEASE_CONTROL_DATABASE_URL: "postgresql://publisher@EXAMPLE.com:5432/moa?sslmode=require",
      DATABASE_URL: "postgres://gateway@example.com/moa",
    }),
    /must be separate/,
  );
});

test("operational authority comes only from exact deployment environment bindings", () => {
  const exactManifest = normalizePublicationManifest(manifest());
  const environment = {
    MOA_REPOSITORY_RELEASE_AUTHORITY_ID: "release_ci",
    MOA_REPOSITORY_RELEASE_GIT_SHA: GIT_SHA,
    MOA_REPOSITORY_RELEASE_SOURCE_REF: "refs/heads/candidate",
    MOA_REPOSITORY_RELEASE_CHANNELS: "preview",
  };
  const authority = repositoryAuthorityFromEnvironment(environment, exactManifest);
  assert.equal(authority.authority_kind, "repository_release");
  assert.deepEqual(authority.authorized_channels, ["preview"]);
  assert.throws(
    () => repositoryAuthorityFromEnvironment({
      ...environment,
      MOA_REPOSITORY_RELEASE_GIT_SHA: "c".repeat(40),
    }, exactManifest),
    /does not match manifest/,
  );
  assert.throws(
    () => repositoryAuthorityFromEnvironment({
      ...environment,
      MOA_REPOSITORY_RELEASE_CHANNELS: "stable",
    }, exactManifest),
    /does not allow channel/,
  );
  const stableManifest = normalizePublicationManifest(manifest({
    channel: "stable",
    source_ref: "refs/heads/master",
  }));
  const stableEnvironment = {
    ...environment,
    MOA_REPOSITORY_RELEASE_SOURCE_REF: "refs/heads/master",
    MOA_REPOSITORY_RELEASE_CHANNELS: "stable",
  };
  assert.throws(
    () => repositoryAuthorityFromEnvironment(stableEnvironment, stableManifest),
    /promotion bundle does not match/,
  );
  const stableAuthority = repositoryAuthorityFromEnvironment({
    ...stableEnvironment,
    MOA_REPOSITORY_RELEASE_PROMOTION_BUNDLE_ID: stableManifest.bundle_id,
    MOA_REPOSITORY_RELEASE_PROMOTION_EVIDENCE_REF: "control-plane://promotion/proposal_123/approved",
  }, stableManifest);
  assert.equal(stableAuthority.promotion_bundle_id, stableManifest.bundle_id);
});

test("stable publication loads strict exact promotion evidence and binds its digest", async () => {
  const stableManifest = manifest({
    channel: "stable",
    source_ref: "refs/heads/master",
  });
  const stablePublisher = publisher(createMemoryReleaseAdapter(), {
    authorizePublication: async () => ({
      allowed: true,
      authority_kind: "repository_release",
      authority_id: "release_ci",
      authorized_git_sha: GIT_SHA,
      authorized_source_refs: ["refs/heads/master"],
      authorized_channels: ["stable"],
      promotion_bundle_id: "bundle_20260723",
      promotion_evidence_ref: "release/evidence/stable.json",
    }),
    loadEvidence: async () => evidence({ channel: "stable" }),
  });
  const result = await stablePublisher.publish(stableManifest);
  assert.equal(result.receipt.promotion_evidence_ref, "release/evidence/stable.json");
  assert.equal(result.receipt.promotion_evidence_sha256, "d".repeat(64));
});

test("stable publication rejects stale, incomplete, or artifact-mismatched promotion evidence", async () => {
  const stableManifest = manifest({
    channel: "stable",
    source_ref: "refs/heads/master",
  });
  const baseOverrides = {
    authorizePublication: async () => ({
      allowed: true,
      authority_kind: "repository_release",
      authority_id: "release_ci",
      authorized_git_sha: GIT_SHA,
      authorized_source_refs: ["refs/heads/master"],
      authorized_channels: ["stable"],
      promotion_bundle_id: "bundle_20260723",
      promotion_evidence_ref: "release/evidence/stable.json",
    }),
    loadEvidence: async () => evidence({ channel: "stable" }),
  };
  const badDocuments = [
    promotionEvidence({ git_sha: "c".repeat(40) }),
    promotionEvidence({ evidence: promotionEvidence().evidence.slice(0, 5) }),
    promotionEvidence({
      artifact_digests: [{
        ...promotionEvidence().artifact_digests[0],
        sha256: "c".repeat(64),
      }],
    }),
  ];
  for (const document of badDocuments) {
    const adapter = createMemoryReleaseAdapter();
    await assert.rejects(
      publisher(adapter, {
        ...baseOverrides,
        loadPromotionEvidence: async () => ({ document, sha256: "d".repeat(64) }),
      }).publish(stableManifest),
      (error) => error.code === "release_publication_blocked",
    );
    assert.equal(adapter.snapshot().channel_heads.length, 0);
  }
});

test("repository promotion evidence loader rejects traversal and symlinks", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "moa-release-publisher-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, "evidence.json"), JSON.stringify(promotionEvidence()));
  symlinkSync(path.join(root, "evidence.json"), path.join(root, "linked.json"));
  const inputs = createLocalRepositoryPublicationInputs({ repository_root: root });
  await assert.rejects(inputs.loadEvidenceWithDigest("../outside.json"), /escapes repository_root/);
  await assert.rejects(inputs.loadEvidenceWithDigest(path.join(root, "evidence.json")), /repository-relative/);
  await assert.rejects(inputs.loadEvidenceWithDigest("linked.json"), /regular repository file/);
  const loaded = await inputs.loadEvidenceWithDigest("evidence.json");
  assert.match(loaded.sha256, /^[a-f0-9]{64}$/);
});

test("repository source inspector uses the exact checkout as Git safe.directory", async () => {
  const inputs = createLocalRepositoryPublicationInputs({ repository_root: REPOSITORY_ROOT });
  const gitSha = execFileSync(
    "git",
    ["-C", REPOSITORY_ROOT, "rev-parse", "HEAD"],
    { encoding: "utf8" },
  ).trim();
  const inspected = await inputs.inspectSource({
    source_ref: gitSha,
    git_sha: gitSha,
    tracked_paths: ["README.md"],
  });
  assert.deepEqual(inspected, {
    commit_exists: true,
    ref_git_sha: gitSha,
    tracked_paths_clean: true,
  });
});
