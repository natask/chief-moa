"use strict";

const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const gatewayRoot = path.resolve(__dirname, "..");

// `npm run check` sets MOA_SKIP_SLOW=1 to skip this heavy end-to-end run and
// stay near the old check wall-clock; `npm test` runs it. An env gate is used
// instead of --test-skip-pattern because the pattern flag does not reliably
// propagate to the per-file child processes the test runner spawns.
const SKIP_SLOW = process.env.MOA_SKIP_SLOW === "1";

test(
  "regression e2e [slow]",
  { timeout: 300000, skip: SKIP_SLOW },
  () => {
    const dataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "moa-gateway-smoke-regression-")
    );
    // Deterministic e2e over the file/jsonl stores; an inherited DATABASE_URL
    // would flip the gateway into postgres mode and change profile defaults.
    const env = { ...process.env, DATA_DIR: dataDir };
    delete env.DATABASE_URL;
    const result = spawnSync(process.execPath, ["scripts/smoke-regression.js"], {
      cwd: gatewayRoot,
      env,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      timeout: 300000,
    });

    assert.strictEqual(
      result.status,
      0,
      [
        `node scripts/smoke-regression.js exited with status ${result.status}`,
        result.stdout,
        result.stderr,
      ]
        .filter(Boolean)
        .join("\n")
    );
  }
);
