"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { digest } = require("../lib/companion-package");
const {
  createRuntimeConfigBundleStore,
  signRuntimeBundle,
} = require("../lib/runtime-config-bundles");

const keys = crypto.generateKeyPairSync("ed25519");

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-runtime-bundle-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function signedBundle(id, sequence, patch = { model: "gpt-realtime-2" }, overrides = {}) {
  return signRuntimeBundle({
    schema: "ag.runtime-config-bundle.v1",
    bundle_id: id,
    version: `1.0.${sequence}`,
    sequence,
    channel: "stable",
    created_at: `2026-08-07T00:00:0${sequence}.000Z`,
    compatibility: {
      protocol: "ag.android.runtime",
      min_version: "1.0.0",
      max_version: "1.9.9",
    },
    provenance: {
      source_uri: `urn:ag:runtime:${id}`,
      source_digest: digest(`source:${id}`),
      author: "Automated release test",
      git_sha: "abcdef1234567",
    },
    payload: {
      profile_patch: patch,
      capabilities: ["provider.routing", "response.policy"],
    },
    health: { required_checks: ["profile_projection"] },
    ...overrides,
  }, { keyId: "release-key-1", privateKey: keys.privateKey });
}

function harness(t, overrides = {}) {
  let versionNumber = 1;
  let version = "profile-v1";
  let profile = { model: "base", temperature: 0.8 };
  const snapshots = new Map([[version, { ...profile }]]);
  const rollbacks = [];
  const applyProfile = (patch) => {
    profile = { ...profile, ...patch };
    version = `profile-v${++versionNumber}`;
    snapshots.set(version, { ...profile });
    return { before_profile_version: `profile-v${versionNumber - 1}`, after_profile_version: version };
  };
  const rollbackProfile = (target) => {
    rollbacks.push(target);
    profile = { ...snapshots.get(target) };
    version = `profile-v${++versionNumber}`;
    snapshots.set(version, { ...profile });
  };
  const store = createRuntimeConfigBundleStore({
    dataDir: tempDir(t),
    trustStore: new Map([["release-key-1", keys.publicKey]]),
    currentProfileVersion: () => version,
    applyProfile,
    rollbackProfile,
    healthCheck: () => ({ ok: true, checks: ["profile_projection"] }),
    now: (() => {
      let tick = 0;
      return () => `2026-08-07T01:00:${String(tick++).padStart(2, "0")}.000Z`;
    })(),
    ...overrides,
  });
  return { store, rollbacks, profile: () => ({ ...profile }), version: () => version };
}

test("invalid and tampered bundles fail closed without staging", (t) => {
  const { store } = harness(t);
  const tampered = signedBundle("bundle-invalid", 1);
  tampered.payload.profile_patch.model = "tampered";
  assert.throws(() => store.publish(tampered), (error) => error?.code === "invalid_signature");
  assert.equal(store.list().length, 0);

  const forbidden = signedBundle("bundle-secret", 2, { api_key: "must-not-cross-boundary" });
  assert.throws(() => store.publish(forbidden), (error) => error?.code === "forbidden_profile_field");
  assert.equal(store.runtime().state, "base");
});

test("bundle incompatible with the stable shell is rejected before staging", (t) => {
  const { store } = harness(t);
  const incompatible = signedBundle("bundle-future", 1, { model: "future" }, {
    compatibility: {
      protocol: "ag.android.runtime",
      min_version: "2.0.0",
      max_version: "2.9.9",
    },
  });
  assert.throws(() => store.publish(incompatible), (error) => error?.code === "incompatible_shell");
  assert.deepEqual(store.list(), []);
});

test("signed bundle stages atomically then activates only after health passes", (t) => {
  const { store, profile } = harness(t);
  const staged = store.publish(signedBundle("bundle-good", 1));
  assert.equal(staged.status, "staged");
  assert.equal(store.runtime().state, "base");

  const active = store.activate(staged.id, { approval: { actor: "release-bot" } });
  assert.equal(active.status, "applied");
  assert.equal(profile().model, "gpt-realtime-2");
  assert.equal(store.runtime().active.artifact_id, "bundle-good");
  assert.equal(store.runtime().last_known_good_bundle_id, "bundle-good");
  assert.equal(store.runtime().active.manifest.payload, undefined);
  assert.equal(store.runtime().active.manifest.signature, undefined);
  assert.equal(store.runtime().active.manifest.provenance.author, "Automated release test");
  assert.deepEqual(store.runtime().active.activation.health.checks, ["profile_projection"]);
  assert.deepEqual(store.runtime().recent_audit.map((entry) => entry.event).slice(0, 2),
    ["activation_succeeded", "activation_started"]);
});

test("failed health check rolls profile back and preserves last-known-good", (t) => {
  let failBundle = "";
  const fixture = harness(t, {
    healthCheck: ({ manifest }) => ({
      ok: manifest.bundle_id !== failBundle,
      checks: ["profile_projection"],
    }),
  });
  fixture.store.publish(signedBundle("bundle-good", 1, { model: "known-good" }));
  fixture.store.activate("bundle-good");
  const beforeFailure = fixture.profile();

  fixture.store.publish(signedBundle("bundle-bad-health", 2, { model: "broken" }));
  failBundle = "bundle-bad-health";
  assert.throws(() => fixture.store.activate("bundle-bad-health"),
    (error) => error?.code === "health_check_failed");
  assert.deepEqual(fixture.profile(), beforeFailure);
  assert.equal(fixture.rollbacks.length, 1);
  assert.equal(fixture.store.runtime().active.artifact_id, "bundle-good");
  assert.equal(fixture.store.get("bundle-bad-health").status, "failed");
  assert.equal(fixture.store.runtime().recent_audit[0].event, "activation_rolled_back");
});

test("operator rollback reactivates the previous healthy signed bundle", (t) => {
  const { store, profile } = harness(t);
  store.publish(signedBundle("bundle-one", 1, { model: "one" }));
  store.activate("bundle-one");
  store.publish(signedBundle("bundle-two", 2, { model: "two" }));
  store.activate("bundle-two");
  assert.equal(profile().model, "two");
  assert.equal(store.runtime().previous_good_bundle_id, "bundle-one");

  const result = store.rollbackLastKnownGood({ actor: "operator" });
  assert.equal(result.ok, true);
  assert.equal(result.artifact.id, "bundle-one");
  assert.equal(profile().model, "one");
  assert.equal(store.runtime().active.artifact_id, "bundle-one");
});

test("normal activation rejects downgrade and replay while signed rollback remains available", (t) => {
  const { store } = harness(t);
  store.publish(signedBundle("bundle-one", 1, { model: "one" }));
  store.activate("bundle-one");
  store.publish(signedBundle("bundle-two", 2, { model: "two" }));
  store.activate("bundle-two");

  assert.throws(() => store.activate("bundle-one"), (error) => error?.code === "stale_bundle");
  assert.equal(store.activate("bundle-two").id, "bundle-two");
  assert.equal(store.runtime().active.artifact_id, "bundle-two");
});
