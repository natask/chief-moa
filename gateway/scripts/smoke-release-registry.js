#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  createFileReleaseAdapter,
  createInMemoryReleaseAdapter,
  createReleaseRegistry,
  stableRolloutBucket,
  validateRelease,
} = require("../lib/release-registry");

const SIGNATURE = Buffer.alloc(64, 7).toString("base64");
const SHA256 = "a".repeat(64);
const GIT_SHA = "b".repeat(40);

function fixture(overrides = {}) {
  return {
    schema_version: "moa-release/v1",
    release_id: "rel-android-101",
    app_id: "chief-moa",
    platform: "android",
    arch: "arm64",
    channel: "stable",
    semantic_version: "1.1.0",
    monotonic_build: 101,
    protocol: { min: 1, max: 2 },
    git_sha: GIT_SHA,
    artifact_url: "https://releases.example.test/chief-moa/android/101.apk",
    size: 4096,
    sha256: SHA256,
    signature: { algorithm: "ed25519", key_id: "release-key-1", value: SIGNATURE },
    provenance: {
      builder: "github-actions/release",
      source_url: `https://github.com/example/chief-moa/commit/${GIT_SHA}`,
      attestation_url: "https://releases.example.test/attestations/101.json",
      attestation_sha256: "c".repeat(64),
    },
    published_at: "2026-07-13T20:00:00.000Z",
    rollout: { percentage: 100, salt: "android-101-stable" },
    mandatory: false,
    rollback_release: null,
    release_notes: { summary: "Durable shared update planning.", url: "https://releases.example.test/notes/101" },
    ...overrides,
  };
}

function client(overrides = {}) {
  return {
    app_id: "chief-moa",
    platform: "android",
    arch: "arm64",
    channel: "stable",
    current_build: 100,
    protocol_version: 2,
    installation_id: "install-alpha",
    ...overrides,
  };
}

function main() {
  const checks = [];
  const registry = createReleaseRegistry({ adapter: createInMemoryReleaseAdapter() });
  registry.publish(fixture());

  step(checks, "compatible upgrade is planned without installation", () => {
    const result = registry.check(client());
    assert.equal(result.status, "eligible");
    assert.equal(result.reason, "newer_compatible_release");
    assert.equal(result.release.release_id, "rel-android-101");
    assert.equal(result.install_performed, false);
  });

  step(checks, "staged rollout is deterministic and defers an outside cohort", () => {
    const bucket = stableRolloutBucket("install-alpha", "staged-102");
    const percentage = Math.max(0, bucket - 0.000001);
    registry.publish(fixture({
      release_id: "rel-android-102",
      semantic_version: "1.2.0",
      monotonic_build: 102,
      artifact_url: "https://releases.example.test/chief-moa/android/102.apk",
      rollout: { percentage, salt: "staged-102" },
    }));
    const first = registry.check(client());
    const second = registry.check(client());
    assert.equal(first.status, "deferred");
    assert.equal(first.reason, "outside_rollout_cohort");
    assert.equal(first.rollout_bucket, second.rollout_bucket);
  });

  step(checks, "incompatible protocol fails before artifact handling", () => {
    const result = registry.check(client({ protocol_version: 9 }));
    assert.equal(result.status, "incompatible");
    assert.equal(result.reason, "protocol_out_of_range");
    assert.equal(result.install_performed, false);
  });

  step(checks, "ordinary downgrade is rejected and declared rollback is planned", () => {
    const rollbackRegistry = createReleaseRegistry({ adapter: createInMemoryReleaseAdapter() });
    rollbackRegistry.publish(fixture({
      release_id: "rel-android-100",
      semantic_version: "1.0.0",
      monotonic_build: 100,
      artifact_url: "https://releases.example.test/chief-moa/android/100.apk",
    }));
    rollbackRegistry.publish(fixture({
      release_id: "rel-android-101",
      rollback_release: "rel-android-100",
    }));
    const ordinary = rollbackRegistry.check(client({ current_build: 102 }));
    assert.equal(ordinary.status, "incompatible");
    assert.equal(ordinary.reason, "downgrade_not_authorized");
    const rollback = rollbackRegistry.planRollback(client({ current_release_id: "rel-android-101", current_build: 101 }));
    assert.equal(rollback.status, "eligible");
    assert.equal(rollback.reason, "authorized_rollback");
    assert.equal(rollback.release.release_id, "rel-android-100");
    assert.equal(rollback.operation, "rollback");
    assert.equal(rollback.install_performed, false);
  });

  step(checks, "malformed signatures fail closed", () => {
    assert.throws(
      () => validateRelease(fixture({ signature: { algorithm: "ed25519", key_id: "release-key-1", value: "not-base64" } })),
      (error) => error.code === "malformed_signature" && error.field === "signature.value",
    );
  });

  step(checks, "file adapter persists the same validated release", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-release-registry-"));
    try {
      const file = path.join(dir, "registry.json");
      const first = createReleaseRegistry({ adapter: createFileReleaseAdapter(file) });
      first.publish(fixture());
      const reopened = createReleaseRegistry({ adapter: createFileReleaseAdapter(file) });
      assert.equal(reopened.get("rel-android-101").sha256, SHA256);
      assert.equal(reopened.check(client()).status, "eligible");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  console.log(JSON.stringify({ ok: true, checks }, null, 2));
}

function step(checks, name, action) {
  action();
  checks.push(name);
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
}
