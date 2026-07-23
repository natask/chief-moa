"use strict";

import crypto from "node:crypto";
import {
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export function createLocalRepositoryPublicationInputs({ repository_root: repositoryRoot } = {}) {
  const root = realpathSync(requiredPath(repositoryRoot, "repository_root"));

  async function inspectSource({ source_ref: sourceRef, git_sha: gitSha, tracked_paths: trackedPaths }) {
    let refGitSha = null;
    let commitExists = false;
    try {
      execGit(root, ["cat-file", "-e", `${gitSha}^{commit}`]);
      commitExists = true;
      refGitSha = execGit(root, ["rev-parse", "--verify", `${sourceRef}^{commit}`]).trim();
    } catch {
      return { commit_exists: commitExists, ref_git_sha: refGitSha, tracked_paths_clean: false };
    }
    const normalizedPaths = trackedPaths.map((item) => repositoryRelativePath(root, item));
    let trackedPathsClean = true;
    try {
      execGit(root, ["diff", "--quiet", gitSha, "--", ...normalizedPaths]);
      const status = execGit(root, [
        "status", "--porcelain=v1", "--untracked-files=all", "--", ...normalizedPaths,
      ]).trim();
      trackedPathsClean = status.length === 0;
    } catch {
      trackedPathsClean = false;
    }
    return { commit_exists: commitExists, ref_git_sha: refGitSha, tracked_paths_clean: trackedPathsClean };
  }

  async function inspectArtifact(artifactRef) {
    const file = repositoryFile(root, artifactRef, "artifact_ref");
    const bytes = readFileSync(file);
    return {
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      size_bytes: bytes.byteLength,
    };
  }

  async function loadEvidence(evidenceRef) {
    const file = repositoryFile(root, evidenceRef, "evidence_ref");
    return JSON.parse(readFileSync(file, "utf8"));
  }

  async function loadEvidenceWithDigest(evidenceRef) {
    const document = await loadEvidence(evidenceRef);
    const canonical = canonicalJson(document);
    return Object.freeze({
      document,
      sha256: crypto.createHash("sha256").update(canonical).digest("hex"),
    });
  }

  return Object.freeze({ inspectSource, inspectArtifact, loadEvidence, loadEvidenceWithDigest });
}

function repositoryFile(root, value, field) {
  if (path.isAbsolute(requiredPath(value, field))) {
    throw new Error(`${field} must be repository-relative`);
  }
  const relative = repositoryRelativePath(root, value, field);
  const candidate = path.resolve(root, relative);
  const stat = lstatSync(candidate);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${field} must name a regular repository file`);
  const real = realpathSync(candidate);
  if (!inside(root, real)) throw new Error(`${field} escapes repository_root`);
  return real;
}

function repositoryRelativePath(root, value, field = "tracked_path") {
  const text = requiredPath(value, field);
  const resolved = path.resolve(root, text);
  if (!inside(root, resolved)) throw new Error(`${field} escapes repository_root`);
  return path.relative(root, resolved) || ".";
}

function inside(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function requiredPath(value, field) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw new Error(`${field} is invalid`);
  }
  return value.trim();
}

function execGit(root, args) {
  return execFileSync("git", ["-c", `safe.directory=${root}`, "-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
