"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  CONTEXT_ARTIFACT_VERSION,
  buildContextArtifact,
  contextArtifactReceipt,
} = require("../lib/context-artifact");

test("context artifact redacts secret-like text and omits deleted/incognito sources", () => {
  const artifact = buildContextArtifact({
    session_id: "session-a",
    branch_id: "default",
    query: "budget",
    sources: [
      {
        source_id: "standing:1",
        section: "standing",
        bucket: "standing",
        reason: "standing_fact",
        lines: ["- [standing:1] call me Bob Bearer raw-secret-token"],
      },
      {
        source_id: "voice:deleted",
        section: "voice",
        bucket: "recency",
        reason: "recent_voice_turn",
        deleted_at: "2026-07-10T00:00:00.000Z",
        lines: ["- [voice:deleted] user: deleted line"],
      },
      {
        source_id: "voice:incognito",
        section: "voice",
        bucket: "recency",
        reason: "recent_voice_turn",
        incognito: true,
        lines: ["- [voice:incognito] user: hidden line"],
      },
    ],
  });

  assert.equal(artifact.version, CONTEXT_ARTIFACT_VERSION);
  assert.match(artifact.text, /\[redacted\]/);
  assert.doesNotMatch(artifact.text, /raw-secret-token/);
  assert.equal(artifact.retrieval.omitted.deleted, 1);
  assert.equal(artifact.retrieval.omitted.incognito, 1);
  assert.equal(artifact.retrieval.source_count, 1);
});

test("context artifact cache identity is stable for equivalent inputs and changes on query or revision change", () => {
  const base = {
    session_id: "session-a",
    branch_id: "default",
    query: "grocery budget",
    sources: [{
      source_id: "chat:1",
      section: "chat",
      bucket: "recency",
      reason: "recent_chat_turn",
      revision: "r1",
      lines: ["- [chat:1] user: reconcile the grocery budget"],
    }],
  };
  const first = buildContextArtifact(base);
  const second = buildContextArtifact(base);
  const changedQuery = buildContextArtifact({ ...base, query: "vendor budget" });
  const changedRevision = buildContextArtifact({
    ...base,
    sources: [{ ...base.sources[0], revision: "r2" }],
  });

  assert.equal(first.cache_identity.key, second.cache_identity.key);
  assert.notEqual(first.cache_identity.key, changedQuery.cache_identity.key);
  assert.notEqual(first.cache_identity.key, changedRevision.cache_identity.key);
});

test("context artifact dedupes adversarial duplicate snippets deterministically", () => {
  const artifact = buildContextArtifact({
    session_id: "session-a",
    branch_id: "default",
    query: "shipping",
    sources: [
      {
        source_id: "recall:1",
        section: "recall",
        bucket: "semantic_recall",
        reason: "semantic_thread_summary",
        dedupe_key: "same snippet",
        lines: ["- [recall:1] (thread) vendor alpha shipping plan"],
      },
      {
        source_id: "recall:2",
        section: "recall",
        bucket: "semantic_recall",
        reason: "semantic_thread_summary",
        dedupe_key: "same snippet",
        lines: ["- [recall:2] (thread) vendor alpha shipping plan"],
      },
      {
        source_id: "chat:1",
        section: "chat",
        bucket: "recency",
        reason: "recent_chat_turn",
        lines: ["- [chat:1] user: continue the shipping plan"],
      },
    ],
  });

  assert.equal(artifact.retrieval.source_count, 2);
  assert.equal(artifact.retrieval.omitted.duplicate, 1);
  assert.deepEqual(
    artifact.retrieval.ranking.map((item) => item.source_id),
    ["chat:1", "recall:1"],
  );
});

test("context artifact receipt is bounded and exposes ranking rationale", () => {
  const artifact = buildContextArtifact({
    session_id: "session-a",
    branch_id: "default",
    query: "planning",
    max_chars: 1000,
    sources: [
      {
        source_id: "standing:1",
        section: "standing",
        bucket: "standing",
        reason: "standing_fact",
        sort_rank: 10,
        lines: [`- [standing:1] ${"The user prefers concise plans. ".repeat(40).trim()}`],
      },
      {
        source_id: "chat:1",
        section: "chat",
        bucket: "recency",
        reason: "recent_chat_turn",
        sort_rank: 20,
        lines: ["- [chat:1] user: build the plan with a long enough line to hit the render bound quickly"],
      },
    ],
  });
  const receipt = contextArtifactReceipt(artifact, 1);

  assert.equal(receipt.version, CONTEXT_ARTIFACT_VERSION);
  assert.equal(receipt.source_ids.length, 1);
  assert.equal(receipt.ranking.length, 1);
  assert.equal(receipt.ranking[0].reason, "standing_fact");
  assert.equal(artifact.retrieval.truncated, true);
});
