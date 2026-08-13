import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");

const removedRunnerReleaseFiles = [
  ".github/scripts/assert-deploy-vps-contract.rb",
  ".github/workflows/android-ota-vps.yml",
  ".github/workflows/browser-extension-release.yml",
  ".github/workflows/deploy-vps.yml",
  ".github/workflows/macos-qa-artifact.yml",
  ".github/workflows/release-evidence.yml",
  ".github/workflows/vps-operations.yml",
];

test("normal local release has no GitHub runner or remote publication entrypoint", () => {
  for (const name of removedRunnerReleaseFiles) {
    assert.equal(fs.existsSync(path.join(root, name)), false, name);
  }

  const localRelease = read("scripts/release/local-release.sh");
  assert.doesNotMatch(localRelease, /\bgh\s+(?:pr|workflow|run)\b/);
  assert.doesNotMatch(localRelease, /\bssh\b|\brsync\b|deploy:browser/);
  assert.match(localRelease, /shasum -a 256/);
  assert.match(localRelease, /chief-moa-local-release\/v1/);
  assert.match(localRelease, /remote_effects: false/);
});

test("active effects require an explicit flag and configured target identity", () => {
  const deploy = read("scripts/deploy.sh");
  const gatewayPush = read("scripts/vps/push.sh");
  const otaPush = read("android_app/deploy/ota/sync-vps.sh");
  const targets = JSON.parse(read("scripts/deploy-targets.json"));
  assert.equal(targets.production.identity, "chief-moa-production");
  assert.match(deploy, /--direct-deploy/);
  assert.match(deploy, /EXPECTED_TARGET/);
  assert.match(deploy, /target identity mismatch/);
  assert.match(deploy, /require_direct_target/);
  for (const publisher of [gatewayPush, otaPush]) {
    assert.match(publisher, /--direct-deploy/);
    assert.match(publisher, /EXPECTED_TARGET/);
    assert.match(publisher, /configured|CANONICAL_IDENTITY/);
  }
});

test("master integration uses local gates without PR or Actions commands", () => {
  const pushMaster = read("scripts/release/push-master.sh");
  assert.match(pushMaster, /--direct-push/);
  assert.match(pushMaster, /local-release\.sh/);
  assert.doesNotMatch(pushMaster, /\bgh\s|workflow_dispatch|actions\//);
  assert.match(pushMaster, /git push origin "\$candidate:refs\/heads\/master"/);
  assert.match(pushMaster, /cargo clippy --all-targets -- -D warnings/);
  assert.match(pushMaster, /verify-dictation-source\.mjs/);
});
