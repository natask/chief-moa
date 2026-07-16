"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  SESSION_MESSAGE_TEXT_MAX_CHARS,
  projectSessionMessages,
} = require("../lib/session-messages");

test("projects ordered mixed-source messages without truncating long product direction", () => {
  const longText = "Android product direction: " + "build the complete system. ".repeat(500);
  assert.ok(longText.length > 11_392);
  const payload = projectSessionMessages({
    sessionId: "shared",
    voiceTurns: [{
      id: "voice-1", session_id: "shared", branch_id: "default", source: "android-voice",
      transcript: "voice request", response: { display: " voice reply preserved " },
      classification: "chat", created_at: "2026-07-16T10:00:00Z",
    }],
    chatTurns: [{
      turn_id: "chat-1", session_id: "shared", branch_id: "default", source: "android-chat",
      user_text: longText, response_text: "typed reply", created_at: "2026-07-16T10:01:00Z",
    }],
    browserTurns: [{
      id: "browser-record", turn_id: "browser-1", session_id: "shared", branch_id: "default",
      source: "browser-extension", text: "browser request", response: { text: "browser reply" },
      created_at: "2026-07-16T10:02:00Z",
    }],
    brokerEvents: [{
      id: "broker-1", conversation_id: "shared", branch_id: "default", source: "android-broker",
      text: "broker direction", classification: "intent", created_at: "2026-07-16T10:03:00Z",
    }],
  });

  assert.deepEqual(payload.messages.map((message) => message.speaker), [
    "user", "assistant", "user", "assistant", "user", "assistant", "user",
  ]);
  assert.equal(payload.messages.find((message) => message.turn_id === "chat-1" && message.speaker === "user").text, longText);
  assert.equal(payload.messages.find((message) => message.turn_id === "voice-1" && message.speaker === "assistant").text, " voice reply preserved ");
  assert.deepEqual(new Set(payload.messages.map((message) => message.source_surface)), new Set(["android", "browser"]));
  assert.equal(payload.completeness.complete, true);
  assert.equal(payload.has_more, false);
});

test("deduplicates only explicit voice and broker links while retaining provenance", () => {
  const payload = projectSessionMessages({
    sessionId: "shared",
    voiceTurns: [{
      id: "voice-linked", session_id: "shared", transcript: "same words", response: { text: "answer" },
      source: "android-voice", created_at: "2026-07-16T10:00:00Z",
    }],
    chatTurns: [
      {
        turn_id: "chat-mirror", voice_turn_id: "voice-linked", session_id: "shared",
        user_text: "same words", response_text: "answer", source: "live-transcript",
        created_at: "2026-07-16T10:00:00Z",
      },
      {
        turn_id: "independent", session_id: "shared", user_text: "same words",
        response_text: "answer", source: "android-chat", created_at: "2026-07-16T10:00:01Z",
      },
    ],
    brokerEvents: [{
      id: "broker-linked", session_id: "shared", text: "same words",
      evidence_refs: [{ turn_id: "voice-linked" }], created_at: "2026-07-16T10:00:02Z",
    }],
  });

  assert.equal(payload.messages.length, 4);
  const voiceUser = payload.messages.find((message) => message.message_id === "turn:shared:default:voice-linked:user");
  assert.deepEqual(voiceUser.provenance.map((item) => item.store).sort(), ["broker", "chat", "voice"]);
  assert.deepEqual(voiceUser.evidence.broker_event_ids, ["broker-linked"]);
  assert.ok(payload.messages.some((message) => message.message_id === "turn:shared:default:independent:user"));
});

test("stable identities keep equal turn ids distinct across branches", () => {
  const payload = projectSessionMessages({
    sessionId: "shared",
    chatTurns: [
      { turn_id: "same", session_id: "shared", branch_id: "default", user_text: "main" },
      { turn_id: "same", session_id: "shared", branch_id: "fork", user_text: "fork" },
    ],
  });
  assert.equal(payload.messages.length, 2);
  assert.deepEqual(payload.messages.map((message) => message.message_id).sort(), [
    "turn:shared:default:same:user", "turn:shared:fork:same:user",
  ]);
});

test("keeps assistant output separate and reports private, branch, and invalid exclusions", () => {
  const payload = projectSessionMessages({
    sessionId: "shared",
    branchId: "fork",
    chatTurns: [
      null,
      { turn_id: "other-session", session_id: "other", user_text: "no" },
      { turn_id: "other-branch", session_id: "shared", branch_id: "default", user_text: "no" },
      { turn_id: "private", session_id: "shared", branch_id: "fork", incognito: true, user_text: "no" },
      {
        turn_id: "kept", session_id: "shared", branch_id: "fork", request_messages: [{ role: "user", content: "user request" }],
        response_text: "assistant response", created_at: "2026-07-16T10:00:00Z",
      },
    ],
  });

  assert.deepEqual(payload.messages.map(({ speaker, text }) => ({ speaker, text })), [
    { speaker: "user", text: "user request" },
    { speaker: "assistant", text: "assistant response" },
  ]);
  assert.deepEqual(payload.completeness.excluded_records, {
    other_session: 1, other_branch: 1, incognito: 1, invalid: 1, unreadable: 0,
  });
});

test("invalid bounds fail closed and unreadable records remain visible in completeness", () => {
  for (const limit of ["not-a-number", 0, 201, 1.5, -1]) {
    assert.throws(
      () => projectSessionMessages({ sessionId: "shared", limit, chatTurns: [{ session_id: "shared", user_text: "private" }] }),
      /invalid session message limit/,
    );
  }
  const payload = projectSessionMessages({
    sessionId: "shared",
    voiceTurns: [{ __session_message_unreadable: true, session_id: "shared" }],
    chatTurns: [{ __session_message_unreadable: true, session_id: "shared" }],
  });
  assert.equal(payload.messages.length, 0);
  assert.equal(payload.completeness.excluded_records.unreadable, 2);
});

test("represents incomplete and bounded text honestly", () => {
  const oversized = "x".repeat(SESSION_MESSAGE_TEXT_MAX_CHARS + 12);
  const payload = projectSessionMessages({
    sessionId: "shared",
    limit: 1,
    voiceTurns: [{
      id: "partial", session_id: "shared", transcript: oversized, status: "incomplete",
      response: {}, created_at: "2026-07-16T10:00:00Z",
    }],
    chatTurns: [{
      turn_id: "later", session_id: "shared", user_text: "later", created_at: "2026-07-16T10:01:00Z",
    }],
  });

  assert.equal(payload.total, 2);
  assert.equal(payload.has_more, true);
  assert.equal(payload.completeness.complete, false);
  assert.equal(payload.messages[0].text, "later");
  const unbounded = projectSessionMessages({
    sessionId: "shared",
    voiceTurns: [{ id: "partial", session_id: "shared", transcript: oversized, status: "incomplete" }],
  }).messages[0];
  assert.equal(unbounded.complete, false);
  assert.equal(unbounded.completion_state, "incomplete");
  assert.equal(unbounded.text_complete, false);
  assert.equal(unbounded.text.length, SESSION_MESSAGE_TEXT_MAX_CHARS);
  assert.equal(unbounded.stored_text_chars, oversized.length);
});
