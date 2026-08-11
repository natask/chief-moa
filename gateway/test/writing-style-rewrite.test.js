"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  CHECK_SEMANTICS,
  IDEMPOTENCY_HORIZON_MS,
  RULES,
  STYLE_DIGEST,
  STYLE_ID,
  STYLE_VERSION,
  canonicalContract,
  createWritingStyleRewriteService,
  sha256,
} = require("../lib/writing-style-rewrite");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

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

test("a completed request id cannot switch source turn bindings", async () => {
  let calls = 0;
  const service = createWritingStyleRewriteService({ rewrite: async () => { calls += 1; return "rewrite"; } });
  await service.rewrite(request("one", "completed-turn-collision", "turn-1"));
  await assert.rejects(service.rewrite(request("one", "completed-turn-collision", "turn-2")), {
    code: "request_binding_collision",
    statusCode: 409,
  });
  assert.equal(calls, 1);
});

test("concurrent matching rewrites share one in-flight promise and model call", async () => {
  const model = deferred();
  let calls = 0;
  const service = createWritingStyleRewriteService({
    rewrite: () => {
      calls += 1;
      return model.promise;
    },
  });
  const first = service.rewrite(request("one", "concurrent"));
  const second = service.rewrite(request("one", "concurrent"));
  assert.strictEqual(first, second);
  await Promise.resolve();
  assert.equal(calls, 1);
  model.resolve("shared rewrite");
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.strictEqual(firstResult, secondResult);
  assert.equal(firstResult.text, "shared rewrite");
});

test("a concurrent request id collision fails while the original rewrite continues", async () => {
  const model = deferred();
  let calls = 0;
  const service = createWritingStyleRewriteService({ rewrite: () => { calls += 1; return model.promise; } });
  const original = service.rewrite(request("one", "active-collision"));
  await assert.rejects(service.rewrite(request("two", "active-collision")), { code: "request_binding_collision", statusCode: 409 });
  await Promise.resolve();
  assert.equal(calls, 1);
  model.resolve("original rewrite");
  assert.equal((await original).text, "original rewrite");
});

test("an in-flight turn binding survives clock advance beyond the completed replay horizon", async () => {
  const model = deferred();
  let calls = 0;
  let currentTime = 1_000;
  const service = createWritingStyleRewriteService({
    now: () => currentTime,
    rewrite: () => { calls += 1; return model.promise; },
  });
  const original = service.rewrite(request("one", "long-running", "turn-1"));
  await Promise.resolve();
  assert.equal(calls, 1);

  currentTime += IDEMPOTENCY_HORIZON_MS + 1;
  const shared = service.rewrite(request("one", "long-running", "turn-1"));
  assert.strictEqual(shared, original);
  await assert.rejects(service.rewrite(request("one", "long-running", "turn-2")), {
    code: "request_binding_collision",
    statusCode: 409,
  });
  assert.equal(calls, 1);

  model.resolve("long-running rewrite");
  const [originalResult, sharedResult] = await Promise.all([original, shared]);
  assert.strictEqual(originalResult, sharedResult);
});

test("in-flight reservations are bounded without evicting active work", async () => {
  const model = deferred();
  let calls = 0;
  const service = createWritingStyleRewriteService({
    maxIdempotencyReservations: 1,
    rewrite: () => { calls += 1; return model.promise; },
  });
  const active = service.rewrite(request("one", "active"));
  await assert.rejects(service.rewrite(request("two", "other")), {
    code: "rewrite_idempotency_capacity",
    statusCode: 503,
  });
  await Promise.resolve();
  assert.equal(calls, 1);
  model.resolve("active rewrite");
  assert.equal((await active).text, "active rewrite");
});

test("completed rewrites replay for the fixed horizon and expire without early capacity eviction", async () => {
  let currentTime = 1_000;
  let calls = 0;
  const service = createWritingStyleRewriteService({
    maxIdempotencyReservations: 1,
    now: () => currentTime,
    rewrite: async () => `rewrite ${++calls}`,
  });
  assert.equal((await service.rewrite(request("one", "held"))).text, "rewrite 1");
  currentTime += IDEMPOTENCY_HORIZON_MS - 1;
  const replay = await service.rewrite(request("one", "held"));
  assert.equal(replay.text, "rewrite 1");
  assert.equal(replay.replayed, true);
  await assert.rejects(service.rewrite(request("two", "blocked")), {
    code: "rewrite_idempotency_capacity",
    statusCode: 503,
  });
  assert.equal(calls, 1, "capacity pressure must not evict an unexpired idempotency binding");
  currentTime += 1;
  assert.equal((await service.rewrite(request("one", "held"))).text, "rewrite 2");
  assert.equal(calls, 2);
});

test("invalid source, source digest, and fixed contract fail closed", async () => {
  const service = createWritingStyleRewriteService({ rewrite: async () => "unused" });
  await assert.rejects(() => service.rewrite(request("", "empty")), { code: "empty_source" });
  await assert.rejects(() => service.rewrite({ ...request("source", "digest"), binding: { request_id: "digest", source_sha256: sha256("other") } }), { code: "source_binding_mismatch" });
  await assert.rejects(() => service.rewrite({ ...request("source", "version"), style_version: "2.0.0" }), { code: "style_contract_mismatch" });
  await assert.rejects(() => service.rewrite({ ...request("source", "large"), source: "x".repeat(70 * 1024) }), { code: "source_too_large" });
});
