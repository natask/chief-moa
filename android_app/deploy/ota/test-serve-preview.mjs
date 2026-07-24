#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const script = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "serve-preview.mjs",
);
const work = mkdtempSync(path.join("/private/tmp", "moa-preview-test-"));
const candidate = path.join(work, "candidate");
const tokenFile = path.join(work, "token");
const apk = Buffer.from(`test-apk-${randomBytes(16).toString("hex")}`);
const digest = createHash("sha256").update(apk).digest("hex");

await import("node:fs/promises").then(({ mkdir }) =>
  mkdir(candidate, { recursive: true }),
);
writeFileSync(path.join(candidate, "moa-assistant.apk"), apk, { mode: 0o600 });
const manifest = {
  app_id: "ai.moa.assistant",
  version_code: 123,
  version_name: "0.1.123-preview",
  apk: "moa-assistant.apk",
  size_bytes: apk.length,
  sha256: digest,
};
writeFileSync(
  path.join(candidate, "latest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  { mode: 0o600 },
);

const child = spawn(
  process.execPath,
  [
    script,
    "--dir",
    candidate,
    "--host",
    "127.0.0.1",
    "--port",
    "0",
    "--token-file",
    tokenFile,
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);

let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdout += chunk;
});
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

const deadline = Date.now() + 10_000;
let port;
while (!port && Date.now() < deadline) {
  const match = /127\.0\.0\.1:(\d+)/.exec(stdout);
  if (match) {
    port = Number(match[1]);
    break;
  }
  if (child.exitCode !== null) {
    throw new Error(`preview server exited early: ${stderr}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
}
assert.ok(port, "preview server did not report its port");

const token = readFileSync(tokenFile, "utf8").trim();
assert.equal(statSync(tokenFile).mode & 0o777, 0o600);
assert.ok(token.length >= 32);
assert.ok(!stdout.includes(token), "server stdout leaked bearer token");
assert.ok(!stderr.includes(token), "server stderr leaked bearer token");

const fetchPreview = (pathname, authorization, method = "GET") =>
  new Promise((resolve, reject) => {
    const headers = authorization ? { Authorization: authorization } : {};
    const req = request(
      { host: "127.0.0.1", port, path: pathname, method, headers },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            body: Buffer.concat(chunks),
            headers: response.headers,
            status: response.statusCode,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });

try {
  const unauthorized = await fetchPreview("/latest.json");
  assert.equal(unauthorized.status, 401);
  assert.match(unauthorized.headers["www-authenticate"], /^Bearer /);
  assert.equal(unauthorized.headers["cache-control"], "no-store");
  assert.equal(unauthorized.headers["referrer-policy"], "no-referrer");

  const wrongToken = await fetchPreview("/moa-assistant.apk", "Bearer incorrect");
  assert.equal(wrongToken.status, 401);

  const authorization = `Bearer ${token}`;
  const fetchedManifest = await fetchPreview("/latest.json", authorization);
  assert.equal(fetchedManifest.status, 200);
  assert.deepEqual(JSON.parse(fetchedManifest.body), manifest);
  assert.equal(fetchedManifest.headers["cache-control"], "no-store");
  assert.equal(fetchedManifest.headers["referrer-policy"], "no-referrer");

  const fetchedApk = await fetchPreview("/moa-assistant.apk", authorization);
  assert.equal(fetchedApk.status, 200);
  assert.deepEqual(fetchedApk.body, apk);
  assert.equal(
    fetchedApk.headers["content-type"],
    "application/vnd.android.package-archive",
  );

  const head = await fetchPreview("/moa-assistant.apk", authorization, "HEAD");
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  assert.equal(Number(head.headers["content-length"]), apk.length);

  const capability = `token=${encodeURIComponent(token)}`;
  const capabilityManifest = await fetchPreview(`/latest.json?${capability}`);
  assert.equal(capabilityManifest.status, 200);
  assert.deepEqual(JSON.parse(capabilityManifest.body), manifest);
  assert.equal(capabilityManifest.headers["cache-control"], "no-store");
  assert.equal(capabilityManifest.headers["referrer-policy"], "no-referrer");

  const capabilityApk = await fetchPreview(`/moa-assistant.apk?${capability}`);
  assert.equal(capabilityApk.status, 200);
  assert.deepEqual(capabilityApk.body, apk);

  const capabilityHead = await fetchPreview(
    `/moa-assistant.apk?${capability}`,
    null,
    "HEAD",
  );
  assert.equal(capabilityHead.status, 200);
  assert.equal(capabilityHead.body.length, 0);

  const duplicateCapability = await fetchPreview(
    `/latest.json?${capability}&${capability}`,
  );
  assert.equal(duplicateCapability.status, 401);

  const capabilityPost = await fetchPreview(
    `/latest.json?${capability}`,
    null,
    "POST",
  );
  assert.equal(capabilityPost.status, 401);

  const hidden = await fetchPreview("/anything-else", authorization);
  assert.equal(hidden.status, 404);

  const method = await fetchPreview("/latest.json", authorization, "POST");
  assert.equal(method.status, 405);
} finally {
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
  rmSync(work, { recursive: true, force: true });
}

console.log("Android preview server authentication smoke passed.");
