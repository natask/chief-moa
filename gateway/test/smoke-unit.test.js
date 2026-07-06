"use strict";

const assert = require("node:assert");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const { SMOKE_SCRIPTS } = require("./smoke-manifest");

const gatewayRoot = path.resolve(__dirname, "..");

// Concurrency is real here only because we use async `spawn`, not `spawnSync`
// (spawnSync blocks the event loop and would serialize the suite). The smokes
// are I/O/timing-bound (they wait on gateway startup, WS handshakes, timeouts),
// so overlapping a few at a time shortens wall-clock even on low-core CI without
// thrashing the CPU. Each smoke picks its own free port and its own DATA_DIR, so
// running several at once is safe. Keep this modest to stay reliable in CI.
const CONCURRENCY = Number(process.env.MOA_TEST_CONCURRENCY || 4);

function makeDataDir(scriptPath) {
  const prefix = path.join(
    os.tmpdir(),
    `moa-gateway-${path.basename(scriptPath, ".js")}-`
  );
  return fs.mkdtempSync(prefix);
}

function runSmoke(scriptPath) {
  return new Promise((resolve) => {
    const dataDir = makeDataDir(scriptPath);
    // The smokes are deterministic file/jsonl-mode checks; an inherited
    // DATABASE_URL would flip the gateway into postgres mode mid-suite.
    const env = { ...process.env, DATA_DIR: dataDir };
    delete env.DATABASE_URL;
    const child = spawn(process.execPath, [scriptPath], {
      cwd: gatewayRoot,
      env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      resolve({ status: null, stdout, stderr: `${stderr}\n${error.message}` });
    });
    child.on("close", (code) => {
      resolve({ status: code, stdout, stderr });
    });
  });
}

describe("smoke", { concurrency: CONCURRENCY }, () => {
  for (const scriptPath of SMOKE_SCRIPTS) {
    test(scriptPath, { timeout: 120000 }, async () => {
      const result = await runSmoke(scriptPath);
      assert.strictEqual(
        result.status,
        0,
        [
          `node ${scriptPath} exited with status ${result.status}`,
          result.stdout,
          result.stderr,
        ]
          .filter(Boolean)
          .join("\n")
      );
    });
  }
});
