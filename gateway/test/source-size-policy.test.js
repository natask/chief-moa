"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  MAX_SOURCE_LINES,
  TARGET_PRODUCTION_LINES,
  auditSourceSizes,
  isProductionSource,
  isTestSource,
  lineCount,
} = require("../../scripts/source-size-policy");

test("source-size policy recognizes production code but excludes tests and scripts", () => {
  assert.equal(isProductionSource("gateway/server.js"), true);
  assert.equal(isProductionSource("gateway/lib/example.js"), true);
  assert.equal(isProductionSource("gateway/test/example.test.js"), false);
  assert.equal(isProductionSource("gateway/scripts/smoke-example.js"), false);
  assert.equal(isProductionSource("gateway/package-lock.json"), false);
  assert.equal(isTestSource("gateway/test/example.test.js"), true);
  assert.equal(isTestSource("gateway/scripts/smoke-example.js"), true);
  assert.equal(isTestSource("apple_surfaces/Tests/MoaTests/SurfaceTests.swift"), true);
  assert.equal(isTestSource("windows_app/core/src/tests.rs"), true);
  assert.equal(isTestSource("scripts/deploy.sh"), false);
  assert.equal(isProductionSource("scratch/example.html"), false);
  assert.equal(lineCount("one\ntwo\n"), 2);
  assert.equal(MAX_SOURCE_LINES, 2000);
  assert.equal(TARGET_PRODUCTION_LINES, 60000);
});

test("tracked and non-ignored production sources do not exceed a debt ceiling", () => {
  const audit = auditSourceSizes();
  assert.deepEqual(audit.violations, [], JSON.stringify(audit.violations, null, 2));
  assert.ok(audit.productionLines > audit.targetProductionLines);
});
