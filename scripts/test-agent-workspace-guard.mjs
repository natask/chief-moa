#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const guard = path.resolve(path.dirname(new URL(import.meta.url).pathname), "agent-workspace-guard.mjs");
const launcher = path.resolve(path.dirname(guard), "agent-session.sh");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "moa-shared-head-"));
const shared = path.join(root, "chief-moa");
const isolated = path.join(root, "worktrees", "feature");

try {
  run("git", ["init", "-b", "master", shared]);
  fs.writeFileSync(path.join(shared, "README.md"), "fixture\n");
  run("git", ["-C", shared, "add", "README.md"]);
  run("git", ["-C", shared, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture"]);
  const initialHead = git(shared, "rev-parse", "HEAD");

  for (const provider of ["codex", "claude"]) {
    const denied = hook(provider, shared, "PreToolUse", "git switch -c unsafe");
    assert.equal(denied.status, 0);
    assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, "deny");
    assert.equal(git(shared, "symbolic-ref", "--short", "HEAD"), "master");
    assert.equal(git(shared, "rev-parse", "HEAD"), initialHead);
  }

  run("git", ["-C", shared, "worktree", "add", "-b", "feature/safe", isolated, "master"]);
  const allowed = hook("codex", isolated, "PreToolUse", "git switch -c feature/continued");
  assert.equal(allowed.stdout, "");
  run("git", ["-C", isolated, "switch", "-c", "feature/continued"]);
  assert.equal(git(shared, "symbolic-ref", "--short", "HEAD"), "master");
  assert.equal(git(shared, "rev-parse", "HEAD"), initialHead);

  const remoteDenied = hook("claude", isolated, "PreToolUse", `git -C ${shared} checkout feature/safe`);
  assert.equal(JSON.parse(remoteDenied.stdout).decision, "block");

  const launchOk = run("bash", [launcher, "codex", "--check-only"], { cwd: shared });
  assert.equal(launchOk.status, 0);
  run("git", ["-C", shared, "symbolic-ref", "HEAD", "refs/heads/unsafe"]);
  run("git", ["-C", shared, "reset", "--hard", initialHead]);
  const launchDenied = spawnSync("bash", [launcher, "claude", "--check-only"], { cwd: shared, encoding: "utf8" });
  assert.equal(launchDenied.status, 2);
  assert.match(launchDenied.stderr, /refusing agent launch/);
  run("bash", [launcher, "claude", "--allow-shared-branch", "unsafe", "--user-request", "intent_fixture", "--check-only"], { cwd: shared });
  const exception = fs.readFileSync(path.join(shared, ".git", "chief-moa-agent-guard", "shared-checkout-exceptions.jsonl"), "utf8");
  assert.match(exception, /"provider":"claude"/);
  assert.match(exception, /"user_request":"intent_fixture"/);
  const violation = hook("codex", shared, "PostToolUse", "git switch unsafe");
  assert.equal(violation.status, 2);
  assert.match(violation.stderr, /shared checkout violation/);
  run("git", ["-C", shared, "symbolic-ref", "HEAD", "refs/heads/master"]);
  run("git", ["-C", shared, "reset", "--hard", initialHead]);

  assert.equal(git(shared, "symbolic-ref", "--short", "HEAD"), "master");
  assert.equal(git(shared, "rev-parse", "HEAD"), initialHead);
  process.stdout.write("shared checkout guard: Claude Code and Codex kept primary HEAD stable\n");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

function hook(provider, cwd, event, command) {
  return spawnSync(process.execPath, [guard, "hook", "--provider", provider], {
    cwd,
    input: JSON.stringify({ hook_event_name: event, cwd, tool_name: "Bash", tool_input: { command } }),
    encoding: "utf8",
  });
}

function git(cwd, ...args) {
  return run("git", ["-C", cwd, ...args]).stdout.trim();
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
  return result;
}
