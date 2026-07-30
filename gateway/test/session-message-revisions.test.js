"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  SESSION_MESSAGE_REVISION_TEXT_MAX_CHARS,
  appendMessageRevision,
  createMessageRevisionHistory,
  projectCurrentMessageRevision,
} = require("../lib/session-message-revisions");

const original = Object.freeze({
  message_id: "turn:shared:turn-1:user",
  session_id: "shared",
  turn_id: "turn-1",
  role: "user",
  text: "send teh report",
  actor: "gateway_projection",
  source: "android_voice",
  reason: "retained_transcript",
  created_at: "2026-07-29T10:00:00.000Z",
});

function edit(overrides = {}) {
  return {
    message_id: original.message_id,
    session_id: original.session_id,
    turn_id: original.turn_id,
    role: original.role,
    text: "send the report",
    expected_revision: 0,
    actor: "owner_1",
    source: "android_history",
    reason: "transcript_correction",
    created_at: "2026-07-29T10:01:00.000Z",
    ...overrides,
  };
}

test("appends a user transcript correction without mutating revision zero", () => {
  const history = createMessageRevisionHistory(original);
  const revised = appendMessageRevision(history, edit());

  assert.equal(history.current_revision, 0);
  assert.equal(history.incognito, false);
  assert.equal(history.persisted, true);
  assert.equal(history.deleted_at, null);
  assert.equal(history.revisions.length, 1);
  assert.equal(history.revisions[0].text, "send teh report");
  assert.equal(revised.current_revision, 1);
  assert.deepEqual(revised.revisions.map(({ revision, text }) => ({ revision, text })), [
    { revision: 0, text: "send teh report" },
    { revision: 1, text: "send the report" },
  ]);
  assert.deepEqual(projectCurrentMessageRevision(revised), {
    version: "session_message_revisions.v1",
    message_id: original.message_id,
    session_id: "shared",
    turn_id: "turn-1",
    role: "user",
    text: "send the report",
    revision: 1,
    original_text: "send teh report",
    revised: true,
    revision_metadata: {
      actor: "owner_1",
      source: "android_history",
      reason: "transcript_correction",
      created_at: "2026-07-29T10:01:00.000Z",
    },
  });
  assert.equal(Object.isFrozen(revised), true);
  assert.equal(Object.isFrozen(revised.revisions), true);
  assert.equal(Object.isFrozen(revised.revisions[0]), true);
  assert.throws(() => { revised.revisions[0].text = "rewritten"; }, TypeError);
  assert.equal(revised.revisions[0].text, "send teh report");
});

test("supports assistant reply revisions and preserves audit metadata", () => {
  const assistant = {
    ...original,
    message_id: "turn:shared:turn-1:assistant",
    role: "assistant",
    text: "The report was send.",
    source: "gateway_reasoning",
    reason: "retained_reply",
  };
  const history = createMessageRevisionHistory(assistant);
  const revised = appendMessageRevision(history, {
    ...edit({
      message_id: assistant.message_id,
      role: "assistant",
      text: "The report was sent.",
      source: "browser_history",
      reason: "reply_correction",
    }),
  });
  assert.deepEqual(revised.revisions[1], {
    message_id: assistant.message_id,
    session_id: "shared",
    turn_id: "turn-1",
    role: "assistant",
    revision: 1,
    text: "The report was sent.",
    actor: "owner_1",
    source: "browser_history",
    reason: "reply_correction",
    created_at: "2026-07-29T10:01:00.000Z",
  });
});

test("compare-and-swap rejects stale writers and invalid revision values", () => {
  const history = createMessageRevisionHistory(original);
  const revised = appendMessageRevision(history, edit());
  assert.throws(
    () => appendMessageRevision(revised, edit({ text: "send our report" })),
    (error) => error.code === "message_revision_conflict" && /expected revision 0, current revision 1/.test(error.message),
  );
  for (const expected_revision of [-1, 0.5, "0", null]) {
    assert.throws(
      () => appendMessageRevision(history, edit({ expected_revision })),
      (error) => error.code === "invalid_message_revision",
    );
  }
});

test("rejects cross-message, session, turn, and role edits", () => {
  const history = createMessageRevisionHistory(original);
  for (const mismatch of [
    { message_id: "turn:shared:turn-2:user" },
    { session_id: "foreign" },
    { turn_id: "turn-2" },
    { role: "assistant" },
  ]) {
    assert.throws(
      () => appendMessageRevision(history, edit(mismatch)),
      (error) => error.code === "message_revision_binding_mismatch",
    );
  }
});

test("rejects incognito and deleted messages before creating or appending history", () => {
  assert.throws(
    () => createMessageRevisionHistory({ ...original, incognito: true }),
    (error) => error.code === "message_revision_private",
  );
  assert.throws(
    () => createMessageRevisionHistory({ ...original, deleted_at: "2026-07-29T10:00:01.000Z" }),
    (error) => error.code === "message_revision_deleted",
  );
  const history = createMessageRevisionHistory(original);
  assert.throws(
    () => appendMessageRevision(history, edit({ persisted: false })),
    (error) => error.code === "message_revision_private",
  );
  assert.throws(
    () => appendMessageRevision(history, edit({ deleted: true })),
    (error) => error.code === "message_revision_deleted",
  );
});

test("rejects oversized, blank, and no-op revisions", () => {
  const history = createMessageRevisionHistory(original);
  assert.throws(
    () => appendMessageRevision(history, edit({ text: "x".repeat(SESSION_MESSAGE_REVISION_TEXT_MAX_CHARS + 1) })),
    (error) => error.code === "message_revision_too_large",
  );
  assert.throws(
    () => appendMessageRevision(history, edit({ text: "   " })),
    (error) => error.code === "invalid_message_revision",
  );
  assert.throws(
    () => appendMessageRevision(history, edit({ text: original.text })),
    (error) => error.code === "message_revision_noop",
  );
});

test("rejects corrupt chains and non-monotonic time", () => {
  const history = createMessageRevisionHistory(original);
  const corruptions = [
    { ...history, current_revision: 1 },
    { ...history, revisions: [{ ...history.revisions[0], revision: 2 }] },
    { ...history, revisions: [{ ...history.revisions[0], turn_id: "other" }] },
  ];
  for (const corrupted of corruptions) {
    assert.throws(
      () => projectCurrentMessageRevision(corrupted),
      (error) => error.code === "invalid_message_revision",
    );
  }
  assert.throws(
    () => appendMessageRevision(history, edit({ created_at: "2026-07-29T09:59:59.000Z" })),
    (error) => error.code === "invalid_message_revision",
  );
});

test("requires canonical roles, metadata, timestamps, and identifiers", () => {
  for (const invalid of [
    { role: "system" },
    { message_id: "" },
    { actor: "" },
    { source: "" },
    { reason: "" },
    { created_at: "not-a-time" },
  ]) {
    assert.throws(
      () => createMessageRevisionHistory({ ...original, ...invalid }),
      (error) => error.code === "invalid_message_revision",
    );
  }
});

test("canonicalizes mutable deserialized revisions and deeply freezes the new chain", () => {
  const serialized = JSON.parse(JSON.stringify(createMessageRevisionHistory(original)));
  const revised = appendMessageRevision(serialized, edit());

  serialized.revisions[0].text = "mutated after append";
  serialized.revisions[0].actor = "different actor";
  assert.equal(revised.revisions[0].text, original.text);
  assert.equal(revised.revisions[0].actor, original.actor);
  assert.equal(Object.isFrozen(revised.revisions[0]), true);
  assert.throws(() => { revised.revisions[0].source = "changed"; }, TypeError);
});

test("rejects unknown history and revision fields before they can survive", () => {
  const history = JSON.parse(JSON.stringify(createMessageRevisionHistory(original)));
  assert.throws(
    () => appendMessageRevision({ ...history, secret: "token" }, edit()),
    (error) => error.code === "invalid_message_revision" && /unknown field secret/.test(error.message),
  );
  history.revisions[0].raw_audio = Buffer.from("private").toString("base64");
  assert.throws(
    () => projectCurrentMessageRevision(history),
    (error) => error.code === "invalid_message_revision" && /unknown field raw_audio/.test(error.message),
  );
});

test("fails closed on missing or malformed canonical privacy flags", () => {
  const canonical = JSON.parse(JSON.stringify(createMessageRevisionHistory(original)));
  for (const malformed of [
    { incognito: "false" },
    { persisted: "true" },
    { deleted_at: false },
    { incognito: undefined },
    { persisted: undefined },
    { deleted_at: undefined },
  ]) {
    assert.throws(
      () => projectCurrentMessageRevision({ ...canonical, ...malformed }),
      (error) => error.code === "invalid_message_revision",
    );
  }
  assert.throws(
    () => createMessageRevisionHistory({ ...original, incognito: "false" }),
    (error) => error.code === "invalid_message_revision",
  );
  assert.throws(
    () => appendMessageRevision(canonical, edit({ persisted: "true" })),
    (error) => error.code === "invalid_message_revision",
  );
});
