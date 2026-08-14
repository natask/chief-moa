"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const test = require("node:test");
const { provenanceDigest } = require("../lib/forward-recovery-manifest");
const { createFileForwardRecoveryStore } = require("../lib/forward-recovery-store");
const { createReleaseRecoveryHandlers } = require("../lib/release-recovery-handlers");

const SOURCE = "1".repeat(40);
const RUNNING_SOURCE = "2".repeat(40);
const STABLE_SHA = "a".repeat(64);
const RUNNING_SHA = "b".repeat(64);
const SIGNER = "c".repeat(64);

function view() {
  return {
    application_id: "chief-moa",
    device_id: "phone-1",
    candidates: [
      {
        channel: "stable", sequence: 12, bundle_id: "stable-12", release_id: "stable-release-12",
        source_ref: SOURCE, compatibility: { eligible: true }, readiness: { ready: true },
        artifact: {
          surface: "android", sha256: STABLE_SHA, size_bytes: 100,
          app_id: "ag.companion", version_code: 12, version_name: "1.2.0", git_sha: SOURCE,
        },
      },
      {
        channel: "preview", sequence: 30, bundle_id: "trial-30", release_id: "trial-release-30",
        source_ref: RUNNING_SOURCE, compatibility: { eligible: true }, readiness: { ready: true },
        artifact: {
          surface: "android", sha256: RUNNING_SHA, size_bytes: 200,
          app_id: "ag.companion", version_code: 30, version_name: "1.3.0", git_sha: RUNNING_SOURCE,
        },
      },
    ],
    effective_assignment: {
      channel: "preview", bundle_id: "trial-30", release_id: "trial-release-30",
    },
    installed: {
      surface: "android", release_id: "trial-release-30", artifact_sha256: RUNNING_SHA,
      app_id: "ag.companion", version_code: 30, version_name: "1.3.0",
      git_sha: RUNNING_SOURCE, status: "smoked",
    },
  };
}

function receipt(apk) {
  const value = {
    schema_version: 1,
    kind: "android_forward_recovery",
    recovery_release_id: "ag.companion-recovery-31-111111111111",
    source_commit: SOURCE,
    builder_commit: "3".repeat(40),
    built_at: "2026-08-14T17:00:00Z",
    download_path: "/v1/release-recovery/artifacts/ag.companion-recovery-31-111111111111.apk",
    artifact: {
      apk: "moa-assistant.apk", app_id: "ag.companion", version_code: 31,
      version_name: "0.1.31-recovery",
      sha256: crypto.createHash("sha256").update(apk).digest("hex"),
      size_bytes: apk.length, signer_sha256: SIGNER,
    },
    target_predecessor: {
      channel: "stable", bundle_id: "stable-12", release_id: "stable-release-12",
      sequence: 12, artifact_sha256: STABLE_SHA, artifact_version_code: 12,
    },
    replaces: {
      bundle_id: "trial-30", release_id: "trial-release-30", source_commit: RUNNING_SOURCE,
      artifact_sha256: RUNNING_SHA, artifact_version_code: 30,
    },
    parent_stable: { bundle_id: "stable-12", release_id: "stable-release-12", sequence: 12 },
    parent_trial: { bundle_id: "trial-30", release_id: "trial-release-30", sequence: 30 },
  };
  return { ...value, provenance_sha256: provenanceDigest(value) };
}

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moa-forward-handler-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const apk = Buffer.from("continuity signed recovery apk");
  const value = receipt(apk);
  const dir = path.join(root, "releases", value.recovery_release_id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "moa-assistant.apk"), apk);
  fs.writeFileSync(path.join(dir, "recovery.json"), JSON.stringify(value));
  const responses = [];
  const releaseView = view();
  const handlers = createReleaseRecoveryHandlers({
    recoveryView: async () => ({ status: 200, body: releaseView }),
    resolveArtifactPath: () => "",
    recoveryStore: createFileForwardRecoveryStore({ root }),
    sendJson: (_response, status, body) => responses.push({ status, body }),
    externalOriginForRequest: () => "https://gateway.example.test",
  });
  return { apk, handlers, releaseView, responses, root, value };
}

test("manifest recommends only the exact available current Stable recovery", async (t) => {
  const { handlers, responses, value } = setup(t);
  await handlers.routeReleaseRecovery(
    { method: "GET" }, {}, new URL("https://gateway.test/v1/release-recovery/manifest"),
  );
  assert.equal(responses[0].status, 200);
  const manifest = responses[0].body;
  assert.equal(manifest.channels.stable.sequence, 12);
  assert.equal(manifest.recoveries.length, 1);
  assert.equal(manifest.recommended_recovery_id, value.recovery_release_id);
  assert.equal(manifest.recoveries[0].target.sequence, 12);
  assert.equal(manifest.recoveries[0].predecessor.version_code, 30);
  assert.equal(manifest.recoveries[0].artifact.signer_sha256, SIGNER);
});

test("manifest suppresses stale and unavailable forward recoveries", async (t) => {
  const stale = setup(t);
  stale.releaseView.candidates[0].sequence = 13;
  await stale.handlers.routeReleaseRecovery(
    { method: "GET" }, {}, new URL("https://gateway.test/v1/release-recovery/manifest"),
  );
  assert.deepEqual(stale.responses[0].body.recoveries, []);
  assert.equal(stale.responses[0].body.recommended_recovery_id, null);

  const missing = setup(t);
  fs.unlinkSync(path.join(
    missing.root, "releases", missing.value.recovery_release_id, "moa-assistant.apk",
  ));
  await missing.handlers.routeReleaseRecovery(
    { method: "GET" }, {}, new URL("https://gateway.test/v1/release-recovery/manifest"),
  );
  assert.deepEqual(missing.responses[0].body.recoveries, []);
  assert.equal(missing.responses[0].body.recommended_recovery_id, null);
});

test("exact forward recovery artifact route streams only verified bytes", async (t) => {
  const { apk, handlers, value } = setup(t);
  const response = new PassThrough();
  const chunks = [];
  response.writeHead = (status, headers) => { response.status = status; response.headers = headers; };
  response.on("data", (chunk) => chunks.push(chunk));
  const finished = new Promise((resolve, reject) => response.on("end", resolve).on("error", reject));
  await handlers.routeReleaseRecovery(
    { method: "GET" }, response,
    new URL(`https://gateway.test/v1/release-recovery/artifacts/${value.recovery_release_id}.apk`),
  );
  await finished;
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.concat(chunks), apk);
});
