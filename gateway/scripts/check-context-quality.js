#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const parser = require("@babel/parser");

const sourcePath = path.resolve(__dirname, "..", "lib", "context-artifact.js");
const source = fs.readFileSync(sourcePath, "utf8");
const ast = parser.parse(source, { sourceType: "script", ranges: true, plugins: ["optionalChaining"] });
const functions = ast.program.body.filter((node) => node.type === "FunctionDeclaration");
const coverageDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-context-quality-"));

try {
  const testRun = spawnSync(process.execPath, ["--test", "test/context-artifact.test.js"], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, NODE_V8_COVERAGE: coverageDir },
    encoding: "utf8",
    timeout: 60_000,
  });
  if (testRun.status !== 0) {
    process.stderr.write(testRun.stdout || "");
    process.stderr.write(testRun.stderr || "");
    process.exit(testRun.status || 1);
  }
  const scriptCoverage = loadScriptCoverage(coverageDir, sourcePath);
  const rows = functions.map((fn) => qualityRow(fn, scriptCoverage));
  const maxComplexity = Math.max(...rows.map((row) => row.complexity));
  const maxCrap = Math.max(...rows.map((row) => row.crap));
  assert.ok(maxComplexity <= 10, `context complexity ${maxComplexity} exceeds 10`);
  assert.ok(maxCrap <= 15, `context CRAP ${maxCrap.toFixed(6)} exceeds 15`);
  console.log(JSON.stringify({
    ok: true,
    method: "Babel AST McCabe decisions + Node V8 per-statement coverage",
    thresholds: { complexity: 10, crap: 15 },
    max_complexity: maxComplexity,
    max_crap: Number(maxCrap.toFixed(6)),
    functions: rows,
  }, null, 2));
} finally {
  fs.rmSync(coverageDir, { recursive: true, force: true });
}

function qualityRow(fn, scriptCoverage) {
  const complexity = complexityOf(fn.body);
  const statements = collectStatements(fn.body);
  const covered = statements.filter((statement) => coverageCountAt(scriptCoverage, statement.start) > 0).length;
  const coverage = statements.length ? covered / statements.length : 1;
  const crap = (complexity ** 2) * ((1 - coverage) ** 3) + complexity;
  return { name: fn.id.name, complexity, statements: statements.length, covered, coverage: Number(coverage.toFixed(6)), crap: Number(crap.toFixed(6)) };
}

function complexityOf(root) {
  let complexity = 1;
  walk(root, (node) => {
    if (["IfStatement", "ConditionalExpression", "ForStatement", "ForInStatement", "ForOfStatement", "WhileStatement", "DoWhileStatement", "CatchClause"].includes(node.type)) complexity += 1;
    if (node.type === "LogicalExpression" && ["&&", "||", "??"].includes(node.operator)) complexity += 1;
  });
  return complexity;
}

function collectStatements(root) {
  const statements = [];
  walk(root, (node) => {
    if (node.type.endsWith("Statement") || node.type === "VariableDeclaration" || node.type === "CatchClause") statements.push(node);
  });
  return statements;
}

function walk(node, visit, isRoot = true) {
  if (!node || typeof node !== "object") return;
  const typed = typeof node.type === "string";
  if (!isRoot && typed && (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression")) return;
  if (typed) visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (["loc", "start", "end", "range", "type"].includes(key)) continue;
    if (Array.isArray(value)) for (const child of value) walk(child, visit, false);
    else walk(value, visit, false);
  }
}

function loadScriptCoverage(directory, targetPath) {
  for (const name of fs.readdirSync(directory)) {
    const report = JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"));
    const found = report.result.find((entry) => entry.url === targetPath || entry.url === `file://${targetPath}`);
    if (found) return found;
  }
  throw new Error(`V8 coverage missing for ${targetPath}`);
}

function coverageCountAt(scriptCoverage, offset) {
  let best = null;
  for (const fn of scriptCoverage.functions) {
    for (const range of fn.ranges) {
      if (range.startOffset <= offset && offset < range.endOffset && (!best || range.endOffset - range.startOffset < best.endOffset - best.startOffset)) best = range;
    }
  }
  return best ? best.count : 0;
}
