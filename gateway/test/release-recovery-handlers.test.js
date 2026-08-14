"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const test = require("node:test");
const {
  createReleaseRecoveryHandlers,
  recoveryManifest,
  verifyArtifact,
} = require("../lib/release-recovery-handlers");

const APK = Buffer.from("signed apk fixture");
const SHA = crypto.createHash("sha256").update(APK).digest("hex");

function candidate(channel, releaseId, overrides = {}) {
  return {
    channel,
    bundle_id: `bundle-${releaseId}`,
    release_id: releaseId,
    compatibility: { eligible: true },
    readiness: { ready: true },
    artifact: {
      surface: "android", sha256: SHA, size_bytes: APK.length,
      version_code: 12, version_name: "1.2.0", git_sha: "a".repeat(40),
    },
    ...overrides,
  };
}

function releaseView(overrides = {}) {
  return {
    application_id: "chief-moa",
    device_id: "phone-1",
    candidates: [candidate("stable", "stable-12"), candidate("preview", "trial-13")],
    effective_assignment: { channel: "preview", bundle_id: "bundle-trial-13" },
    installed: {
      surface: "android", release_id: "trial-13", artifact_sha256: SHA, status: "smoked",
    },
    tenant_id: "must-not-leak",
    feedback_count: 99,
    ...overrides,
  };
}

function harness(view = releaseView(), apkPath = "") {
  const responses = [];
  const handlers = createReleaseRecoveryHandlers({
    recoveryView: async () => ({ status: 200, body: view }),
    resolveArtifactPath: () => apkPath,
    sendJson: (_response, status, body) => responses.push({ status, body }),
    externalOriginForRequest: () => "https://gateway.example.test",
  });
  return { handlers, responses };
}

test("manifest discloses only compatible stable, assigned trial, and installed metadata", () => {
  const result = recoveryManifest(releaseView(), "https://gateway.example.test/");
  assert.deepEqual(Object.keys(result), [
    "schema_version", "application_id", "device_id", "channels", "candidates", "installed",
  ]);
  assert.equal(result.candidates[0].channel, "stable");
  assert.equal(result.candidates[1].channel, "preview");
  assert.equal(result.installed.status, "smoked");
  assert.equal(result.candidates[1].artifact.download_url,
    "https://gateway.example.test/v1/release-recovery/artifacts/trial-13.apk");
  assert.equal(result.candidates[1].artifact.app_id, "ag.companion");
  assert.equal(JSON.stringify(result).includes("must-not-leak"), false);
  assert.equal(JSON.stringify(result).includes("feedback_count"), false);
});

test("manifest suppresses unassigned, incompatible, and non-Android trial artifacts", () => {
  for (const preview of [
    candidate("preview", "other"),
    candidate("preview", "trial-13", { compatibility: { eligible: false } }),
    candidate("preview", "trial-13", { artifact: { surface: "desktop" } }),
  ]) {
    const view = releaseView({ candidates: [candidate("stable", "stable-12"), preview] });
    assert.equal(recoveryManifest(view, "https://gateway.test").channels.preview, null);
  }
});

test("router rejects mutations, forged identities, missing scope, and unknown exact artifacts", async () => {
  const { handlers, responses } = harness();
  assert.equal(await handlers.routeReleaseRecovery(
    { method: "POST" }, {}, new URL("https://gateway.test/v1/release-recovery/manifest"),
  ), true);
  await handlers.routeReleaseRecovery(
    { method: "GET" }, {}, new URL("https://gateway.test/v1/release-recovery/manifest?device_id=other"),
  );
  await handlers.routeReleaseRecovery(
    { method: "GET" }, {}, new URL("https://gateway.test/v1/release-recovery/artifacts/unknown.apk"),
  );
  const denied = createReleaseRecoveryHandlers({
    recoveryView: async () => ({ status: 401, body: { error: "unauthorized" } }),
    resolveArtifactPath: () => "", sendJson: (_r, status, body) => responses.push({ status, body }),
    externalOriginForRequest: () => "https://gateway.test",
  });
  await denied.routeReleaseRecovery(
    { method: "GET" }, {}, new URL("https://gateway.test/v1/release-recovery/manifest"),
  );
  assert.deepEqual(responses.map((item) => item.status), [405, 403, 404, 401]);
});

test("exact artifact GET streams only bytes matching manifest size and SHA", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-recovery-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const apkPath = path.join(dir, "release.apk");
  fs.writeFileSync(apkPath, APK);
  assert.equal(await verifyArtifact(apkPath, { size_bytes: APK.length, sha256: SHA }), true);
  assert.equal(await verifyArtifact(apkPath, { size_bytes: APK.length, sha256: "0".repeat(64) }), false);

  const { handlers } = harness(releaseView(), apkPath);
  const response = new PassThrough();
  const chunks = [];
  response.writeHead = (status, headers) => { response.status = status; response.headers = headers; };
  response.on("data", (chunk) => chunks.push(chunk));
  const finished = new Promise((resolve, reject) => response.on("end", resolve).on("error", reject));
  await handlers.routeReleaseRecovery(
    { method: "GET" }, response,
    new URL("https://gateway.test/v1/release-recovery/artifacts/stable-12.apk"),
  );
  await finished;
  assert.equal(response.status, 200);
  assert.equal(response.headers["content-length"], APK.length);
  assert.deepEqual(Buffer.concat(chunks), APK);
});
