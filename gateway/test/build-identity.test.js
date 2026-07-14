"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { buildIdentity } = require("../lib/build-identity");

test("build identity has a deterministic unknown fallback", () => {
  assert.deepEqual(buildIdentity({}), {
    git_sha: "unknown",
    git_ref: "unknown",
    built_at: "unknown",
  });
});

test("build identity accepts and normalizes deployment metadata", () => {
  assert.deepEqual(buildIdentity({
    MOA_BUILD_SHA: "0123456789abcdef0123456789abcdef01234567",
    MOA_BUILD_REF: "vps-deploy",
    MOA_BUILD_TIME: "2026-07-13T08:09:10Z",
  }), {
    git_sha: "0123456789abcdef0123456789abcdef01234567",
    git_ref: "vps-deploy",
    built_at: "2026-07-13T08:09:10.000Z",
  });
});

test("build identity rejects values that could leak arbitrary metadata", () => {
  assert.deepEqual(buildIdentity({
    MOA_BUILD_SHA: "not-a-sha",
    MOA_BUILD_REF: "ref with secret=value",
    MOA_BUILD_TIME: "not-a-time",
  }), {
    git_sha: "unknown",
    git_ref: "unknown",
    built_at: "unknown",
  });
});
