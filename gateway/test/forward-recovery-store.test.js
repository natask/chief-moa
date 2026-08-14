"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createFileForwardRecoveryStore } = require("../lib/forward-recovery-store");

test("scans only bounded immutable receipts and verifies exact APK bytes", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moa-forward-store-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const id = "ag.companion-recovery-31-111111111111";
  const dir = path.join(root, "releases", id);
  const apk = Buffer.from("forward recovery apk");
  const receipt = {
    recovery_release_id: id,
    artifact: {
      sha256: crypto.createHash("sha256").update(apk).digest("hex"),
      size_bytes: apk.length,
      app_id: "ag.companion",
      version_code: 31,
      signer_sha256: "b".repeat(64),
    },
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "moa-assistant.apk"), apk);
  fs.writeFileSync(path.join(dir, "recovery.json"), JSON.stringify(receipt));
  fs.mkdirSync(path.join(root, "releases", "wrong-id"));
  fs.writeFileSync(path.join(root, "releases", "wrong-id", "recovery.json"), JSON.stringify(receipt));

  const store = createFileForwardRecoveryStore({ root });
  assert.deepEqual(await store.listReceipts(), [receipt]);
  assert.deepEqual(await store.inspectArtifact(receipt), {
    available: true,
    sha256: receipt.artifact.sha256,
    size_bytes: apk.length,
    app_id: "ag.companion",
    version_code: 31,
    signer_sha256: "b".repeat(64),
  });
  fs.appendFileSync(path.join(dir, "moa-assistant.apk"), "tampered");
  assert.deepEqual(await store.inspectArtifact(receipt), { available: false });
  assert.equal(store.artifactPath("../escape"), "");
});
