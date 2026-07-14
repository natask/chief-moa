#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "..");
const MAX_SOURCE_LINES = 2000;
const TARGET_PRODUCTION_LINES = 60000;
const ULTIMATE_PRODUCTION_LINES = 10000;
const LEGACY_PRODUCTION_LINE_CEILING = 74900;
const MAX_TEST_TO_PRODUCTION_RATIO = 2;
const SOURCE_EXTENSIONS = new Set([".cjs", ".css", ".go", ".html", ".java", ".js", ".kt", ".mjs", ".py", ".rs", ".swift", ".ts", ".tsx"]);
const EXCLUDED_PARTS = new Set(["node_modules", "build", "dist", "coverage", "vendor"]);

// Existing debt may shrink but may not grow. Lower these ceilings after every
// extraction; remove the entry once the file is at or below MAX_SOURCE_LINES.
const LEGACY_DEBT_CEILINGS = Object.freeze({
  "android_app/app/src/main/java/ai/moa/assistant/OverlayService.java": 3659,
  "browser_extension/extension/background.js": 4489,
  "browser_extension/extension/content.js": 3704,
  "gateway/lib/voice-providers.js": 4016,
  "gateway/lib/voice-session-server.js": 2047,
  "gateway/server.js": 15331,
});

function lineCount(text) {
  if (!text) return 0;
  return text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;
}

function isProductionSource(relativePath) {
  const parts = relativePath.split("/");
  const lowerParts = parts.map((part) => part.toLowerCase());
  if (parts.some((part) => EXCLUDED_PARTS.has(part))) return false;
  if (lowerParts.some((part) => part === "test" || part === "tests" || part === "__tests__" || part === "docs")) return false;
  if (lowerParts[0] === "scratch" || lowerParts[0] === "reference") return false;
  if (path.basename(relativePath).toLowerCase() === "tests.rs") return false;
  if (/(?:^|\/)(?:scripts?|tools?)\//.test(relativePath)) return false;
  if (/\.(?:test|spec)\.[^.]+$/.test(relativePath)) return false;
  return SOURCE_EXTENSIONS.has(path.extname(relativePath));
}

function trackedFiles(root = REPO_ROOT) {
  return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
}

function auditSourceSizes({ root = REPO_ROOT, files = trackedFiles(root) } = {}) {
  const oversized = [];
  const violations = [];
  let productionLines = 0;
  let productionFiles = 0;
  let testLines = 0;
  let testFiles = 0;
  for (const relativePath of files) {
    const absolutePath = path.join(root, relativePath);
    if (!fs.existsSync(absolutePath)) continue;
    if (!fs.statSync(absolutePath).isFile()) continue;
    const lines = lineCount(fs.readFileSync(absolutePath, "utf8"));
    if (isTestSource(relativePath)) {
      testLines += lines;
      testFiles += 1;
      continue;
    }
    if (!isProductionSource(relativePath)) continue;
    productionLines += lines;
    productionFiles += 1;
    if (lines <= MAX_SOURCE_LINES) continue;
    const ceiling = LEGACY_DEBT_CEILINGS[relativePath];
    const record = { path: relativePath, lines, ceiling: ceiling || MAX_SOURCE_LINES };
    oversized.push(record);
    if (!ceiling || lines > ceiling) violations.push(record);
  }
  oversized.sort((a, b) => b.lines - a.lines || a.path.localeCompare(b.path));
  violations.sort((a, b) => b.lines - a.lines || a.path.localeCompare(b.path));
  const testToProductionRatio = productionLines ? testLines / productionLines : 0;
  if (productionLines > LEGACY_PRODUCTION_LINE_CEILING) {
    violations.push({ path: "<production-total>", lines: productionLines, ceiling: LEGACY_PRODUCTION_LINE_CEILING });
  }
  if (testToProductionRatio > MAX_TEST_TO_PRODUCTION_RATIO) {
    violations.push({ path: "<test-to-production-ratio>", lines: testLines, ceiling: productionLines * MAX_TEST_TO_PRODUCTION_RATIO });
  }
  return {
    maxLines: MAX_SOURCE_LINES,
    targetProductionLines: TARGET_PRODUCTION_LINES,
    ultimateProductionLines: ULTIMATE_PRODUCTION_LINES,
    productionLineCeiling: LEGACY_PRODUCTION_LINE_CEILING,
    productionLines,
    productionFiles,
    testLines,
    testFiles,
    testToProductionRatio,
    oversized,
    violations,
  };
}

function formatAudit(audit) {
  const rows = audit.oversized.map((item) => `${String(item.lines).padStart(6)}  ${item.path} (ceiling ${item.ceiling})`);
  return [
    `Production source limit: ${audit.maxLines} lines per file`,
    `Production total: ${audit.productionLines} lines (milestone ${audit.targetProductionLines}, ultimate ${audit.ultimateProductionLines}, current ceiling ${audit.productionLineCeiling})`,
    `Test total: ${audit.testLines} lines (${audit.testToProductionRatio.toFixed(3)}x production, limit ${MAX_TEST_TO_PRODUCTION_RATIO}x)`,
    ...rows,
  ].join("\n");
}

function isTestSource(relativePath) {
  const parts = relativePath.split("/");
  const lowerParts = parts.map((part) => part.toLowerCase());
  if (parts.some((part) => EXCLUDED_PARTS.has(part))) return false;
  if (!SOURCE_EXTENSIONS.has(path.extname(relativePath))) return false;
  if (lowerParts.some((part) => part === "test" || part === "tests" || part === "__tests__")) return true;
  if (path.basename(relativePath).toLowerCase() === "tests.rs") return true;
  if (/\.(?:test|spec)\.[^.]+$/.test(relativePath)) return true;
  return /(?:^|\/)scripts?\/(?:smoke-|test-|verify-)/.test(relativePath);
}

if (require.main === module) {
  const audit = auditSourceSizes();
  console.log(formatAudit(audit));
  if (audit.violations.length) {
    console.error("\nSource-size policy violations:");
    for (const item of audit.violations) console.error(`- ${item.path}: ${item.lines} lines (limit ${item.ceiling})`);
    process.exitCode = 1;
  }
}

module.exports = {
  LEGACY_DEBT_CEILINGS,
  LEGACY_PRODUCTION_LINE_CEILING,
  MAX_SOURCE_LINES,
  MAX_TEST_TO_PRODUCTION_RATIO,
  TARGET_PRODUCTION_LINES,
  ULTIMATE_PRODUCTION_LINES,
  auditSourceSizes,
  formatAudit,
  isProductionSource,
  isTestSource,
  lineCount,
};
