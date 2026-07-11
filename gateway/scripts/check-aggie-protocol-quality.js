"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const parser = require("@babel/parser");

const target = path.resolve(__dirname, "../lib/aggie-surface-protocol.js");
const source = fs.readFileSync(target, "utf8");
const ast = parser.parse(source, { sourceType: "script" });
const qualityFunctions = new Set([
  "canExecuteProposal", "proposalContextFailure",
  "validateApprovalForProposal", "approvalMismatch", "approvalScopeMismatch",
  "approvalBindingMismatch", "approvalDecisionMismatch",
]);
const nodes = new Map();
walk(ast, (node, parent) => {
  if (node.type === "FunctionDeclaration" && qualityFunctions.has(node.id?.name)) nodes.set(node.id.name, node);
}, true);
if (nodes.size !== qualityFunctions.size) throw new Error("quality gate could not locate every proposal decision function");

const coverageDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "aggie-quality-"));
const run = spawnSync(process.execPath, ["--test", "test/aggie-surface-protocol.test.js"], {
  cwd: path.resolve(__dirname, ".."), env: { ...process.env, NODE_V8_COVERAGE: coverageDirectory }, encoding: "utf8",
});
if (run.status !== 0) {
  process.stdout.write(run.stdout);
  process.stderr.write(run.stderr);
  process.exit(run.status || 1);
}
const scriptCoverage = readCoverage(coverageDirectory, target);
const results = [];
for (const [name, node] of nodes) {
  const complexity = cyclomatic(node);
  const coverage = functionCoverage(scriptCoverage, node.start, node.end);
  const crap = complexity ** 2 * (1 - coverage) ** 3 + complexity;
  results.push({ name, complexity, coverage_percent: Number((coverage * 100).toFixed(2)), crap: Number(crap.toFixed(2)) });
}
fs.rmSync(coverageDirectory, { recursive: true, force: true });
const failures = results.filter((item) => item.complexity > 10 || item.crap > 30);
console.log(JSON.stringify({ ok: failures.length === 0, thresholds: { cyclomatic: 10, crap: 30 }, functions: results }));
if (failures.length) process.exitCode = 1;

function cyclomatic(root) {
  let score = 1;
  walk(root.body, (node, parent) => {
    if (node !== root && isFunction(node)) return false;
    if (["IfStatement", "ConditionalExpression", "ForStatement", "ForInStatement", "ForOfStatement", "WhileStatement", "DoWhileStatement", "CatchClause"].includes(node.type)) score += 1;
    if (node.type === "LogicalExpression" && ["&&", "||", "??"].includes(node.operator)) score += 1;
    if (node.type === "SwitchCase" && node.test !== null) score += 1;
    return true;
  }, true);
  return score;
}

function readCoverage(directory, filename) {
  for (const entry of fs.readdirSync(directory)) {
    const payload = JSON.parse(fs.readFileSync(path.join(directory, entry), "utf8"));
    const found = payload.result.find((item) => path.resolve(item.url.replace(/^file:\/\//, "")) === filename);
    if (found) return found;
  }
  throw new Error("V8 coverage did not include protocol source");
}

function functionCoverage(script, start, end) {
  const record = script.functions.find((item) => item.ranges[0]?.startOffset === start && item.ranges[0]?.endOffset === end);
  if (!record) throw new Error(`V8 coverage did not include function at ${start}`);
  const length = end - start;
  const uncovered = record.ranges.filter((range) => range.count === 0).reduce((sum, range) => sum + (range.endOffset - range.startOffset), 0);
  return Math.max(0, Math.min(1, (length - uncovered) / length));
}

function isFunction(node) { return /Function/.test(node.type) || node.type === "ObjectMethod" || node.type === "ClassMethod"; }
function walk(node, visit, descend) {
  if (!node || typeof node !== "object") return;
  const shouldDescend = visit(node) !== false && descend;
  if (!shouldDescend) return;
  for (const [key, value] of Object.entries(node)) {
    if (["loc", "start", "end", "extra"].includes(key)) continue;
    if (Array.isArray(value)) value.forEach((item) => walk(item, visit, true));
    else if (value && typeof value.type === "string") walk(value, visit, true);
  }
}
