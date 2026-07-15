"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const {
  REGISTRY_SCHEMA,
  RELEASE_SCHEMA,
  ReleaseValidationError,
  compareSemanticVersions,
  createFileReleaseAdapter,
  createInMemoryReleaseAdapter,
  createMemoryReleaseAdapter,
  createReleaseRegistry,
  evaluateReleaseEligibility,
  releaseKey,
  stableRolloutBucket,
  validateRelease,
} = require("../lib/release-registry");

const SIGNATURE = Buffer.alloc(64, 7).toString("base64");
const SHA256 = "a".repeat(64);
const GIT_SHA = "b".repeat(40);

function fixture(overrides = {}) {
  return {
    schema_version: RELEASE_SCHEMA,
    release_id: "rel-android-101",
    app_id: "chief-moa",
    platform: "android",
    arch: "arm64",
    channel: "stable",
    semantic_version: "1.1.0",
    monotonic_build: 101,
    protocol: { min: 1, max: 2 },
    git_sha: GIT_SHA,
    artifact_url: "https://releases.example.test/app.apk",
    size: 4096,
    sha256: SHA256,
    signature: { algorithm: "ed25519", key_id: "release-key-1", value: SIGNATURE },
    provenance: {
      builder: "github-actions/release",
      source_url: `https://github.com/example/chief-moa/commit/${GIT_SHA}`,
      attestation_url: "https://releases.example.test/attestation.json",
      attestation_sha256: "c".repeat(64),
    },
    published_at: "2026-07-13T20:00:00.000Z",
    rollout: { percentage: 100, salt: "android-stable" },
    mandatory: false,
    rollback_release: null,
    release_notes: { summary: "Release notes", url: "https://releases.example.test/notes" },
    ...overrides,
  };
}

function client(overrides = {}) {
  return {
    app_id: "chief-moa", platform: "android", arch: "arm64", channel: "stable",
    current_build: 100, protocol_version: 2, installation_id: "install-alpha",
    ...overrides,
  };
}

function expectCode(action, code, field) {
  assert.throws(action, (error) => {
    assert.equal(error.code, code);
    if (field !== undefined) assert.equal(error.field, field);
    return true;
  });
}

test("registry publishing is immutable, idempotent, coordinate-unique, sorted, and copied", () => {
  const registry = createReleaseRegistry({ adapter: createMemoryReleaseAdapter() });
  const first = registry.publish(fixture());
  assert.equal(registry.publish(fixture()).release_id, first.release_id);
  expectCode(() => registry.publish(fixture({ semantic_version: "1.1.1" })), "immutable_release", "release_id");
  expectCode(() => registry.publish(fixture({ release_id: "other-id" })), "duplicate_build", "monotonic_build");
  registry.publish(fixture({ release_id: "rel-beta-102", channel: "beta", monotonic_build: 102 }));
  registry.publish(fixture({ release_id: "rel-stable-100", monotonic_build: 100, semantic_version: "1.0.0" }));
  assert.deepEqual(registry.list({ channel: "stable" }).map((item) => item.monotonic_build), [100, 101]);
  const fetched = registry.get(" REL-ANDROID-101 ");
  fetched.release_notes.summary = "mutated copy";
  assert.equal(registry.get("rel-android-101").release_notes.summary, "Release notes");
  assert.equal(registry.get("missing"), null);
  assert.equal(registry.check(client({ channel: "canary" })).reason, "no_release_for_key");
});

test("registry rejects invalid adapters and capacity overflow", () => {
  for (const adapter of [{}, { read() {}, write: 1 }]) {
    expectCode(() => createReleaseRegistry({ adapter }).list(), "invalid_adapter");
  }
  expectCode(() => createReleaseRegistry({ adapter: { read: () => ({}), write() {} } }).list(), "invalid_adapter");
  const release = validateRelease(fixture());
  const full = createReleaseRegistry({ adapter: { read: () => Array(10_000).fill(release), write() {} } });
  expectCode(() => full.publish(fixture({ release_id: "new-id", monotonic_build: 102 })), "registry_full");
});

test("eligibility fails closed for malformed release, key, protocol, build, and rollout inputs", () => {
  const release = fixture();
  assert.deepEqual(evaluateReleaseEligibility({ ...client(), release: null }), {
    status: "verification_failed", reason: "invalid_release", release: null,
    install_performed: false, field: null,
  });
  assert.equal(evaluateReleaseEligibility({ ...client({ app_id: "?" }), release }).reason, "invalid_id");
  assert.equal(evaluateReleaseEligibility({ ...client({ platform: "ios" }), release }).reason, "release_key_mismatch");
  assert.equal(evaluateReleaseEligibility({ ...client({ protocol_version: "x" }), release }).reason, "invalid_integer");
  assert.equal(evaluateReleaseEligibility({ ...client({ current_build: -1 }), release }).reason, "invalid_integer");
  assert.equal(evaluateReleaseEligibility({ ...client({ protocol_version: 0 }), release }).reason, "protocol_out_of_range");
  assert.equal(evaluateReleaseEligibility({ ...client({ protocol_version: 3 }), release }).reason, "protocol_out_of_range");
  assert.equal(evaluateReleaseEligibility({ ...client({ current_build: 101 }), release }).status, "up_to_date");
  assert.equal(evaluateReleaseEligibility({ ...client({ current_build: 102 }), release }).reason, "downgrade_not_authorized");

  const staged = fixture({ rollout: { percentage: 50, salt: "stage" } });
  assert.equal(evaluateReleaseEligibility({ ...client({ installation_id: "" }), release: staged }).reason, "installation_id_required_for_rollout");
  const bucket = stableRolloutBucket("inside", "stage");
  const inside = fixture({ rollout: { percentage: Math.min(100, bucket + 0.000001), salt: "stage" } });
  assert.equal(evaluateReleaseEligibility({ ...client({ installation_id: "inside" }), release: inside }).status, "eligible");
});

test("eligibility propagates unexpected access failures", () => {
  const releaseProxy = new Proxy({}, { getPrototypeOf() { throw new Error("release trap"); } });
  assert.throws(() => evaluateReleaseEligibility({ ...client(), release: releaseProxy }), /release trap/);
  const keyProxy = new Proxy({ ...client(), release: fixture() }, {
    get(target, key) { if (key === "app_id") throw new Error("key trap"); return target[key]; },
  });
  assert.throws(() => evaluateReleaseEligibility(keyProxy), /key trap/);
  const protocolProxy = new Proxy({ ...client(), release: fixture() }, {
    get(target, key) { if (key === "protocol_version") throw new Error("protocol trap"); return target[key]; },
  });
  assert.throws(() => evaluateReleaseEligibility(protocolProxy), /protocol trap/);
});

test("rollback planning covers every missing and invalid relationship", () => {
  const registry = createReleaseRegistry();
  assert.equal(registry.planRollback(client({ current_release_id: "missing" })).reason, "current_release_not_found");
  registry.publish(fixture());
  assert.equal(registry.planRollback(client({ current_release_id: "rel-android-101" })).reason, "rollback_not_declared");

  const missingTarget = createReleaseRegistry();
  missingTarget.publish(fixture({ rollback_release: "missing-target" }));
  assert.equal(missingTarget.planRollback(client({ current_release_id: "rel-android-101" })).reason, "rollback_release_not_found");

  const wrongKey = createReleaseRegistry();
  wrongKey.publish(fixture({ release_id: "rel-ios-100", platform: "ios", monotonic_build: 100 }));
  wrongKey.publish(fixture({ rollback_release: "rel-ios-100" }));
  assert.equal(wrongKey.planRollback(client({ current_release_id: "rel-android-101" })).reason, "rollback_key_mismatch");

  const newer = createReleaseRegistry();
  newer.publish(fixture({ release_id: "rel-android-102", monotonic_build: 102 }));
  newer.publish(fixture({ rollback_release: "rel-android-102" }));
  assert.equal(newer.planRollback(client({ current_release_id: "rel-android-101" })).reason, "rollback_must_target_older_build");
});

test("release validation applies defaults and accepts optional forms", () => {
  const input = fixture({
    schema_version: null, release_id: null, provenance: {
      builder: "builder", source_url: "https://example.test/source",
      attestation_url: null, attestation_sha256: null,
    }, release_notes: " text notes ",
  });
  const release = validateRelease(input);
  assert.equal(release.schema_version, RELEASE_SCHEMA);
  assert.equal(release.release_id, "chief-moa-android-arm64-stable-101");
  assert.deepEqual(release.release_notes, { summary: "text notes", url: null });
  assert.equal(release.provenance.attestation_url, null);
  assert.ok(Object.isFrozen(release));
  assert.ok(Object.isFrozen(release.signature));
  assert.equal(releaseKey(release), "chief-moa/android/arm64/stable");
});

test("release validation rejects unknown, malformed, unsafe, and inconsistent fields", () => {
  const cases = [
    [null, "invalid_release"],
    [fixture({ extra: true }), "unknown_field", "release.extra"],
    [fixture({ schema_version: "v2" }), "unsupported_schema", "schema_version"],
    [fixture({ app_id: "?" }), "invalid_id", "app_id"],
    [fixture({ semantic_version: "01.2.3" }), "invalid_semantic_version", "semantic_version"],
    [fixture({ monotonic_build: 0 }), "invalid_integer", "monotonic_build"],
    [fixture({ protocol: null }), "invalid_protocol", "protocol"],
    [fixture({ protocol: { min: 2, max: 1 } }), "invalid_protocol", "protocol"],
    [fixture({ protocol: { min: 1, max: 2, extra: 3 } }), "unknown_field", "protocol.extra"],
    [fixture({ git_sha: "bad" }), "invalid_git_sha", "git_sha"],
    [fixture({ artifact_url: "not a url" }), "invalid_url", "artifact_url"],
    [fixture({ artifact_url: "http://example.test/a" }), "invalid_url", "artifact_url"],
    [fixture({ artifact_url: "https://user:pass@example.test/a" }), "invalid_url", "artifact_url"],
    [fixture({ size: Infinity }), "invalid_integer", "size"],
    [fixture({ sha256: "bad" }), "invalid_sha256", "sha256"],
    [fixture({ signature: null }), "malformed_signature", "signature"],
    [fixture({ signature: { algorithm: "rsa", key_id: "key", value: SIGNATURE } }), "malformed_signature", "signature.algorithm"],
    [fixture({ signature: { algorithm: "ed25519", key_id: "?", value: SIGNATURE } }), "invalid_id", "signature.key_id"],
    [fixture({ signature: { algorithm: "ed25519", key_id: "key", value: "bad" } }), "malformed_signature", "signature.value"],
    [fixture({ signature: { algorithm: "ed25519", key_id: "key", value: `${SIGNATURE.slice(0, -3)}B==` } }), "malformed_signature", "signature.value"],
    [fixture({ signature: { algorithm: "ed25519", key_id: "key", value: SIGNATURE, extra: 1 } }), "unknown_field", "signature.extra"],
    [fixture({ provenance: null }), "invalid_provenance", "provenance"],
    [fixture({ provenance: { builder: "b", source_url: "https://example.test", extra: 1 } }), "unknown_field", "provenance.extra"],
    [fixture({ provenance: { builder: "b", source_url: "https://example.test", attestation_url: "https://example.test/a" } }), "invalid_provenance", "provenance"],
    [fixture({ rollout: null }), "invalid_rollout", "rollout"],
    [fixture({ rollout: { percentage: NaN, salt: "x" } }), "invalid_rollout", "rollout.percentage"],
    [fixture({ rollout: { percentage: -1, salt: "x" } }), "invalid_rollout", "rollout.percentage"],
    [fixture({ rollout: { percentage: 101, salt: "x" } }), "invalid_rollout", "rollout.percentage"],
    [fixture({ rollout: { percentage: 100, salt: "" } }), "invalid_text", "rollout.salt"],
    [fixture({ rollout: { percentage: 100, salt: "x", extra: 1 } }), "unknown_field", "rollout.extra"],
    [fixture({ mandatory: "false" }), "invalid_boolean", "mandatory"],
    [fixture({ published_at: "yesterday" }), "invalid_timestamp", "published_at"],
    [fixture({ published_at: "2026-07-13T20:00:00+00:00" }), "invalid_timestamp", "published_at"],
    [fixture({ release_notes: null }), "invalid_release_notes", "release_notes"],
    [fixture({ release_notes: { summary: "", url: null } }), "invalid_text", "release_notes.summary"],
    [fixture({ release_notes: { summary: "ok", extra: true } }), "unknown_field", "release_notes.extra"],
    [fixture({ release_notes: { summary: "ok", url: "http://example.test" } }), "invalid_url", "release_notes.url"],
    [fixture({ rollback_release: "rel-android-101" }), "invalid_rollback", "rollback_release"],
  ];
  for (const [input, code, field] of cases) expectCode(() => validateRelease(input), code, field);
});

test("bounded text and integer validators reject length, controls, and unsafe bounds through public fields", () => {
  expectCode(() => validateRelease(fixture({ release_notes: "x".repeat(8193) })), "invalid_text", "release_notes");
  expectCode(() => validateRelease(fixture({ release_notes: "bad\u0001text" })), "invalid_text", "release_notes");
  expectCode(() => validateRelease(fixture({ monotonic_build: Number.MAX_SAFE_INTEGER + 1 })), "invalid_integer", "monotonic_build");
  expectCode(() => stableRolloutBucket("", "salt"), "invalid_text", "installation_id");
  expectCode(() => stableRolloutBucket("id", ""), "invalid_text", "rollout.salt");
});

test("semantic version ordering covers core, stable, prerelease, numeric, and lexical precedence", () => {
  const cases = [
    ["1.0.0", "1.0.0", 0], ["1.0.0", "2.0.0", -1], ["2.0.0", "1.0.0", 1],
    ["1.0.0", "1.0.0-alpha", 1], ["1.0.0-alpha", "1.0.0", -1],
    ["1.0.0-alpha", "1.0.0-alpha.1", -1], ["1.0.0-alpha.1", "1.0.0-alpha", 1],
    ["1.0.0-alpha.1", "1.0.0-alpha.2", -1], ["1.0.0-alpha.2", "1.0.0-alpha.1", 1],
    ["1.0.0-alpha.1", "1.0.0-alpha.beta", -1], ["1.0.0-alpha.beta", "1.0.0-alpha.1", 1],
    ["1.0.0-alpha.a", "1.0.0-alpha.b", -1], ["1.0.0-alpha.b", "1.0.0-alpha.a", 1],
    ["1.0.0-alpha", "1.0.0-alpha", 0],
  ];
  for (const [left, right, expected] of cases) assert.equal(compareSemanticVersions(left, right), expected);
  expectCode(() => compareSemanticVersions("bad", "1.0.0"), "invalid_semantic_version", "semantic_version");
});

test("file adapter fails closed for absent, corrupt, unsupported, oversized, and invalid writes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-registry-test-"));
  try {
    const file = path.join(dir, "nested", "registry.json");
    const adapter = createFileReleaseAdapter(file);
    assert.deepEqual(adapter.read(), []);
    expectCode(() => createFileReleaseAdapter(""), "invalid_file_path", "filePath");

    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "not-json");
    expectCode(() => adapter.read(), "invalid_registry_file");
    for (const value of [[], {}, { schema_version: "wrong", releases: [] }, { schema_version: REGISTRY_SCHEMA, releases: {} }]) {
      fs.writeFileSync(file, JSON.stringify(value));
      expectCode(() => adapter.read(), "invalid_registry_file");
    }
    fs.writeFileSync(file, JSON.stringify({ schema_version: REGISTRY_SCHEMA, releases: Array(10_001).fill(null) }));
    expectCode(() => adapter.read(), "registry_full");
    expectCode(() => adapter.write({}), "registry_full");
    expectCode(() => adapter.write(Array(10_001)), "registry_full");
    adapter.write([fixture()]);
    assert.equal(adapter.read()[0].release_id, "rel-android-101");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validation errors expose optional fields and exported constants are stable", () => {
  const plain = new ReleaseValidationError("code", "message");
  assert.equal(plain.field, undefined);
  assert.equal(plain.name, "ReleaseValidationError");
  assert.equal(REGISTRY_SCHEMA, "moa-release-registry/v1");
  assert.equal(RELEASE_SCHEMA, "moa-release/v1");
  assert.equal(createInMemoryReleaseAdapter, createMemoryReleaseAdapter);
});
