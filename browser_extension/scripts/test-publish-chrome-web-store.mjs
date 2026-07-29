import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const scriptPath = resolve(new URL("publish-chrome-web-store.mjs", import.meta.url).pathname);
const workflowSha = "0123456789abcdef0123456789abcdef01234567";

function runPublisher(evidence) {
  const directory = mkdtempSync(join(tmpdir(), "chrome-release-evidence-"));
  const packagePath = join(directory, "Ag-1.2.3.zip");
  const evidencePath = join(directory, "evidence.json");
  writeFileSync(packagePath, "verified package bytes");
  writeFileSync(evidencePath, `${JSON.stringify(evidence)}\n`);
  const result = spawnSync(process.execPath, [
    scriptPath,
    "--package", packagePath,
    "--version", "1.2.3",
    "--evidence", evidencePath,
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      CWS_ACCESS_TOKEN: "test-token",
      CWS_PUBLISHER_ID: "test-publisher",
      CWS_EXTENSION_ID: "abcdefghijklmnopabcdefghijklmnop",
      GITHUB_SHA: workflowSha,
    },
  });
  rmSync(directory, { recursive: true, force: true });
  return result;
}

test("Chrome Web Store publication rejects evidence for another commit before upload", () => {
  const result = runPublisher({
    schema_version: "chrome-web-store-release-evidence/v1",
    expected_version: "1.2.3",
    git_sha: "89abcdef0123456789abcdef0123456789abcdef",
    source_tree_sha: "abcdef0123456789abcdef0123456789abcdef01",
    package: { sha256: "irrelevant", size_bytes: 22 },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not match the exact workflow commit/);
  assert.doesNotMatch(result.stderr, /test-token/);
});

