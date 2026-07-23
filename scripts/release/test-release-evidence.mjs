#!/usr/bin/env node
"use strict";

import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateReleaseEvidence } from "./release-evidence.mjs";

const digest = "a".repeat(64);
const gitSha = "b".repeat(40);
const at = "2026-07-22T00:00:00Z";

function document(surface, states) {
  return {
    version: "moa-release-evidence/v1",
    surface,
    release_id: `release-${surface.replace("_", "-")}`,
    channel: "stable",
    artifact: { artifact_id: `artifact-${surface.replace("_", "-")}`, sha256: digest, git_sha: gitSha },
    evidence: states.map((state) => ({
      state,
      release_id: `release-${surface.replace("_", "-")}`,
      artifact_sha256: digest,
      verifier: "deterministic-test",
      evidence_ref: `fixture/${state}`,
      occurred_at: at,
    })),
  };
}

test("Android publication requires exact-byte device QA", () => {
  const result = evaluateReleaseEvidence(document("android", [
    "built", "verified", "platform_signed", "packaged",
    "rollback_ready", "state_compatible", "no_interruption",
  ]));
  assert.equal(result.ok, true);
  assert.equal(result.publication_ready, false);
  assert.deepEqual(result.missing_for_publication, ["device_qa"]);
});

test("web publication requires preview evidence but no device install", () => {
  const result = evaluateReleaseEvidence(document("web", [
    "built", "verified", "previewed", "rollback_ready", "state_compatible", "no_interruption",
  ]));
  assert.equal(result.publication_ready, true);
  assert.equal(result.production_ready, false);
  assert.deepEqual(result.missing_for_production, ["published", "smoked"]);
});

test("macOS cannot become publishable from an unsigned simulator build", () => {
  const result = evaluateReleaseEvidence(document("macos", [
    "built", "verified", "packaged", "device_qa",
    "rollback_ready", "state_compatible", "no_interruption",
  ]));
  assert.equal(result.publication_ready, false);
  assert.deepEqual(result.missing_for_publication, ["platform_signed", "notarized"]);
});

test("browser publication and installed smoke stay separate", () => {
  const result = evaluateReleaseEvidence(document("browser_extension", [
    "built", "verified", "packaged", "browser_qa",
    "rollback_ready", "state_compatible", "no_interruption", "published",
  ]));
  assert.equal(result.publication_ready, true);
  assert.equal(result.production_ready, false);
  assert.deepEqual(result.missing_for_production, ["installed", "smoked"]);
});

test("evidence for different bytes fails closed", () => {
  const candidate = document("windows", ["built"]);
  candidate.evidence[0].artifact_sha256 = "c".repeat(64);
  const result = evaluateReleaseEvidence(candidate);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /does not match the candidate artifact/);
});

test("unknown semantic fields and duplicate states fail closed", () => {
  const candidate = document("gateway", ["built", "built"]);
  candidate.executable = "never";
  const result = evaluateReleaseEvidence(candidate);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /not allowed/);
  assert.match(result.errors.join("\n"), /duplicated/);
});

test("gateway publication requires isolated preview and restored-backup evidence", () => {
  const result = evaluateReleaseEvidence(document("gateway", [
    "built", "verified", "previewed", "rollback_ready", "state_compatible", "no_interruption",
  ]));
  assert.equal(result.publication_ready, false);
  assert.deepEqual(result.missing_for_publication, ["backup_restored"]);
});

test("Windows requires signed-package and supported-device QA evidence", () => {
  const result = evaluateReleaseEvidence(document("windows", [
    "built", "verified", "packaged", "rollback_ready", "state_compatible", "no_interruption",
  ]));
  assert.equal(result.publication_ready, false);
  assert.deepEqual(result.missing_for_publication, ["platform_signed", "device_qa"]);
});

test("all surface contracts can reach production only with their complete evidence", () => {
  const complete = {
    android: ["built", "verified", "platform_signed", "packaged", "device_qa", "rollback_ready", "state_compatible", "no_interruption", "published", "offered", "installed", "smoked"],
    browser_extension: ["built", "verified", "packaged", "browser_qa", "rollback_ready", "state_compatible", "no_interruption", "published", "installed", "smoked"],
    web: ["built", "verified", "previewed", "rollback_ready", "state_compatible", "no_interruption", "published", "smoked"],
    gateway: ["built", "verified", "previewed", "backup_restored", "rollback_ready", "state_compatible", "no_interruption", "published", "smoked"],
    macos: ["built", "verified", "platform_signed", "notarized", "packaged", "device_qa", "rollback_ready", "state_compatible", "no_interruption", "published", "installed", "smoked"],
    windows: ["built", "verified", "platform_signed", "packaged", "device_qa", "rollback_ready", "state_compatible", "no_interruption", "published", "installed", "smoked"],
  };
  for (const [surface, states] of Object.entries(complete)) {
    const result = evaluateReleaseEvidence(document(surface, states));
    assert.equal(result.ok, true, surface);
    assert.equal(result.channel_advance_allowed, true, surface);
    assert.equal(result.production_ready, true, surface);
    assert.deepEqual(result.missing_for_production, [], surface);
  }
});
