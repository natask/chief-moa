"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createMediaBookmarkStore, normalizeAlias } = require("../lib/media-bookmarks");
const OWNER = "usr_owner_one";

function harness(t, overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-media-bookmarks-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let sequence = 0;
  const store = createMediaBookmarkStore({
    dataDir,
    now: () => "2026-07-16T12:00:00.000Z",
    randomId: () => `bookmark_${++sequence}`,
    ...overrides,
  });
  return { dataDir, store };
}

function sample(overrides = {}) {
  return {
    provider: "youtube",
    video_id: "dQw4w9WgXcQ",
    position_ms: 42_500,
    label: "chorus I like",
    title: "Example video",
    note: "Return to the harmony.",
    aliases: ["favorite chorus", "the good harmony"],
    preferred_package: "attacker.supplied.youtube",
    preferred_instance: "Attacker supplied instance",
    source_surface: "android",
    idempotency_key: "turn-123_bookmark",
    user_approved: true,
    ...overrides,
  };
}

test("stores a bounded approved record with canonical YouTube identity and persists it", (t) => {
  const { dataDir, store } = harness(t);
  const saved = store.save(OWNER, sample());
  assert.deepEqual(saved, {
    id: "bookmark_1",
    owner_id: OWNER,
    provider: "youtube",
    video_id: "dQw4w9WgXcQ",
    canonical_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    position_ms: 42_500,
    label: "chorus I like",
    title: "Example video",
    note: "Return to the harmony.",
    aliases: ["favorite chorus", "the good harmony"],
    source_surface: "android",
    idempotency_key: "turn-123_bookmark",
    user_approved: true,
    created_at: "2026-07-16T12:00:00.000Z",
    updated_at: "2026-07-16T12:00:00.000Z",
  });
  assert.equal(fs.statSync(path.join(dataDir, "media-bookmarks.json")).mode & 0o777, 0o600);
  const reopened = createMediaBookmarkStore({ dataDir });
  assert.deepEqual(reopened.get(OWNER, saved.id), saved);
  assert.deepEqual(reopened.list(OWNER, { video_id: saved.video_id }), [saved]);
});

test("requires explicit approval, stable video identity, position, label, source, and idempotency", (t) => {
  const { store } = harness(t);
  const failures = [
    [sample({ user_approved: false }), /explicit user approval/],
    [sample({ provider: "vimeo" }), /provider must be youtube/],
    [sample({ video_id: "short" }), /11-character/],
    [sample({ video_id: "!!!!!!!!!!!" }), /11-character/],
    [sample({ video_id: "dQw4w9WgXcQ " }), /exact 11-character/],
    [sample({ position_ms: -1 }), /position_ms/],
    [sample({ position_ms: 2.5 }), /position_ms/],
    [sample({ label: " " }), /label is required/],
    [sample({ source_surface: "bad surface" }), /invalid format/],
    [sample({ idempotency_key: "" }), /idempotency_key must match/],
    [sample({ idempotency_key: `${"a".repeat(200)} ` }), /idempotency_key must match/],
    [sample({ idempotency_key: "key\ncontrol" }), /idempotency_key must match/],
    [sample({ canonical_url: "https://youtu.be/dQw4w9WgXcQ" }), /must match video_id/],
  ];
  for (const [input, expected] of failures) assert.throws(() => store.save(OWNER, input), expected);
  assert.throws(() => store.save("", sample()), /owner_id is required/);
  assert.deepEqual(store.list(OWNER), []);
});

test("bookmark ids are strict opaque values before any normalization", (t) => {
  const { store } = harness(t);
  const saved = store.save(OWNER, sample());
  for (const suffix of [" ", "\n", "/", "\0"]) {
    assert.throws(() => store.get(OWNER, `${saved.id}${suffix}`), /invalid format/);
    assert.throws(() => store.remove(OWNER, `${saved.id}${suffix}`), /invalid format/);
  }
  assert.throws(() => store.get(OWNER, "a".repeat(121)), /invalid format/);
  assert.deepEqual(store.get(OWNER, saved.id), saved);
  const invalidGenerator = harness(t, { randomId: () => "bookmark bad" }).store;
  assert.throws(() => invalidGenerator.save(OWNER, sample()), /generated bookmark id has an invalid format/);
});

test("client package and instance hints never persist or affect idempotency", (t) => {
  const { dataDir, store } = harness(t);
  const first = store.save(OWNER, sample());
  assert.equal(first.preferred_package, undefined);
  assert.equal(first.preferred_instance, undefined);
  assert.deepEqual(store.save(OWNER, sample({
    preferred_package: "different.client.package",
    preferred_instance: "Different client instance",
  })), first);
  const disk = JSON.parse(fs.readFileSync(path.join(dataDir, "media-bookmarks.json"), "utf8"));
  assert.equal(disk.bookmarks[0].preferred_package, undefined);
  assert.equal(disk.bookmarks[0].preferred_instance, undefined);
});

test("omitted provider defaults to the only supported provider", (t) => {
  const { store } = harness(t);
  const input = sample();
  delete input.provider;
  assert.equal(store.save(OWNER, input).provider, "youtube");
});

test("same idempotency request replays while a changed request collides", (t) => {
  const { store } = harness(t);
  const first = store.save(OWNER, sample());
  assert.deepEqual(store.save(OWNER, sample()), first);
  assert.equal(store.list(OWNER).length, 1);
  assert.throws(() => store.save(OWNER, sample({ position_ms: 43_000 })), /idempotency collision/);
  assert.doesNotThrow(() => store.save("usr_owner_two", sample()));
});

test("alias resolution is normalized and deterministic across exact, phrase, and token matches", (t) => {
  const { store } = harness(t);
  const first = store.save(OWNER, sample());
  assert.equal(normalizeAlias("  FAVORITE—Chorus! "), "favorite chorus");
  assert.deepEqual(store.resolve(OWNER, "Favorite chorus"), {
    status: "matched", match_type: "exact_alias", bookmark: first,
  });
  assert.equal(store.resolve(OWNER, "please play the good harmony again").match_type, "phrase");
  assert.equal(store.resolve(OWNER, "harmony good").match_type, "token_overlap");
  assert.deepEqual(store.resolve(OWNER, "unrelated words"), { status: "not_found", candidates: [] });
});

test("equal best matches return explicit ambiguity and video filters can disambiguate", (t) => {
  const { store } = harness(t);
  const first = store.save(OWNER, sample({ label: "opening scene", aliases: [], idempotency_key: "one" }));
  const second = store.save(OWNER, sample({
    video_id: "M7lc1UVf-VE", label: "opening scene", aliases: [], idempotency_key: "two",
  }));
  const ambiguous = store.resolve(OWNER, "opening scene");
  assert.equal(ambiguous.status, "ambiguous");
  assert.equal(ambiguous.match_type, "exact_alias");
  assert.deepEqual(ambiguous.candidates.map((item) => item.id), [first.id, second.id]);
  assert.equal(store.resolve(OWNER, "opening scene", { video_id: second.video_id }).bookmark.id, second.id);
});

test("lists newest first with bounded filters and protects stored values from caller mutation", (t) => {
  const times = ["2026-07-16T12:00:00.000Z", "2026-07-16T13:00:00.000Z"];
  const { store } = harness(t, { now: () => times.shift() });
  const android = store.save(OWNER, sample({ idempotency_key: "android" }));
  const browser = store.save(OWNER, sample({ source_surface: "browser_extension", idempotency_key: "browser", label: "browser spot" }));
  const listed = store.list(OWNER, { limit: 1 });
  assert.deepEqual(listed, [browser]);
  listed[0].label = "mutated";
  assert.equal(store.get(OWNER, browser.id).label, "browser spot");
  assert.deepEqual(store.list(OWNER, { source_surface: "android" }), [android]);
  assert.throws(() => store.list(OWNER, { limit: 0 }), /limit/);
});

test("removes an existing bookmark durably and reports a missing id", (t) => {
  const { dataDir, store } = harness(t);
  const saved = store.save(OWNER, sample());
  assert.equal(store.get("usr_owner_two", saved.id), null);
  assert.equal(store.remove("usr_owner_two", saved.id), null);
  assert.deepEqual(store.remove(OWNER, saved.id), saved);
  assert.equal(store.get(OWNER, saved.id), null);
  assert.equal(store.remove(OWNER, saved.id), null);
  assert.deepEqual(createMediaBookmarkStore({ dataDir }).list(OWNER), []);
});

test("rejects malformed durable state instead of overwriting it", (t) => {
  const { dataDir, store } = harness(t);
  fs.writeFileSync(path.join(dataDir, "media-bookmarks.json"), "not-json");
  assert.throws(() => store.list(OWNER), /not valid JSON/);
  fs.writeFileSync(path.join(dataDir, "media-bookmarks.json"), JSON.stringify({ version: 99, bookmarks: [] }));
  assert.throws(() => store.save(OWNER, sample()), /unsupported shape/);
});
