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

test("context artifact redacts OAuth URL credentials and PAT-like tokens", () => {
  const secrets = [
    "https://callback.invalid/?access_token=oauth-secret-value&state=ok",
    "https%3Faccess_token%3Dencoded-oauth-secret%26state%3Dok",
    "https%253Frefresh_token%253Ddouble-encoded-secret%2526state%253Dok",
    "refresh_token: refresh-secret-value",
    "github_pat_abcdefghijklmnopqrstuvwxyz123456",
    "ghp_abcdefghijklmnopqrstuvwxyz123456",
    "glpat-abcdefghijklmnopqrstuvwxyz123456",
    "pat_abcdefghijklmnopqrstuvwxyz123456",
  ];
  const artifact = buildContextArtifact({
    session_id: "session-a",
    sources: [{ source_id: "chat:secrets", section: "chat", lines: secrets }],
  });
  assert.equal(artifact.retrieval.redaction.count, secrets.length);
  for (const secret of ["oauth-secret-value", "encoded-oauth-secret", "double-encoded-secret", "refresh-secret-value", "abcdefghijklmnopqrstuvwxyz123456"]) {
    assert.doesNotMatch(artifact.text, new RegExp(secret));
  }
});

test("canonical redaction handles triple and malformed percent encodings", () => {
  const artifact = buildContextArtifact({
    session_id: "session-a",
    query: "access_token%25253Dquery-triple-secret",
    sources: [{
      source_id: "chat:encoded",
      section: "chat",
      lines: [
        "https%25253Frefresh_token%25253Dtriple-secret%252526state%25253Dok",
        "%ZZclient_secret%3Dmalformed-prefix-secret%26state%3Dok",
      ],
    }],
  });
  const serialized = JSON.stringify(artifact);
  for (const secret of ["query-triple-secret", "triple-secret", "malformed-prefix-secret"]) {
    assert.doesNotMatch(serialized, new RegExp(secret));
  }
  assert.match(artifact.text, /\[redacted\]/);
});

test("all exposed metadata is validated, redacted, or irreversibly hashed", () => {
  const artifact = buildContextArtifact({
    version: "Bearer version-secret-token",
    session_id: "access_token=session-secret",
    branch_id: "Bearer branch-secret-token",
    profile_version: "github_pat_abcdefghijklmnopqrstuvwxyz123456",
    query: "client_secret=query-secret",
    sources: [{
      source_id: "ghp_abcdefghijklmnopqrstuvwxyz123456",
      section: "access_token=section-secret",
      bucket: "Bearer bucket-secret-token",
      reason: "client_secret=reason-secret",
      branch_id: "refresh_token=source-branch-secret",
      revision: "pat_abcdefghijklmnopqrstuvwxyz123456",
      created_at: "access_token=timestamp-secret",
      lines: ["safe rendered line"],
    }],
  });
  const serialized = JSON.stringify(artifact);
  for (const secret of ["version-secret", "session-secret", "branch-secret", "query-secret", "section-secret", "bucket-secret", "reason-secret", "source-branch-secret", "timestamp-secret", "abcdefghijklmnopqrstuvwxyz123456"]) {
    assert.doesNotMatch(serialized, new RegExp(secret));
  }
  assert.equal(artifact.version, CONTEXT_ARTIFACT_VERSION);
  assert.equal(artifact.scope.session_id, "");
  assert.equal(artifact.scope.branch_id, "default");
  assert.equal(artifact.sources[0].reason, "context");
  assert.match(artifact.sources[0].revision, /^rev_[a-f0-9]{16}$/);
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

test("duplicate source ids cannot make receipt provenance ambiguous", () => {
  const artifact = buildContextArtifact({
    session_id: "session-a",
    sources: [
      { source_id: "chat:same", section: "chat", dedupe_key: "first", lines: ["first"] },
      { source_id: "chat:same", section: "chat", dedupe_key: "second", lines: ["second"] },
    ],
  });
  assert.equal(artifact.retrieval.source_count, 1);
  assert.equal(artifact.retrieval.omitted.duplicate, 1);
  assert.deepEqual(artifact.sources.map((source) => source.source_id), ["chat:same"]);
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
        lines: ["- [standing:1] user prefers concise plans", `  ${"Long detail. ".repeat(120).trim()}`],
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
  assert.deepEqual(receipt.source_ids, ["standing:1"]);
  assert.deepEqual(receipt.ranking.map((item) => item.source_id), ["standing:1"]);
});

test("receipt excludes accepted sources that did not render", () => {
  const artifact = buildContextArtifact({
    session_id: "session-a",
    max_chars: 1000,
    sources: [
      { source_id: "chat:rendered", section: "chat", sort_rank: 1, lines: ["- [chat:rendered] visible"] },
      { source_id: "chat:not-rendered", section: "chat", sort_rank: 2, lines: [`- [chat:not-rendered] ${"x".repeat(2000)}`] },
    ],
  });
  const receipt = contextArtifactReceipt(artifact);
  assert.deepEqual(receipt.source_ids, ["chat:rendered"]);
  assert.deepEqual(receipt.ranking.map((item) => item.source_id), ["chat:rendered"]);
  assert.equal(receipt.source_count, 1);
  assert.equal(receipt.omitted.render_limit, 1);
  assert.doesNotMatch(artifact.text, /chat:not-rendered/);
});

test("candidate and per-source work are bounded before sorting and redaction", () => {
  let inspected = 0;
  const manyLines = Array.from({ length: 1000 }, (__, line) => `line ${line}`);
  const sources = Array.from({ length: 10000 }, (_, index) => ({
    get sort_rank() { inspected += 1; return index; },
    source_id: `chat:${index}`,
    section: "chat",
    lines: manyLines,
  }));
  const artifact = buildContextArtifact({ session_id: "session-a", max_sources: 2, sources });
  assert.ok(inspected < 100, `sort inspected too many candidates: ${inspected}`);
  assert.ok(artifact.retrieval.omitted.source_limit >= 9990);
});
