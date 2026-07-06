"use strict";

const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { describe, test } = require("node:test");

const { SYNTAX_CHECK_FILES } = require("./smoke-manifest");

const gatewayRoot = path.resolve(__dirname, "..");

describe("syntax", { concurrency: true }, () => {
  for (const filePath of SYNTAX_CHECK_FILES) {
    test(filePath, () => {
      const result = spawnSync(process.execPath, ["--check", filePath], {
        cwd: gatewayRoot,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      });

      assert.strictEqual(
        result.status,
        0,
        [
          `node --check ${filePath} exited with status ${result.status}`,
          result.stderr,
        ]
          .filter(Boolean)
          .join("\n")
      );
    });
  }
});
