"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createSelfExtensionArtifactStore } = require("../lib/self-extension-artifacts");

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-self-extension-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function valid(overrides = {}) {
  return {
    type: "avatar_behavior",
    spec: { trigger: "thinking", motion: "pulse", intensity: "normal", duration: "while_active" },
    ...overrides,
  };
}

test("store creates, clones, filters, applies, switches, and reloads artifacts", (t) => {
  const dataDir = tempDir(t);
  const store = createSelfExtensionArtifactStore({ dataDir });
  const first = store.createCandidate(valid({ prompt: "animate", variantGroupId: "group!", parentId: "parent!" }));
  assert.match(first.id, /^art_/);
  assert.equal(first.title, "thinking pulse");
  assert.equal(first.variant_group_id, "group");
  assert.equal(first.parent_id, "parent");
  assert.equal(first.preview.class_name, "moa-avatar--thinking-pulse-normal");
  first.title = "mutated";
  assert.notEqual(store.get(first.id).title, "mutated");
  assert.equal(store.get("bad/path"), null);
  assert.equal(store.get(null), null);

  const second = store.createCandidate(valid({ title: " Second ", variant_group_id: "group2" }));
  assert.equal(store.list({ type: "avatar_behavior", status: "draft", limit: 1 }).length, 1);
  assert.equal(store.list({ type: "other" }).length, 0);
  assert.equal(store.list({ status: "applied" }).length, 0);
  assert.equal(store.list({ limit: "bad" }).length, 2);
  assert.equal(store.list({ limit: 0 }).length, 2);

  const appliedFirst = store.apply(first.id, { approval: { mode: "test" } });
  assert.equal(appliedFirst.status, "applied");
  assert.equal(store.runtime().active.avatar_behavior.artifact_id, first.id);
  const appliedSecond = store.apply(second.id, []);
  assert.equal(appliedSecond.apply_context && Object.keys(appliedSecond.apply_context).length, 0);
  assert.equal(store.get(first.id).status, "draft");
  assert.equal(store.runtime().active.avatar_behavior.artifact_id, second.id);
  assert.equal(store.apply("missing"), null);

  const reloaded = createSelfExtensionArtifactStore({ dataDir });
  assert.equal(reloaded.get(second.id).status, "applied");
  assert.equal(reloaded.runtime().active.avatar_behavior.artifact_id, second.id);
  assert.deepEqual(reloaded.known().artifact_types, ["avatar_behavior"]);
});

test("validation rejects unsupported types and every invalid avatar field", (t) => {
  const store = createSelfExtensionArtifactStore({ dataDir: tempDir(t) });
  assert.throws(() => store.createCandidate(), /unsupported artifact type/);
  assert.throws(() => store.validate({ type: "other" }), /unsupported artifact type/);
  const validation = store.validate({ type: "avatar_behavior", spec: [] });
  assert.equal(validation.ok, false);
  assert.equal(validation.errors.length, 4);
  for (const [field, value] of [["trigger", "bad"], ["motion", "bad"], ["intensity", "bad"], ["duration", "bad"]]) {
    const spec = valid().spec;
    spec[field] = value;
    assert.throws(() => store.createCandidate(valid({ spec })), new RegExp(field));
  }
});

test("corrupt and malformed persisted state is archived and normalized", (t) => {
  const dataDir = tempDir(t);
  const storePath = path.join(dataDir, "self-extension-artifacts.json");
  fs.writeFileSync(storePath, "{");
  let store = createSelfExtensionArtifactStore({ dataDir });
  assert.deepEqual(store.list(), []);
  assert.ok(fs.readdirSync(dataDir).some((name) => name.includes(".corrupt-")));

  fs.writeFileSync(storePath, JSON.stringify({ bad: true }));
  store = createSelfExtensionArtifactStore({ dataDir });
  assert.deepEqual(store.list(), []);

  const spec = valid().spec;
  fs.writeFileSync(storePath, JSON.stringify({
    artifacts: {
      good: {
        id: "good", type: "avatar_behavior", title: "", status: "unknown", variant_group_id: "",
        spec, preview: null, validation: { warnings: ["warning", 4] }, apply_context: [],
        created_at: "bad", updated_at: "bad", applied_at: "bad",
      },
      primitive: 4,
      unsupported: { id: "unsupported", type: "other", spec },
      missing_id: { type: "avatar_behavior", spec },
      invalid_spec: { id: "invalid", type: "avatar_behavior", spec: {} },
    },
    active: { avatar_behavior: "missing" },
  }));
  store = createSelfExtensionArtifactStore({ dataDir });
  const good = store.get("good");
  assert.equal(good.status, "draft");
  assert.equal(good.title, "thinking pulse");
  assert.deepEqual(good.validation.warnings, ["warning"]);
  assert.deepEqual(good.preview, {});
  assert.deepEqual(good.apply_context, {});
  assert.match(good.created_at, /^\d{4}-/);
  assert.equal(good.updated_at, good.created_at);
  assert.equal(good.applied_at, "");
  assert.equal(store.runtime().active.avatar_behavior, null);
  assert.ok(fs.readdirSync(dataDir).filter((name) => name.includes(".corrupt-")).length >= 2);
});

test("valid legacy active state and list bounds remain deterministic", (t) => {
  const dataDir = tempDir(t);
  const storePath = path.join(dataDir, "self-extension-artifacts.json");
  fs.writeFileSync(storePath, JSON.stringify({
    artifacts: {
      active: {
        id: "active", type: "avatar_behavior", title: "active", status: "applied", variant_group_id: "var",
        spec: valid().spec, preview: {}, validation: { warnings: [] }, apply_context: {},
        created_at: "2026-01-01", updated_at: "2026-01-02", applied_at: "2026-01-03",
      },
    },
    active: { avatar_behavior: "active" },
  }));
  const store = createSelfExtensionArtifactStore({ dataDir });
  assert.equal(store.runtime().active.avatar_behavior.artifact_id, "active");
  assert.equal(store.list({ limit: -4 }).length, 1);
  assert.equal(store.list({ limit: 9999 }).length, 1);
});
