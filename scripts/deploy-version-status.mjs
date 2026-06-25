#!/usr/bin/env node
"use strict";

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function currentVersion(target) {
  if (target === "gateway") {
    const pkg = readJson(join(ROOT_DIR, "gateway", "package.json")) || {};
    return {
      version: String(pkg.version || ""),
      source: "gateway/package.json",
      label: `package=${pkg.version || "unknown"}`,
    };
  }
  if (target === "extension") {
    const manifest = readJson(join(ROOT_DIR, "browser_extension", "extension", "manifest.json")) || {};
    return {
      version: String(manifest.version || ""),
      source: "browser_extension/extension/manifest.json",
      label: `manifest=${manifest.version || "unknown"}`,
    };
  }
  if (target === "android") {
    const latest = readJson(join(ROOT_DIR, "gateway", "data", "android-ota", "latest.json"));
    if (latest) {
      return {
        version: String(latest.version_name || latest.version_code || ""),
        version_name: String(latest.version_name || ""),
        version_code: Number(latest.version_code || 0) || null,
        source: "gateway/data/android-ota/latest.json",
        label: `ota=${latest.version_name || "unknown"} versionCode=${latest.version_code || "unknown"}`,
      };
    }
    return {
      version: "",
      version_name: "",
      version_code: null,
      source: "android_app/app/build.gradle",
      label: "ota=pending; build script generates timestamp versionCode on deploy",
    };
  }
  throw new Error(`unknown target: ${target}`);
}

function statePath(stateDir, target) {
  return join(stateDir, `${target}.json`);
}

function describe(target) {
  const current = currentVersion(target);
  return `${target}: ${current.label} source=${current.source}`;
}

function mark(stateDir, target, gitSha) {
  mkdirSync(stateDir, { recursive: true });
  const current = currentVersion(target);
  const existing = readJson(statePath(stateDir, target)) || {};
  const sequence = Math.max(0, Number(existing.sequence || 0)) + 1;
  const payload = {
    target,
    sequence,
    deployed_at: new Date().toISOString(),
    git_sha: String(gitSha || ""),
    ...current,
  };
  const targetPath = statePath(stateDir, target);
  const tmpPath = `${targetPath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`);
  renameSync(tmpPath, targetPath);
  console.log(`${target}: recorded deploy #${sequence} ${current.label} git=${String(gitSha || "").slice(0, 12) || "unknown"}`);
}

function assertExtensionBumped(stateDir) {
  const previous = readJson(statePath(stateDir, "extension"));
  if (!previous || !previous.version) {
    return;
  }
  const current = currentVersion("extension");
  if (current.version && current.version === previous.version) {
    console.error(
      `extension: manifest version ${current.version} has not changed since deploy #${previous.sequence}. ` +
      "Bump browser_extension/extension/manifest.json before publishing changed extension code.",
    );
    process.exit(1);
  }
}

function show(stateDir) {
  for (const target of ["gateway", "android", "extension"]) {
    const current = currentVersion(target);
    const previous = existsSync(statePath(stateDir, target)) ? readJson(statePath(stateDir, target)) : null;
    const deployed = previous
      ? `last_deploy=#${previous.sequence} ${previous.version || previous.version_name || "unknown"} git=${String(previous.git_sha || "").slice(0, 12)}`
      : "last_deploy=unknown";
    console.log(`${target}: ${current.label}; ${deployed}`);
  }
}

const [command, ...args] = process.argv.slice(2);

try {
  if (command === "current") {
    const target = args[0];
    if (target === "all") {
      for (const item of ["gateway", "android", "extension"]) {
        console.log(describe(item));
      }
    } else {
      console.log(describe(target));
    }
  } else if (command === "mark") {
    mark(args[0], args[1], args[2]);
  } else if (command === "assert-extension-bumped") {
    assertExtensionBumped(args[0]);
  } else if (command === "show") {
    show(args[0]);
  } else {
    console.error("usage: deploy-version-status.mjs current <target|all> | mark <state-dir> <target> <git-sha> | assert-extension-bumped <state-dir> | show <state-dir>");
    process.exit(2);
  }
} catch (error) {
  console.error(error.message || String(error));
  process.exit(1);
}
