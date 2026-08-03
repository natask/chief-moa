"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const test = require("node:test");

const execFileAsync = promisify(execFile);

test("worker CLI loads project config and discovers workspace-backed harnesses", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-runtime-cli-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const workspaceRoot = path.join(tempDir, "workspace");
  const projectConfigFile = path.join(tempDir, "projects.json");
  fs.writeFileSync(projectConfigFile, JSON.stringify({
    workspace_root: "must-be-overridden",
    projects: [{
      id: "project",
      local_alias: "chief-moa",
      repo_url: "https://example.test/chief-moa.git",
      default_ref: "main",
    }],
  }));

  const claims = [];
  const server = http.createServer((request, response) => {
    let rawBody = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { rawBody += chunk; });
    request.on("end", () => {
      const body = rawBody ? JSON.parse(rawBody) : {};
      if (request.url === "/v1/agent/workers/claim") {
        claims.push(body);
        return sendJson(response, {
          claimed: true,
          claim: { claim_id: "claim_1", attempt: 1 },
          run: {
            id: "run_1",
            harness: "echo",
            prompt: "hello",
            working_dir: { project_id: "project", local_alias: "chief-moa" },
          },
        });
      }
      return sendJson(response, {});
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  const script = path.join(__dirname, "..", "scripts", "worker-runtime.js");
  const { stdout } = await execFileAsync(process.execPath, [
    script,
    "--gateway-url", `http://127.0.0.1:${address.port}`,
    "--worker-id", "worker_1",
    "--token", "token_1",
    "--project-config-file", projectConfigFile,
    "--workspace-root", workspaceRoot,
    "--once",
  ], {
    env: {
      ...process.env,
      CODEX_BIN: process.execPath,
      MOA_WORKER_HARNESSES: "echo,codex",
    },
  });

  assert.deepEqual(claims[0].accepted_harnesses, ["echo", "codex"]);
  assert.deepEqual(claims[0].accepted_projects, ["project"]);
  assert.equal(JSON.parse(stdout.trim().split("\n").at(-1)).processed[0].status, "completed");
});

function sendJson(response, body) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
