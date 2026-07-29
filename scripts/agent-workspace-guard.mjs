#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const REQUIRED_SHARED_BRANCH = "master";

function git(cwd, ...args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || "git failed").trim());
  return result.stdout.trim();
}

function real(value) {
  return fs.realpathSync(path.resolve(value));
}

function workspace(cwd) {
  const top = real(git(cwd, "rev-parse", "--show-toplevel"));
  const common = real(git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"));
  const primary = path.basename(common) === ".git" ? real(path.dirname(common)) : top;
  const branchResult = spawnSync("git", ["-C", top, "symbolic-ref", "--quiet", "--short", "HEAD"], { encoding: "utf8" });
  const branch = branchResult.status === 0 ? branchResult.stdout.trim() : "HEAD";
  return { top, primary, common, branch, isPrimary: top === primary };
}

function hookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

function denial(reason) {
  process.stdout.write(`${JSON.stringify({
    decision: "block",
    reason,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  })}\n`);
}

function context(event, message) {
  process.stdout.write(`${JSON.stringify({
    systemMessage: message,
    hookSpecificOutput: { hookEventName: event, additionalContext: message },
  })}\n`);
}

function targetsPrimary(command, state, cwd) {
  if (state.isPrimary) return true;
  const normalized = command.replaceAll("\\", "/");
  const primary = state.primary.replaceAll("\\", "/");
  if (normalized.includes(primary)) return true;
  for (const match of command.matchAll(/(?:^|\s)-C\s+(?:"([^"]+)"|'([^']+)'|(\S+))/g)) {
    const candidate = match[1] || match[2] || match[3];
    try {
      if (real(path.resolve(cwd, candidate)) === state.primary) return true;
    } catch {
      // Git will report an invalid target; it cannot mutate the primary checkout.
    }
  }
  return real(cwd) === state.primary;
}

function changesCheckout(command) {
  const gitCommand = /(?:^|[;&|()\n]\s*|\b(?:sudo|env|command)\s+)git\s+(?:(?:-C|--git-dir|--work-tree)\s+(?:"[^"]*"|'[^']*'|\S+)\s+)*(?:--no-pager\s+)?(switch|checkout)\b/m;
  const directHead = /\bgit\s+(?:(?:-C|--git-dir|--work-tree)\s+(?:"[^"]*"|'[^']*'|\S+)\s+)*(?:symbolic-ref\s+HEAD|update-ref\s+HEAD)\b/m;
  return gitCommand.test(command) || directHead.test(command);
}

function assertSharedState(state, event = "PostToolUse") {
  const sharedBranch = git(state.primary, "symbolic-ref", "--quiet", "--short", "HEAD");
  if (sharedBranch === REQUIRED_SHARED_BRANCH) return true;
  const reason = `ChiefMoa shared checkout violation: ${state.primary} is on ${sharedBranch}, expected ${REQUIRED_SHARED_BRANCH}. Use an isolated git worktree for branch work.`;
  if (event === "PostToolUse") {
    process.stderr.write(`${reason}\n`);
    process.exitCode = 2;
  } else {
    context(event, reason);
  }
  return false;
}

function runHook(provider) {
  const input = hookInput();
  const event = input.hook_event_name || input.hookEventName || "SessionStart";
  const cwd = input.cwd || process.cwd();
  let state;
  try {
    state = workspace(cwd);
  } catch {
    return;
  }
  if (event === "PreToolUse") {
    const command = String(input.tool_input?.command || "");
    if (changesCheckout(command) && targetsPrimary(command, state, cwd)) {
      denial(`Blocked ${provider} from changing the ChiefMoa shared checkout. Create or use an isolated worktree; only a user-recorded launcher override may change the shared branch.`);
    }
    return;
  }
  assertSharedState(state, event);
}

function runLaunch(args) {
  const cwd = option(args, "--cwd") || process.cwd();
  const allowedBranch = option(args, "--allow-shared-branch");
  const userRequest = option(args, "--user-request");
  const state = workspace(cwd);
  if (!state.isPrimary) return;
  if (state.branch === REQUIRED_SHARED_BRANCH) return;
  if (allowedBranch === state.branch && userRequest) {
    const evidenceDir = path.join(state.common, "chief-moa-agent-guard");
    fs.mkdirSync(evidenceDir, { recursive: true });
    fs.appendFileSync(path.join(evidenceDir, "shared-checkout-exceptions.jsonl"), `${JSON.stringify({
      timestamp: new Date().toISOString(),
      provider: option(args, "--provider") || "agent",
      shared_checkout: state.primary,
      branch: state.branch,
      user_request: userRequest,
    })}\n`, { mode: 0o600 });
    return;
  }
  throw new Error(`refusing agent launch in shared checkout on ${state.branch}; expected ${REQUIRED_SHARED_BRANCH}. Start in an isolated worktree, or pass both --allow-shared-branch ${state.branch} and --user-request <citation> when the user explicitly requested this shared branch.`);
}

function option(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? "" : String(args[index + 1] || "");
}

function main() {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === "hook") return runHook(option(args, "--provider") || "agent");
  if (mode === "launch") return runLaunch(args);
  if (mode === "status") {
    const state = workspace(option(args, "--cwd") || process.cwd());
    process.stdout.write(`${JSON.stringify({ ...state, required_shared_branch: REQUIRED_SHARED_BRANCH })}\n`);
    return;
  }
  throw new Error("usage: agent-workspace-guard.mjs hook|launch|status");
}

try {
  main();
} catch (error) {
  process.stderr.write(`agent workspace guard: ${error.message}\n`);
  process.exitCode = 2;
}
