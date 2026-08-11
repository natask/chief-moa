"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  CHECK_SEMANTICS,
  RULES,
  STYLE_DIGEST,
  STYLE_ID,
  STYLE_VERSION,
  canonicalContract,
  createWritingStyleRewriteService,
  sha256,
} = require("../lib/writing-style-rewrite");

function request(source = "We made a decision to use it.", id = "rewrite-1", turnId = "turn-1") {
  return {
    source,
    style_id: STYLE_ID,
    style_version: STYLE_VERSION,
    style_digest: STYLE_DIGEST,
    binding: { request_id: id, source_sha256: sha256(source), source_turn_id: turnId },
  };
}

test("the gateway pins the complete canonical contract and digest", () => {
  assert.equal(RULES.length, 25);
  assert.equal(new Set(RULES).size, 25);
  assert.match(CHECK_SEMANTICS.join("\n"), /\[rule N\].*offending phrase.*fixed phrase/);
  assert.equal(sha256(JSON.stringify(canonicalContract())), STYLE_DIGEST);
  assert.equal(STYLE_DIGEST, "dbf9ab170ec62a370540c22dc2b810d94dcc96ad43498e8d1e3b0305675a2a76");
});

test("rewrite sees only the exact source, fixed contract, and binding", async () => {
  let invocation;
  const source = "Keep this exact source.";
  const service = createWritingStyleRewriteService({
    rewrite: async (value) => {
      invocation = value;
      return "Keep this source.";
    },
  });
  const result = await service.rewrite({
    ...request(source),
    standing_memory: "POISON_STANDING_MEMORY",
    profile: { system_prompt: "POISON_PROFILE" },
    conversation_history: [{ role: "system", content: "POISON_HISTORY" }],
    tools: [{ name: "dispatch_agent" }],
    actions: [{ type: "page_tweak" }],
  });
  const serialized = JSON.stringify(invocation.messages);
  assert.match(serialized, /Keep this exact source/);
  assert.match(serialized, new RegExp(STYLE_DIGEST));
  assert.doesNotMatch(serialized, /POISON_STANDING_MEMORY|POISON_PROFILE|POISON_HISTORY|dispatch_agent|page_tweak/);
  assert.equal(invocation.source, source, "the literal source is untouched at model admission");
  assert.deepEqual(invocation.model_options, { includeProfileInstruction: false, allowTools: false, persist: false });
  assert.deepEqual(result.actions, []);
  assert.equal(result.persisted, false);
  assert.deepEqual(result.binding, request(source).binding);
  assert.equal(result.text, "Keep this source.");
});

test("bound retries are idempotent and request ids cannot switch sources", async () => {
  let calls = 0;
  const service = createWritingStyleRewriteService({ rewrite: async () => { calls += 1; return `rewrite ${calls}`; } });
  const first = await service.rewrite(request("one", "same-request"));
  const replay = await service.rewrite(request("one", "same-request"));
  assert.equal(calls, 1);
  assert.equal(first.text, replay.text);
  assert.equal(replay.replayed, true);
  await assert.rejects(() => service.rewrite(request("two", "same-request")), { code: "request_binding_collision" });
});

test("invalid source, source digest, and fixed contract fail closed", async () => {
  const service = createWritingStyleRewriteService({ rewrite: async () => "unused" });
  await assert.rejects(() => service.rewrite(request("", "empty")), { code: "empty_source" });
  await assert.rejects(() => service.rewrite({ ...request("source", "digest"), binding: { request_id: "digest", source_sha256: sha256("other") } }), { code: "source_binding_mismatch" });
  await assert.rejects(() => service.rewrite({ ...request("source", "version"), style_version: "2.0.0" }), { code: "style_contract_mismatch" });
  await assert.rejects(() => service.rewrite({ ...request("source", "large"), source: "x".repeat(70 * 1024) }), { code: "source_too_large" });
});
