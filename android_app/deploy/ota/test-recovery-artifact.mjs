import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  assertSourceCommitAvailable,
  canonicalJson,
  finalizeRecovery,
  installRecoveryArtifact,
  prepareRecovery,
  provenanceSha256,
} from "./recovery-artifact.mjs";

const TARGET_SHA = "1".repeat(64);
const REPLACES_SHA = "2".repeat(64);
const SIGNER = "8f0b62c73777a961687041f6faac24597830127d1f0ca9841aa6f7c70fe6ae0d";
const SOURCE = "a".repeat(40);
const BUILDER = "b".repeat(40);

function request(overrides = {}) {
  return {
    schema_version: 1,
    target_predecessor: {
      channel: "stable", bundle_id: "stable-7", release_id: "stable-release-7",
      sequence: 7, source_commit: SOURCE, artifact_sha256: TARGET_SHA,
      artifact_version_code: 70, artifact_size_bytes: 4, app_id: "ag.companion",
      signer_sha256: SIGNER,
    },
    replaces: {
      bundle_id: "trial-9", release_id: "trial-release-9", source_commit: "c".repeat(40),
      artifact_sha256: REPLACES_SHA, artifact_version_code: 90,
    },
    parent_stable: { bundle_id: "stable-7", release_id: "stable-release-7", sequence: 7 },
    parent_trial: { bundle_id: "trial-9", release_id: "trial-release-9", sequence: 9 },
    ...overrides,
  };
}

function predecessorFacts(overrides = {}) {
  return {
    app_id: "ag.companion", version_code: 70, size_bytes: 4,
    sha256: TARGET_SHA, signer_sha256: SIGNER, ...overrides,
  };
}

test("prepares and finalizes a distinct forward recovery artifact with exact provenance", () => {
  const plan = prepareRecovery(request(), predecessorFacts(), 91, BUILDER);
  const apk = Buffer.from("new recovery bytes");
  const sha256 = crypto.createHash("sha256").update(apk).digest("hex");
  const receipt = finalizeRecovery(plan, {
    app_id: "ag.companion", version_code: 91, signer_sha256: SIGNER,
    sha256, size_bytes: apk.length,
  }, "2026-08-14T17:00:00.000Z");

  assert.equal(receipt.source_commit, SOURCE);
  assert.equal(receipt.builder_commit, BUILDER);
  assert.equal(receipt.artifact.version_code, 91);
  assert.equal(receipt.replaces.release_id, "trial-release-9");
  assert.notEqual(receipt.artifact.sha256, receipt.target_predecessor.artifact_sha256);
  assert.equal(receipt.download_path,
    `/v1/release-recovery/artifacts/${receipt.recovery_release_id}.apk`);
  assert.equal(receipt.provenance_sha256, provenanceSha256(receipt));
  assert.match(canonicalJson({ z: 1, a: { y: 2, x: 3 } }), /^\{"a":\{"x":3,"y":2\},"z":1\}$/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-recovery-artifact-"));
  try {
    const sourceApk = path.join(dir, "candidate.apk");
    fs.writeFileSync(sourceApk, apk);
    const releaseDir = installRecoveryArtifact(path.join(dir, "store"), sourceApk, receipt);
    assert.deepEqual(fs.readFileSync(path.join(releaseDir, "moa-assistant.apk")), apk);
    assert.equal(JSON.parse(fs.readFileSync(path.join(releaseDir, "recovery.json"))).provenance_sha256,
      receipt.provenance_sha256);
    assert.equal(installRecoveryArtifact(path.join(dir, "store"), sourceApk, receipt), releaseDir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects Android downgrade and a stale stable or trial binding", () => {
  assert.throws(() => prepareRecovery(request(), predecessorFacts(), 90, BUILDER),
    /not forward-versioned/);
  assert.throws(() => prepareRecovery(request({
    parent_stable: { bundle_id: "stable-new", release_id: "stable-release-8", sequence: 8 },
  }), predecessorFacts(), 91, BUILDER), /binding is stale/);
  assert.throws(() => prepareRecovery(request({
    target_predecessor: { ...request().target_predecessor, channel: "trial" },
    parent_trial: null,
  }), predecessorFacts(), 91, BUILDER), /binding is stale/);
  assert.throws(() => prepareRecovery(request({
    replaces: { ...request().replaces, bundle_id: "trial-stale" },
  }), predecessorFacts(), 91, BUILDER), /replaced release binding is stale/);
});

test("rejects predecessor digest, package, signer, size, and version mismatches", () => {
  for (const [field, value] of [
    ["sha256", "3".repeat(64)], ["app_id", "other.companion"],
    ["signer_sha256", "4".repeat(64)], ["size_bytes", 5], ["version_code", 71],
  ]) {
    assert.throws(() => prepareRecovery(request(), predecessorFacts({ [field]: value }), 91, BUILDER),
      /APK identity does not match/);
  }
});

test("rejects a built APK with the wrong package, signer, digest bytes, or version", () => {
  const plan = prepareRecovery(request(), predecessorFacts(), 91, BUILDER);
  const good = {
    app_id: "ag.companion", version_code: 91, signer_sha256: SIGNER,
    sha256: "5".repeat(64), size_bytes: 10,
  };
  for (const changed of [
    { app_id: "other.companion" }, { signer_sha256: "6".repeat(64) }, { version_code: 92 },
  ]) {
    assert.throws(() => finalizeRecovery(plan, { ...good, ...changed }, "2026-08-14T17:00:00Z"),
      /package, version, or continuity signer/);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-recovery-bytes-"));
  try {
    const apk = path.join(dir, "candidate.apk");
    fs.writeFileSync(apk, "wrong bytes");
    const receipt = finalizeRecovery(plan, good, "2026-08-14T17:00:00Z");
    assert.throws(() => installRecoveryArtifact(path.join(dir, "store"), apk, receipt),
      /APK bytes changed/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("fails closed when exact source or predecessor artifact is unavailable", () => {
  assert.doesNotThrow(() => assertSourceCommitAvailable(SOURCE, SOURCE));
  assert.throws(() => assertSourceCommitAvailable("d".repeat(40), SOURCE), /source commit is unavailable/);
  const missing = path.join(os.tmpdir(), `missing-recovery-${process.pid}.apk`);
  assert.throws(() => installRecoveryArtifact(os.tmpdir(), missing, {
    recovery_release_id: "missing", artifact: { sha256: "0".repeat(64), size_bytes: 1 },
  }), /ENOENT/);
});

test("publisher rejects missing continuity signing before request parsing or Gradle", () => {
  const script = path.join(import.meta.dirname, "build-recovery-artifact.sh");
  const env = { ...process.env };
  delete env.MOA_ANDROID_KEYSTORE_PATH;
  delete env.MOA_ANDROID_KEYSTORE_PASSWORD;
  delete env.MOA_ANDROID_KEY_ALIAS;
  delete env.MOA_ANDROID_KEY_PASSWORD;
  const result = spawnSync("bash", [script], { env, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /continuity release signing is required/);
  assert.doesNotMatch(result.stderr, /request provenance|Gradle|gradlew/);

  const unavailable = spawnSync("bash", [script], {
    env: {
      ...env,
      MOA_ANDROID_KEYSTORE_PATH: path.join(os.tmpdir(), `missing-keystore-${process.pid}`),
      MOA_ANDROID_KEYSTORE_PASSWORD: "not-a-real-secret",
      MOA_ANDROID_KEY_ALIAS: "continuity",
    },
    encoding: "utf8",
  });
  assert.equal(unavailable.status, 1);
  assert.match(unavailable.stderr, /continuity keystore is unavailable/);
  assert.doesNotMatch(unavailable.stderr, /request provenance|Gradle|gradlew/);
});
