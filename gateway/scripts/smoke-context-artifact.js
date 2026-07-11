#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");

const {
  buildContextArtifact,
  contextArtifactReceipt,
} = require("../lib/context-artifact");

main();

function main() {
  const chatArtifact = buildContextArtifact({
    session_id: "context-artifact-smoke-session",
    branch_id: "default",
    query: "remind me about the grocery budget",
    sources: [
      {
        source_id: "brain:standing:1",
        section: "standing",
        bucket: "standing",
        reason: "standing_fact",
        sort_rank: 10,
        lines: ["- [brain:standing:1] Call me Bob. Bearer raw-secret-token"],
      },
      {
        source_id: "voice:1",
        section: "voice",
        bucket: "recency",
        reason: "recent_voice_turn",
        sort_rank: 20,
        lines: ["- [voice:1] user (turn, branch=default): discuss the grocery budget with vendor alpha"],
      },
      {
        source_id: "chat:deleted",
        section: "chat",
        bucket: "recency",
        reason: "recent_chat_turn",
        deleted_at: "2026-07-10T02:00:00.000Z",
        sort_rank: 30,
        lines: ["- [chat:deleted] user: deleted secret text should never surface"],
      },
      {
        source_id: "brain:thread:1",
        section: "recall",
        bucket: "semantic_recall",
        reason: "semantic_thread_summary",
        sort_rank: 40,
        lines: ["- [brain:thread:1] (thread) Grocery budget thread with vendor alpha pricing decisions."],
      },
    ],
  });

  assert.ok(chatArtifact.text.length > 0, "chat artifact text must exist");
  assert.match(chatArtifact.text, /\[redacted\]/, "secret-like text must be redacted");
  assert.doesNotMatch(chatArtifact.text, /raw-secret-token/, "raw secret-like text must not survive");
  assert.doesNotMatch(chatArtifact.text, /deleted secret text/, "deleted content must be omitted");

  const voiceArtifact = buildContextArtifact({
    session_id: "context-artifact-smoke-session",
    branch_id: "default",
    query: "continue the grocery budget plan",
    sources: [
      {
        source_id: "brain:standing:1",
        section: "standing",
        bucket: "standing",
        reason: "standing_fact",
        sort_rank: 10,
        lines: ["- [brain:standing:1] Call me Bob."],
      },
      {
        source_id: "voice:1",
        section: "voice",
        bucket: "recency",
        reason: "recent_voice_turn",
        sort_rank: 20,
        lines: ["- [voice:1] user (interrupted, branch=default): continue the grocery budget with vendor alpha"],
      },
      {
        source_id: "brain:thread:1",
        section: "recall",
        bucket: "semantic_recall",
        reason: "semantic_thread_summary",
        sort_rank: 40,
        lines: ["- [brain:thread:1] (thread) Grocery budget thread with vendor alpha pricing decisions."],
      },
    ],
  });
  const receipt = contextArtifactReceipt(voiceArtifact);

  assert.ok(receipt, "artifact receipt must exist");
  assert.equal(receipt.version, "moa.context-artifact.v1");
  assert.ok(String(receipt.cache_key || "").startsWith("ctx:"));
  assert.ok(receipt.ranking.some((entry) => entry.reason === "semantic_thread_summary"));
  assert.notEqual(chatArtifact.cache_identity.key, voiceArtifact.cache_identity.key, "query changes must invalidate cache identity");

  console.log(JSON.stringify({
    ok: true,
    checks: [
      "chat-oriented artifact redacts secret-like text and omits deleted sources",
      "voice-oriented artifact exposes the bounded receipt with ranking rationale",
      "cache identity changes when the retrieval query changes",
    ],
  }, null, 2));
}
