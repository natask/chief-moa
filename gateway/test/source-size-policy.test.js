"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  LEGACY_DEBT_CEILINGS,
  LEGACY_PRODUCTION_LINE_CEILING,
  MAX_SOURCE_LINES,
  MAX_TEST_TO_PRODUCTION_RATIO,
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
  assert.equal(TARGET_PRODUCTION_LINES, 50000);
  assert.equal(LEGACY_PRODUCTION_LINE_CEILING, 95208);
  assert.equal(MAX_TEST_TO_PRODUCTION_RATIO, 2);
});

test("legacy debt ceilings equal the checked-in file baselines", () => {
  for (const [relativePath, ceiling] of Object.entries(LEGACY_DEBT_CEILINGS)) {
    const source = fs.readFileSync(path.join(__dirname, "..", "..", relativePath), "utf8");
    assert.equal(
      lineCount(source),
      ceiling,
      `${relativePath} changed without ratcheting its exact legacy ceiling`,
    );
  }
});

test("tracked and non-ignored production sources do not exceed a debt ceiling", () => {
  const audit = auditSourceSizes();
  assert.deepEqual(audit.violations, [], JSON.stringify(audit.violations, null, 2));
  assert.ok(audit.productionLines > audit.targetProductionLines);
  assert.ok(audit.testToProductionRatio <= MAX_TEST_TO_PRODUCTION_RATIO);
});

test("a bounded new module may increase the reported total without violating architecture debt", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moa-source-size-policy-"));
  try {
    fs.mkdirSync(path.join(root, "gateway", "lib"), { recursive: true });
    fs.writeFileSync(path.join(root, "gateway", "lib", "bounded.js"), "const value = 1;\n");
    const audit = auditSourceSizes({ root, files: ["gateway/lib/bounded.js"] });
    assert.equal(audit.productionLines, 1);
    assert.deepEqual(audit.violations, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("production total cannot grow above the repository debt ceiling", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moa-source-total-debt-"));
  try {
    const files = writeProductionLines(root, LEGACY_PRODUCTION_LINE_CEILING + 1);
    const audit = auditSourceSizes({ root, files });
    assert.deepEqual(
      audit.violations.filter((item) => item.path === "<production-line-total>"),
      [{
        path: "<production-line-total>",
        lines: LEGACY_PRODUCTION_LINE_CEILING + 1,
        ceiling: LEGACY_PRODUCTION_LINE_CEILING,
      }],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("production at the final target has no total-size violation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moa-source-final-target-"));
  try {
    const files = writeProductionLines(root, TARGET_PRODUCTION_LINES);
    const audit = auditSourceSizes({ root, files });
    assert.equal(audit.productionLines, TARGET_PRODUCTION_LINES);
    assert.equal(audit.violations.some((item) => item.path === "<production-line-total>"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function writeProductionLines(root, totalLines) {
  const directory = path.join(root, "gateway", "lib");
  fs.mkdirSync(directory, { recursive: true });
  const files = [];
  let remaining = totalLines;
  let index = 0;
  while (remaining > 0) {
    const lines = Math.min(MAX_SOURCE_LINES, remaining);
    const relativePath = `gateway/lib/total-${index}.js`;
    fs.writeFileSync(path.join(root, relativePath), "const value = 1;\n".repeat(lines));
    files.push(relativePath);
    remaining -= lines;
    index += 1;
  }
  return files;
}
