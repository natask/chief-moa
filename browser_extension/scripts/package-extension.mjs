// agee package — build a Chrome Web Store upload zip from extension/.
//
// Manifest V3 requires every file in the package to be a static asset. This
// script only includes the extension/ tree, so the produced zip is exactly what
// Chrome Web Store expects. It ignores developer-only files (demo fixtures,
// scripts, docs, node_modules, the baked local dev config, etc.) and leaves the
// user's .git/agee.config.json untouched.
//
// Usage:
//   npm run package
//
// Output:
//   dist/agee-<version>.zip

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const extensionDir = join(root, "extension");
const outDir = join(root, "dist");

const IGNORE_NAMES = new Set([
  ".DS_Store",
  "agee.config.json",
  "__LOG__.md",
  ".context",
  ".gstack",
  ".git",
  ".gitignore",
  "node_modules",
]);

const IGNORE_PATTERNS = [
  /^\./,
  /\.map$/,
  /\.example\.json$/,
];

function shouldIgnore(name) {
  return IGNORE_NAMES.has(name) || IGNORE_PATTERNS.some((p) => p.test(name));
}

async function collectFiles(dir) {
  const files = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (shouldIgnore(entry.name)) continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await collectFiles(fullPath);
      files.push(...nested);
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

async function main() {
  if (!existsSync(extensionDir)) {
    console.error("agee package: extension/ directory not found");
    process.exit(1);
  }

  const manifest = JSON.parse(readFileSync(join(extensionDir, "manifest.json"), "utf8"));
  const version = manifest.version || "0.0.0";
  const name = manifest.name || "agee";

  const files = await collectFiles(extensionDir);
  if (files.length === 0) {
    console.error("agee package: no files found in extension/");
    process.exit(1);
  }

  await mkdir(outDir, { recursive: true });
  const outPath = join(outDir, `${name}-${version}.zip`);

  // Use the system zip command (available on macOS and Linux). We list every
  // file explicitly so the archive root is the extension directory.
  const relativeFiles = files.map((f) => f.slice(extensionDir.length + 1));
  execFileSync("zip", ["-X", "-o", outPath, ...relativeFiles], {
    cwd: extensionDir,
    stdio: ["ignore", "ignore", "pipe"],
  });

  const { size } = await stat(outPath);
  console.log(`agee package: ${outPath}`);
  console.log(`  version: ${version}`);
  console.log(`  files:   ${files.length}`);
  console.log(`  size:    ${size} bytes`);
  console.log("");
  console.log("Next: upload this zip to Chrome Web Store (Developer Dashboard ->");
  console.log("      Package -> Upload new package). The version above must be");
  console.log("      higher than the currently published version for the store to");
  console.log("      accept it.");
}

main().catch((error) => {
  console.error(`agee package failed: ${error.message}`);
  process.exit(1);
});
