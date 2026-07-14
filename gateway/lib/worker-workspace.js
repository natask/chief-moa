"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;
const SAFE_ALIAS = /^[a-z0-9][a-z0-9_.:-]{0,119}$/;

class WorkerWorkspaceError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function loadWorkerProjectConfig(filePath, options = {}) {
  if (!filePath) return { workspace_root: "", projects: [] };
  const configPath = path.resolve(String(filePath));
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new WorkerWorkspaceError("invalid_project_config", `cannot read worker project config: ${error.message}`);
  }
  const rawWorkspaceRoot = String(options.workspaceRoot || parsed.workspace_root || "").trim();
  if (!rawWorkspaceRoot || !path.isAbsolute(rawWorkspaceRoot)) throw new WorkerWorkspaceError("invalid_workspace_root", "workspace_root must be an absolute path");
  const workspaceRoot = path.resolve(rawWorkspaceRoot);
  const rows = Array.isArray(parsed.projects) ? parsed.projects : [];
  if (!rows.length) throw new WorkerWorkspaceError("invalid_project_config", "projects must contain at least one project");
  const seenIds = new Set();
  const seenAliases = new Set();
  const projects = rows.map((row) => {
    const id = exactId(row?.id, "project id");
    const alias = exactAlias(row?.local_alias || row?.alias || id, "project alias");
    if (seenIds.has(id) || seenAliases.has(alias)) throw new WorkerWorkspaceError("duplicate_project", `duplicate project id or alias: ${id}`);
    seenIds.add(id);
    seenAliases.add(alias);
    const relativePath = safeRelative(row?.path || `projects/${alias}`, "project path");
    const repoUrl = String(row?.repo_url || "").trim();
    if (!repoUrl || /[\r\n\0]/.test(repoUrl)) throw new WorkerWorkspaceError("invalid_repo_url", `repo_url is required for ${id}`);
    const defaultRef = String(row?.default_ref || "HEAD").trim();
    if (!defaultRef || defaultRef.startsWith("-") || /[\s\0~^:?*[\\]/.test(defaultRef) || defaultRef.includes("..") || defaultRef.endsWith(".")) {
      throw new WorkerWorkspaceError("invalid_default_ref", `default_ref is invalid for ${id}`);
    }
    return { id, local_alias: alias, repo_url: repoUrl, default_ref: defaultRef, path: relativePath };
  });
  return { workspace_root: workspaceRoot, projects };
}

function createWorkerWorkspace(config, options = {}) {
  const rawWorkspaceRoot = String(config?.workspace_root || "").trim();
  if (!rawWorkspaceRoot || !path.isAbsolute(rawWorkspaceRoot)) throw new WorkerWorkspaceError("invalid_workspace_root", "workspace_root must be an absolute path");
  const configuredRoot = path.resolve(rawWorkspaceRoot);
  const projects = Array.isArray(config?.projects) ? config.projects : [];
  const byId = new Map(projects.map((item) => [item.id, item]));
  const byAlias = new Map(projects.map((item) => [item.local_alias, item]));
  const gitBin = String(options.gitBin || "git");

  function canonicalWorkspaceRoot() {
    fs.mkdirSync(configuredRoot, { recursive: true });
    rejectSymlink(configuredRoot, "workspace_root");
    return fs.realpathSync(configuredRoot);
  }

  function resolveProject(projectId, alias) {
    const exactProjectId = exactId(projectId, "claimed project id");
    const exactLocalAlias = exactAlias(alias, "claimed project alias");
    const project = byId.get(exactProjectId);
    if (!project || byAlias.get(exactLocalAlias) !== project) {
      throw new WorkerWorkspaceError("unknown_project", "claimed project id and alias are not in the worker-local project config");
    }
    return project;
  }

  function prepareRun({ projectId, alias, runId }) {
    const project = resolveProject(projectId, alias);
    const safeRunId = exactId(runId, "run id");
    const workspaceRoot = canonicalWorkspaceRoot();
    const basePath = containedPath(workspaceRoot, project.path, "project path");
    const worktreesRoot = containedPath(workspaceRoot, path.join("worktrees", project.local_alias), "worktrees path");
    ensureParentSafe(workspaceRoot, basePath);
    ensureParentSafe(workspaceRoot, worktreesRoot);

    if (fs.existsSync(basePath)) {
      rejectSymlink(basePath, "project path");
      verifyBase(basePath, workspaceRoot);
    } else {
      fs.mkdirSync(path.dirname(basePath), { recursive: true });
      git(["clone", "--no-checkout", "--", project.repo_url, basePath], `failed to clone project ${project.id}`);
      verifyBase(basePath, workspaceRoot);
    }

    fs.mkdirSync(worktreesRoot, { recursive: true });
    rejectSymlink(worktreesRoot, "worktrees path");
    const workDir = containedPath(workspaceRoot, path.join("worktrees", project.local_alias, safeRunId), "run worktree path");
    if (fs.existsSync(workDir)) {
      rejectSymlink(workDir, "run worktree path");
      verifyWorktree(workDir, basePath, workspaceRoot);
      return { project, base_path: basePath, work_dir: workDir, reused: true };
    }
    git(["-C", basePath, "worktree", "add", "--detach", "--", workDir, project.default_ref], `failed to create worktree for ${safeRunId}`);
    verifyWorktree(workDir, basePath, workspaceRoot);
    return { project, base_path: basePath, work_dir: workDir, reused: false };
  }

  function acquireRunLock({ projectId, alias, runId, claimId, attempt, workerId, machineId }) {
    const project = resolveProject(projectId, alias);
    const safeRunId = exactId(runId, "run id");
    const attemptNumber = Number(attempt);
    if (!Number.isSafeInteger(attemptNumber) || attemptNumber < 1) throw new WorkerWorkspaceError("unsafe_identifier", "claim attempt is invalid");
    const identity = {
      project_id: project.id,
      run_id: safeRunId,
      claim_id: exactId(claimId, "claim id"),
      attempt: attemptNumber,
      worker_id: exactId(workerId, "worker id"),
      machine_id: exactId(machineId, "machine id"),
      pid: process.pid,
      nonce: crypto.randomUUID(),
    };
    const workspaceRoot = canonicalWorkspaceRoot();
    const lockDir = containedPath(workspaceRoot, path.join(".locks", project.local_alias), "run lock path");
    ensureParentSafe(workspaceRoot, lockDir);
    fs.mkdirSync(lockDir, { recursive: true });
    rejectSymlink(lockDir, "run lock path");
    const lockPath = containedPath(workspaceRoot, path.join(".locks", project.local_alias, `${safeRunId}.lock`), "run lock path");
    const reclaimPath = `${lockPath}.reclaim`;
    let fd;
    try {
      fd = openRunLock(lockPath, reclaimPath, identity);
      fs.writeFileSync(fd, `${JSON.stringify(identity)}\n`);
      fs.fsyncSync(fd);
    } catch (error) {
      try { if (fd != null) fs.closeSync(fd); } catch { /* best effort */ }
      throw error;
    }
    fs.closeSync(fd);
    let released = false;
    return {
      path: lockPath,
      identity,
      release() {
        if (released) return;
        const current = JSON.parse(fs.readFileSync(lockPath, "utf8"));
        if (current.nonce !== identity.nonce) throw new WorkerWorkspaceError("lock_ownership_lost", "run lock identity changed before release");
        fs.unlinkSync(lockPath);
        released = true;
      },
    };
  }

  function openRunLock(lockPath, reclaimPath, identity) {
    if (fs.existsSync(reclaimPath)) throw new WorkerWorkspaceError("run_locked", `run ${identity.run_id} lock recovery is active`);
    try {
      return fs.openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    let recoveryHeld = false;
    try {
      fs.mkdirSync(reclaimPath);
      recoveryHeld = true;
    } catch (error) {
      if (error.code === "EEXIST") throw new WorkerWorkspaceError("run_locked", `run ${identity.run_id} already has an active execution lock`);
      throw error;
    }
    try {
      let previous;
      try {
        previous = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      } catch {
        throw new WorkerWorkspaceError("run_locked", `run ${identity.run_id} has an unreadable execution lock`);
      }
      const sameMachine = previous.machine_id === identity.machine_id;
      const previousPid = Number(previous.pid);
      if (!sameMachine || !Number.isSafeInteger(previousPid) || previousPid < 1 || processAlive(previousPid)) {
        throw new WorkerWorkspaceError("run_locked", `run ${identity.run_id} already has an active execution lock`);
      }
      fs.unlinkSync(lockPath);
      return fs.openSync(lockPath, "wx", 0o600);
    } finally {
      if (recoveryHeld) fs.rmdirSync(reclaimPath);
    }
  }

  function verifyBase(basePath, workspaceRoot) {
    const canonicalBase = canonicalContained(workspaceRoot, basePath, "project base");
    if (git(["-C", canonicalBase, "rev-parse", "--is-bare-repository"], "cannot inspect project base") !== "false") {
      throw new WorkerWorkspaceError("git_ownership_escape", "project base must be a non-bare Git worktree");
    }
    const top = canonicalGitPath(canonicalBase, git(["-C", canonicalBase, "rev-parse", "--show-toplevel"], "project base has no worktree"));
    if (top !== canonicalBase) throw new WorkerWorkspaceError("git_ownership_escape", "project base top-level does not match its configured path");
    const gitDir = canonicalGitPath(canonicalBase, git(["-C", canonicalBase, "rev-parse", "--git-dir"], "cannot resolve project git-dir"));
    const commonDir = canonicalGitPath(canonicalBase, git(["-C", canonicalBase, "rev-parse", "--git-common-dir"], "cannot resolve project common-dir"));
    requireContained(canonicalBase, gitDir, "project git-dir");
    requireContained(canonicalBase, commonDir, "project common-dir");
    return { canonicalBase, commonDir };
  }

  function verifyWorktree(workDir, basePath, workspaceRoot) {
    const { canonicalBase, commonDir: baseCommonDir } = verifyBase(basePath, workspaceRoot);
    const canonicalWorkDir = canonicalContained(workspaceRoot, workDir, "run worktree");
    const top = canonicalGitPath(canonicalWorkDir, git(["-C", canonicalWorkDir, "rev-parse", "--show-toplevel"], "run path has no Git worktree"));
    if (top !== canonicalWorkDir) throw new WorkerWorkspaceError("git_ownership_escape", "run worktree top-level does not match its configured path");
    const gitDir = canonicalGitPath(canonicalWorkDir, git(["-C", canonicalWorkDir, "rev-parse", "--git-dir"], "cannot resolve run git-dir"));
    const commonDir = canonicalGitPath(canonicalWorkDir, git(["-C", canonicalWorkDir, "rev-parse", "--git-common-dir"], "cannot resolve run common-dir"));
    requireContained(canonicalBase, gitDir, "run git-dir");
    if (commonDir !== baseCommonDir) throw new WorkerWorkspaceError("git_ownership_escape", "run worktree does not belong to the configured project base");
  }

  function git(args, message) {
    const result = spawnSync(gitBin, args, { encoding: "utf8", shell: false, timeout: 120_000 });
    if (result.error || result.status !== 0) {
      const detail = String(result.stderr || result.error?.message || "git failed").trim().slice(0, 1000);
      throw new WorkerWorkspaceError("git_workspace_failed", `${message}: ${detail}`);
    }
    return String(result.stdout || "").trim();
  }

  return { acquireRunLock, prepareRun, resolveProject, projects: () => projects.map(({ id, local_alias }) => ({ id, local_alias })) };
}

function exactId(value, label) {
  const text = String(value || "").trim();
  if (!SAFE_ID.test(text)) throw new WorkerWorkspaceError("unsafe_identifier", `${label} is invalid`);
  return text;
}

function exactAlias(value, label) {
  const text = String(value || "").trim();
  if (!SAFE_ALIAS.test(text)) throw new WorkerWorkspaceError("unsafe_identifier", `${label} is invalid`);
  return text;
}

function safeRelative(value, label) {
  const text = String(value || "").trim();
  if (!text || path.isAbsolute(text) || text.includes("\0")) throw new WorkerWorkspaceError("unsafe_path", `${label} must be relative`);
  const normalized = path.normalize(text);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) throw new WorkerWorkspaceError("unsafe_path", `${label} escapes workspace_root`);
  return normalized;
}

function containedPath(root, relative, label) {
  const target = path.resolve(root, relative);
  if (target === root || !target.startsWith(`${root}${path.sep}`)) throw new WorkerWorkspaceError("unsafe_path", `${label} escapes workspace_root`);
  return target;
}

function ensureParentSafe(root, target) {
  const relative = path.relative(root, path.dirname(target));
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) fs.mkdirSync(current);
    rejectSymlink(current, "workspace path");
  }
}

function canonicalContained(root, target, label) {
  const canonical = fs.realpathSync(target);
  requireContained(root, canonical, label);
  return canonical;
}

function canonicalGitPath(cwd, value) {
  const resolved = path.isAbsolute(value) ? value : path.resolve(cwd, value);
  return fs.realpathSync(resolved);
}

function requireContained(root, target, label) {
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new WorkerWorkspaceError("git_ownership_escape", `${label} resolves outside its configured project-owned root`);
}

function rejectSymlink(target, label) {
  if (fs.lstatSync(target).isSymbolicLink()) throw new WorkerWorkspaceError("symlink_escape", `${label} must not be a symlink`);
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

module.exports = { WorkerWorkspaceError, createWorkerWorkspace, loadWorkerProjectConfig };
