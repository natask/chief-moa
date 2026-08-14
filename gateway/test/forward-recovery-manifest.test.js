"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  ForwardRecoveryError,
  projectForwardRecoveryManifest,
  provenanceDigest,
} = require("../lib/forward-recovery-manifest");

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const SOURCE = "1".repeat(40);
const BUILDER = "2".repeat(40);
const REPLACED_SOURCE = "3".repeat(40);

function receipt(overrides = {}) {
  const value = {
    schema_version: 1,
    kind: "android_forward_recovery",
    recovery_release_id: "recovery-stable-12-as-31",
    source_commit: SOURCE,
    builder_commit: BUILDER,
    built_at: "2026-08-14T17:00:00.000Z",
    download_path: "/v1/release-recovery/artifacts/recovery-stable-12-as-31.apk",
    artifact: {
      apk: "moa-assistant.apk",
      app_id: "ag.companion",
      version_code: 31,
      version_name: "1.2.0-recovery.31",
      sha256: A,
      size_bytes: 4096,
      signer_sha256: B,
    },
    target_predecessor: {
      channel: "stable", bundle_id: "stable-12", release_id: "stable-release-12",
      sequence: 12, artifact_sha256: C, artifact_version_code: 12,
    },
    replaces: {
      bundle_id: "trial-30", release_id: "trial-release-30", source_commit: REPLACED_SOURCE,
      artifact_sha256: B, artifact_version_code: 30,
    },
    parent_stable: { bundle_id: "stable-12", release_id: "stable-release-12", sequence: 12 },
    parent_trial: { bundle_id: "trial-30", release_id: "trial-release-30", sequence: 30 },
    provenance_sha256: "",
    ...overrides,
  };
  value.provenance_sha256 = provenanceDigest(value);
  return value;
}

function expected(value) {
  return structuredClone({
    source_commit: value.source_commit,
    target_predecessor: value.target_predecessor,
    replaces: value.replaces,
    parent_stable: value.parent_stable,
    parent_trial: value.parent_trial,
  });
}

function observation(value) {
  return {
    available: true,
    sha256: value.artifact.sha256,
    size_bytes: value.artifact.size_bytes,
    app_id: value.artifact.app_id,
    version_code: value.artifact.version_code,
    signer_sha256: value.artifact.signer_sha256,
  };
}

async function project(value, options = {}) {
  return projectForwardRecoveryManifest({
    receipt: value,
    expected: options.expected || expected(value),
    application_id: "chief-moa",
    device_id: "phone-1",
    download_url: "https://gateway.example.test/v1/release-recovery/artifacts/recovery-stable-12-as-31.apk",
    inspectArtifact: options.inspectArtifact || (async () => observation(value)),
  });
}

test("projects exact forward rebuild identity and provenance", async () => {
  const value = receipt();
  const manifest = await project(value);
  assert.equal(manifest.schema_version, "moa-forward-recovery-manifest/v1");
  assert.equal(manifest.recovery_id, value.recovery_release_id);
  assert.equal(manifest.target.source_commit, SOURCE);
  assert.equal(manifest.target.artifact_sha256, C);
  assert.equal(manifest.target.version_code, 12);
  assert.equal(Object.hasOwn(manifest.target, "artifact_version_code"), false);
  assert.equal(manifest.predecessor.release_id, "trial-release-30");
  assert.equal(manifest.predecessor.version_code, 30);
  assert.deepEqual(manifest.parents.stable, value.parent_stable);
  assert.deepEqual(manifest.parents.trial, value.parent_trial);
  assert.deepEqual(manifest.artifact, {
    release_id: value.recovery_release_id,
    version_code: 31,
    version_name: "1.2.0-recovery.31",
    package_name: "ag.companion",
    sha256: A,
    size_bytes: 4096,
    signer_sha256: B,
    source_commit: SOURCE,
    built_at: "2026-08-14T17:00:00.000Z",
    download_url: "https://gateway.example.test/v1/release-recovery/artifacts/recovery-stable-12-as-31.apk",
  });
  assert.equal(manifest.provenance.builder_commit, BUILDER);
  assert.equal(manifest.provenance.parent_trial_bundle_id, "trial-30");
  assert.equal(Object.isFrozen(manifest), true);
});

test("rejects a recovery that is not forward-versioned past the replaced build", async () => {
  const value = receipt();
  value.artifact.version_code = 30;
  value.provenance_sha256 = provenanceDigest(value);
  await assert.rejects(() => project(value), (error) => (
    error instanceof ForwardRecoveryError && error.code === "recovery_provenance_stale"
  ));
});

test("rejects a recovery target that is not its exact confirmed parent", async () => {
  const value = receipt();
  value.target_predecessor.sequence = 11;
  value.provenance_sha256 = provenanceDigest(value);
  await assert.rejects(() => project(value), (error) => (
    error.code === "recovery_provenance_stale"
  ));
});

test("rejects a replaced build that is not one of the confirmed parents", async () => {
  const value = receipt();
  value.replaces.bundle_id = "unrelated-bundle";
  value.replaces.release_id = "unrelated-release";
  value.provenance_sha256 = provenanceDigest(value);
  await assert.rejects(() => project(value), (error) => (
    error.code === "recovery_provenance_stale"
  ));
});

test("rejects stale target, replacement, parent, source, or provenance bindings", async () => {
  for (const mutate of [
    (value) => { value.source_commit = "4".repeat(40); },
    (value) => { value.target_predecessor.sequence += 1; },
    (value) => { value.replaces.release_id = "new-running-release"; },
    (value) => { value.parent_stable.sequence += 1; },
    (value) => { value.parent_trial = null; },
  ]) {
    const value = receipt();
    const authoritative = expected(value);
    mutate(value);
    value.provenance_sha256 = provenanceDigest(value);
    await assert.rejects(() => project(value, { expected: authoritative }), (error) => (
      error.code === "recovery_provenance_stale"
    ));
  }
  const value = receipt();
  value.artifact.sha256 = C;
  await assert.rejects(() => project(value), (error) => error.code === "recovery_provenance_stale");
});

test("rejects missing and identity-mismatched APK artifacts", async () => {
  const value = receipt();
  for (const observed of [
    null,
    { ...observation(value), available: false },
    { ...observation(value), sha256: C },
    { ...observation(value), size_bytes: 4097 },
    { ...observation(value), app_id: "ai.moa.assistant" },
    { ...observation(value), version_code: 32 },
    { ...observation(value), signer_sha256: C },
  ]) {
    await assert.rejects(() => project(value, { inspectArtifact: async () => observed }), (error) => (
      error.code === "recovery_artifact_unavailable"
    ));
  }
});

test("rejects malformed fields and unsafe download URLs", async () => {
  const value = receipt();
  value.artifact.app_id = "bad package";
  value.provenance_sha256 = provenanceDigest(value);
  await assert.rejects(() => project(value), (error) => error.code === "invalid_recovery_manifest");

  const valid = receipt();
  await assert.rejects(() => projectForwardRecoveryManifest({
    receipt: valid,
    expected: expected(valid),
    application_id: "chief-moa",
    device_id: "phone-1",
    download_url: "http://gateway.test/recovery.apk",
    inspectArtifact: async () => observation(valid),
  }), (error) => error.code === "invalid_recovery_manifest");
});
