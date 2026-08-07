import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const repo = resolve(root, "..");
const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("package requires an exact Git candidate");
const dirty = execFileSync("git", ["status", "--porcelain", "--", "windows_app", ".github/workflows/windows-surface-shell.yml", "ARCHITECTURE.md", "reference/openspec/changes/voice-capture-notebook-ime"], { cwd: repo, encoding: "utf8" }).trim();
if (dirty) throw new Error("package refuses dirty Windows candidate inputs");
const rustLibrary = join(root, "core", "target", "x86_64-pc-windows-msvc", "debug", "libmoa_windows_surface_core.rlib");
readFileSync(rustLibrary);

const staging = mkdtempSync(join(tmpdir(), "ag-windows-dictation-"));
const bundle = join(staging, "Ag-Windows-Dictation-QA");
mkdirSync(bundle, { recursive: true });
const sourceFilter = (path) => !["bin", "obj", "dist"].includes(basename(path));
for (const path of ["Aggie.Windows", "Aggie.Windows.Tests", "docs", "README.md"])
  cpSync(join(root, path), join(bundle, path), { recursive: true, filter: sourceFilter });
mkdirSync(join(bundle, "portable-core"), { recursive: true });
cpSync(join(root, "core", "Cargo.toml"), join(bundle, "portable-core", "Cargo.toml"));
cpSync(join(root, "core", "Cargo.lock"), join(bundle, "portable-core", "Cargo.lock"));
cpSync(rustLibrary, join(bundle, "portable-core", basename(rustLibrary)));
writeFileSync(join(bundle, "ARTIFACT.json"), JSON.stringify({
  kind: "windows_literal_dictation_source_qa",
  git_sha: sha,
  installed: false,
  signed: false,
  winui_binary_included: false,
  portable_windows_core_included: true,
  required_native_gate: "Windows-hosted test, WinUI build, microphone/clipboard QA, MSIX and signing",
}, null, 2) + "\n");

const dist = join(root, "dist");
mkdirSync(dist, { recursive: true });
const archive = join(dist, `Ag-Windows-Dictation-QA-${sha.slice(0, 12)}.zip`);
rmSync(archive, { force: true });
execFileSync("zip", ["-X", "-q", "-r", archive, basename(bundle)], { cwd: staging });
const bytes = readFileSync(archive);
const digest = createHash("sha256").update(bytes).digest("hex");
writeFileSync(`${archive}.sha256`, `${digest}  ${basename(archive)}\n`);
rmSync(staging, { recursive: true, force: true });
console.log(`Windows dictation QA source artifact: ${archive}`);
console.log(`SHA-256: ${digest}`);
console.log("This artifact is not a WinUI binary, signed package, installation, or physical-Windows proof.");
