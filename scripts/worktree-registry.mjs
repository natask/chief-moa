#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCHEMA_VERSION = 1;
const REGISTRY_DIRECTORY = "chief-moa-worktree-registry";

function git(args, { cwd, allowFailure = false } = {}) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", allowFailure ? "ignore" : "pipe"] });
  } catch (error) {
    if (allowFailure) return null;
    throw error;
  }
}

export function parseWorktreePorcelain(text) {
  const records = [];
  let current = null;
  for (const field of text.split("\0")) {
    if (!field) {
      if (current) records.push(current);
      current = null;
      continue;
    }
    const separator = field.indexOf(" ");
    const key = separator < 0 ? field : field.slice(0, separator);
    const value = separator < 0 ? true : field.slice(separator + 1);
    if (key === "worktree") current = { path: value, head: "", branch: "detached", bare: false, prunable: false };
    else if (current && key === "HEAD") current.head = value;
    else if (current && key === "branch") current.branch = value;
    else if (current && key === "bare") current.bare = true;
    else if (current && key === "detached") current.branch = "detached";
    else if (current && key === "prunable") current.prunable = true;
  }
  if (current) records.push(current);
  return records;
}

export function parseClosureLedger(text) {
  if (!text.trim()) return [];
  const rows = text.trimEnd().split("\n");
  const header = rows.shift()?.split("\t") || [];
  return rows.map((row) => Object.fromEntries(row.split("\t").map((value, index) => [header[index], value])));
}

export function parseRegistryEvents(text) {
  const events = [];
  const warnings = [];
  for (const [index, line] of text.split("\n").entries()) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (!event || event.schema_version !== SCHEMA_VERSION || typeof event.event_type !== "string") {
        warnings.push({ line: index + 1, reason: "unsupported registry event" });
      } else {
        events.push(event);
      }
    } catch {
      warnings.push({ line: index + 1, reason: "invalid JSON" });
    }
  }
  return { events, warnings };
}

function normalizeClaim(value) {
  return String(value || "").trim().replace(/^\.\//u, "").replace(/\/+$/u, "");
}

function pathsOverlap(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function activeClaims(events) {
  const claims = new Map();
  for (const event of events) {
    if (event.event_type === "worktree.claim.recorded") {
      const claimId = String(event.claim_id || "");
      if (!claimId || !event.worktree_path) continue;
      claims.set(claimId, {
        claim_id: claimId,
        worktree_path: String(event.worktree_path),
        branch: String(event.branch || ""),
        task_id: String(event.task_id || ""),
        candidate_id: String(event.candidate_id || ""),
        path_claims: [...new Set((event.path_claims || []).map(normalizeClaim).filter(Boolean))].sort(),
        recorded_at: String(event.occurred_at || ""),
      });
    } else if (event.event_type === "worktree.claim.released") {
      claims.delete(String(event.claim_id || ""));
    }
  }
  return [...claims.values()];
}

function groups(values) {
  const grouped = new Map();
  for (const [key, value] of values) {
    const items = grouped.get(key) || [];
    items.push(value);
    grouped.set(key, items);
  }
  return grouped;
}

function detectConflicts(worktrees, claims) {
  const duplicateBranches = [];
  for (const [branch, paths] of groups(worktrees.filter((item) => item.branch !== "detached").map((item) => [item.branch, item.path]))) {
    const uniquePaths = [...new Set(paths)].sort();
    if (uniquePaths.length > 1) duplicateBranches.push({ branch, worktree_paths: uniquePaths });
  }

  const duplicatePathClaims = [];
  for (let left = 0; left < claims.length; left += 1) {
    for (let right = left + 1; right < claims.length; right += 1) {
      if (claims[left].worktree_path === claims[right].worktree_path) continue;
      const overlaps = [];
      for (const leftPath of claims[left].path_claims) {
        for (const rightPath of claims[right].path_claims) {
          if (pathsOverlap(leftPath, rightPath)) overlaps.push({ left: leftPath, right: rightPath });
        }
      }
      if (overlaps.length) duplicatePathClaims.push({
        claim_ids: [claims[left].claim_id, claims[right].claim_id].sort(),
        worktree_paths: [claims[left].worktree_path, claims[right].worktree_path].sort(),
        overlaps,
      });
    }
  }
  return { duplicateBranches, duplicatePathClaims };
}

function statusFor(worktree) {
  if (worktree.orphan || worktree.conflicts.length || worktree.closure_state === "closure-receipt-matches-live-worktree") return "blocked";
  if (worktree.branch === "refs/heads/master" && !worktree.dirty) return "idle-on-master";
  if (!worktree.primary && !worktree.dirty && ["contained", "patch-equivalent"].includes(worktree.integration_state)) return "closable";
  return "active";
}

export function buildRegistryIndex({ worktrees, claims = [], closures = [], warnings = [], generatedAt, targetRef, targetSha }) {
  const livePaths = new Set(worktrees.map((item) => item.path));
  const orphanClaims = claims.filter((claim) => !livePaths.has(claim.worktree_path));
  const conflicts = detectConflicts(worktrees, claims);
  const branchConflictPaths = new Set(conflicts.duplicateBranches.flatMap((item) => item.worktree_paths));
  const fileConflictPaths = new Set(conflicts.duplicatePathClaims.flatMap((item) => item.worktree_paths));
  const closureKeys = new Set(closures.map((item) => `${item.path}\0${item.head}`));

  const entries = worktrees.map((source) => {
    const evidence = claims.filter((claim) => claim.worktree_path === source.path);
    const entry = {
      path: source.path,
      head: source.head,
      branch: source.branch,
      primary: Boolean(source.primary),
      bare: Boolean(source.bare),
      prunable: Boolean(source.prunable),
      exists: source.exists !== false,
      dirty: source.dirty ?? null,
      integration_state: source.integration_state || "unknown",
      task_ids: [...new Set(evidence.map((claim) => claim.task_id).filter(Boolean))].sort(),
      candidate_ids: [...new Set(evidence.map((claim) => claim.candidate_id).filter(Boolean))].sort(),
      claim_ids: evidence.map((claim) => claim.claim_id).sort(),
      path_claims: [...new Set(evidence.flatMap((claim) => claim.path_claims))].sort(),
      closure_state: closureKeys.has(`${source.path}\0${source.head}`) ? "closure-receipt-matches-live-worktree" : "open",
      orphan: Boolean(source.prunable || source.exists === false),
      conflicts: [
        ...(branchConflictPaths.has(source.path) ? ["duplicate-branch"] : []),
        ...(fileConflictPaths.has(source.path) ? ["overlapping-path-claim"] : []),
      ],
    };
    entry.lifecycle_state = statusFor(entry);
    return entry;
  }).sort((left, right) => left.path.localeCompare(right.path));

  const byBranch = {};
  const byPathClaim = {};
  for (const entry of entries) {
    if (entry.branch !== "detached") (byBranch[entry.branch] ||= []).push(entry.path);
    for (const claim of entry.path_claims) (byPathClaim[claim] ||= []).push(entry.path);
  }
  const summary = { total: entries.length, active: 0, closable: 0, blocked: 0, idle_on_master: 0, orphan_claims: orphanClaims.length };
  for (const entry of entries) summary[entry.lifecycle_state.replaceAll("-", "_")] += 1;

  return {
    schema_version: SCHEMA_VERSION,
    generated_at: generatedAt,
    target: { ref: targetRef, sha: targetSha },
    summary,
    worktrees: entries,
    reverse_index: { by_branch: byBranch, by_path_claim: byPathClaim },
    conflicts: { duplicate_branches: conflicts.duplicateBranches, overlapping_path_claims: conflicts.duplicatePathClaims },
    orphans: {
      claims: orphanClaims,
      registered_worktrees: entries.filter((entry) => entry.orphan).map((entry) => entry.path),
    },
    closure_receipts: closures,
    warnings,
  };
}

function integrationState(cwd, head, targetSha) {
  if (!head || !targetSha) return "unknown";
  if (git(["merge-base", "--is-ancestor", head, targetSha], { cwd, allowFailure: true }) !== null) return "contained";
  const cherry = git(["cherry", targetSha, head], { cwd, allowFailure: true });
  if (cherry !== null && !cherry.split("\n").some((line) => line.startsWith("+ "))) return "patch-equivalent";
  return cherry === null ? "unknown" : "unique";
}

function inspectRepository({ cwd, targetRef }) {
  const repoRoot = git(["rev-parse", "--show-toplevel"], { cwd }).trim();
  const commonGitDir = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd }).trim();
  const primaryPath = path.dirname(commonGitDir);
  const targetSha = git(["rev-parse", "--verify", `${targetRef}^{commit}`], { cwd }).trim();
  const worktrees = parseWorktreePorcelain(git(["worktree", "list", "--porcelain", "-z"], { cwd }));
  for (const worktree of worktrees) {
    worktree.primary = path.resolve(worktree.path) === path.resolve(primaryPath);
    worktree.exists = fs.existsSync(worktree.path);
    const status = worktree.exists && !worktree.bare
      ? git(["-C", worktree.path, "status", "--porcelain=v1", "-z"], { cwd, allowFailure: true })
      : null;
    worktree.dirty = status === null ? null : Boolean(status);
    worktree.integration_state = integrationState(repoRoot, worktree.head, targetSha);
  }
  return { repoRoot, commonGitDir, targetSha, worktrees };
}

function atomicWriteJson(destination, value) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, destination);
}

function appendEvent(destination, event) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.appendFileSync(destination, `${JSON.stringify(event)}\n`, { mode: 0o600 });
}

function renderTable(index) {
  const lines = ["state\tdirty\tintegration\tbranch\ttask/candidate\tpath"];
  for (const item of index.worktrees) {
    const identities = [...item.task_ids.map((id) => `task:${id}`), ...item.candidate_ids.map((id) => `candidate:${id}`)].join(",") || "-";
    lines.push([item.lifecycle_state, item.dirty === null ? "unknown" : item.dirty ? "yes" : "no", item.integration_state, item.branch, identities, item.path].join("\t"));
  }
  lines.push(`summary\tactive=${index.summary.active}\tclosable=${index.summary.closable}\tblocked=${index.summary.blocked}\tidle-on-master=${index.summary.idle_on_master}\torphans=${index.summary.orphan_claims}`);
  return `${lines.join("\n")}\n`;
}

function parseArguments(argv) {
  const options = { command: "audit", cwd: process.cwd(), targetRef: "master", registryDir: "", json: false };
  if (argv[0] && !argv[0].startsWith("--")) options.command = argv.shift();
  while (argv.length) {
    const argument = argv.shift();
    if (argument === "--cwd") options.cwd = argv.shift();
    else if (argument === "--target-ref") options.targetRef = argv.shift();
    else if (argument === "--registry-dir") options.registryDir = argv.shift();
    else if (argument === "--json") options.json = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.cwd || !options.targetRef || !["audit", "reconcile"].includes(options.command)) throw new Error("Usage: worktree-registry.mjs [audit|reconcile] [--cwd PATH] [--target-ref REF] [--registry-dir PATH] [--json]");
  return options;
}

export function run(argv = process.argv.slice(2)) {
  const options = parseArguments([...argv]);
  const inspected = inspectRepository(options);
  const registryDir = options.registryDir || path.join(inspected.commonGitDir, REGISTRY_DIRECTORY);
  const eventsPath = path.join(registryDir, "events.jsonl");
  const closurePath = path.join(inspected.commonGitDir, "chief-moa-worktree-archive", "closures.tsv");
  const parsed = parseRegistryEvents(fs.existsSync(eventsPath) ? fs.readFileSync(eventsPath, "utf8") : "");
  const closures = parseClosureLedger(fs.existsSync(closurePath) ? fs.readFileSync(closurePath, "utf8") : "");
  const generatedAt = new Date().toISOString();
  const index = buildRegistryIndex({
    worktrees: inspected.worktrees,
    claims: activeClaims(parsed.events),
    closures,
    warnings: parsed.warnings,
    generatedAt,
    targetRef: options.targetRef,
    targetSha: inspected.targetSha,
  });
  if (options.command === "reconcile") {
    appendEvent(eventsPath, {
      schema_version: SCHEMA_VERSION,
      event_id: crypto.randomUUID(),
      event_type: "worktree.registry.reconciled",
      occurred_at: generatedAt,
      target_ref: options.targetRef,
      target_sha: inspected.targetSha,
      worktree_count: index.summary.total,
      conflict_count: index.summary.blocked,
    });
    atomicWriteJson(path.join(registryDir, "index.json"), index);
  }
  process.stdout.write(options.json ? `${JSON.stringify(index, null, 2)}\n` : renderTable(index));
  return index;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    run();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
