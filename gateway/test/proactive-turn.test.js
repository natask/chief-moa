"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  PROACTIVE_ACCEPTED_PROMPTS,
  PROACTIVE_PROVIDER_MAX_OUTPUT_TOKENS,
  PROACTIVE_PROVIDER_MAX_RESPONSE_BYTES,
  PROACTIVE_SYSTEM_PROMPT,
  PROACTIVE_TURN_MAX_BODY_BYTES,
  ProactiveTurnValidationError,
  buildProactiveOpenAiPayload,
  buildProactiveModelMessages,
  buildProactiveVertexPayload,
  proactiveOpenAiText,
  proactiveFallbackReply,
  proactiveTurnResponse,
  proactiveVertexText,
  validateProactiveTurnBody,
} = require("../lib/proactive-turn");

function body(overrides = {}) {
  return {
    source: "proactive_accept_v1",
    modality: "text",
    transcript: PROACTIVE_ACCEPTED_PROMPTS[0],
    client: { platform: "browser", source: "agee-extension", input: "text" },
    ...overrides,
  };
}

function expectCode(action, code) {
  assert.throws(action, (error) => error instanceof ProactiveTurnValidationError && error.code === code);
}

test("request validation accepts only the fixed inert envelope", () => {
  const validated = validateProactiveTurnBody(body());
  assert.deepEqual(validated, { transcript: PROACTIVE_ACCEPTED_PROMPTS[0] });
  assert.ok(Object.isFrozen(validated));

  for (const value of [null, [], "request", { ...body(), extra: true }]) {
    expectCode(() => validateProactiveTurnBody(value), "invalid_request_shape");
  }
  for (const client of [null, [], {}, { platform: "browser", source: "agee-extension", input: "text", extra: true }]) {
    expectCode(() => validateProactiveTurnBody(body({ client })), "invalid_client_shape");
  }
  expectCode(() => validateProactiveTurnBody(body({ source: "voice" })), "invalid_source");
  expectCode(() => validateProactiveTurnBody(body({ modality: "audio" })), "invalid_modality");
  expectCode(() => validateProactiveTurnBody(body({ transcript: "arbitrary page text" })), "unrecognized_prompt");
  for (const client of [
    { platform: "android", source: "agee-extension", input: "text" },
    { platform: "browser", source: "other", input: "text" },
    { platform: "browser", source: "agee-extension", input: "voice" },
  ]) expectCode(() => validateProactiveTurnBody(body({ client })), "invalid_client");
});

test("model payloads contain only fixed system policy and accepted category prompt", () => {
  for (const prompt of PROACTIVE_ACCEPTED_PROMPTS) {
    assert.deepEqual(buildProactiveModelMessages(prompt), [{ role: "user", content: prompt }]);
  }
  expectCode(() => buildProactiveModelMessages("unknown"), "unrecognized_prompt");

  const openai = buildProactiveOpenAiPayload(PROACTIVE_ACCEPTED_PROMPTS[1], null);
  assert.equal(openai.model, "");
  assert.equal(openai.messages[0].content, PROACTIVE_SYSTEM_PROMPT);
  assert.equal(openai.max_tokens, PROACTIVE_PROVIDER_MAX_OUTPUT_TOKENS);
  assert.equal(openai.stream, false);

  const vertex = buildProactiveVertexPayload(PROACTIVE_ACCEPTED_PROMPTS[2], [
    { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" },
    null,
  ]);
  assert.equal(vertex.contents[0].parts[0].text, PROACTIVE_ACCEPTED_PROMPTS[2]);
  assert.equal(vertex.generationConfig.maxOutputTokens, PROACTIVE_PROVIDER_MAX_OUTPUT_TOKENS);
  assert.deepEqual(vertex.safetySettings[1], { category: "", threshold: "" });
  assert.equal("safetySettings" in buildProactiveVertexPayload(PROACTIVE_ACCEPTED_PROMPTS[3], []), false);
  assert.equal("safetySettings" in buildProactiveVertexPayload(PROACTIVE_ACCEPTED_PROMPTS[3], null), false);
  expectCode(() => buildProactiveVertexPayload("unknown"), "unrecognized_prompt");
});

test("OpenAI reply parsing rejects tools, functions, and missing text", () => {
  assert.equal(proactiveOpenAiText({ choices: [{ message: { content: "Safe advice" } }] }), "Safe advice");
  for (const payload of [
    null,
    { choices: [] },
    { choices: [{ message: { content: "text", tool_calls: [] } }] },
    { choices: [{ message: { content: "text", function_call: {} } }] },
  ]) assert.throws(() => proactiveOpenAiText(payload), /executable output/);
  assert.throws(() => proactiveOpenAiText({ choices: [{ message: { content: null } }] }), /empty reply/);
});

test("Vertex reply parsing joins text-only parts and rejects executable shapes", () => {
  assert.equal(proactiveVertexText({ candidates: [{ content: { parts: [{ text: "one" }, { text: "two" }] } }] }), "one\ntwo");
  for (const payload of [null, { candidates: [] }, { candidates: [{ content: { parts: [] } }] }]) {
    assert.throws(() => proactiveVertexText(payload), /empty reply/);
  }
  for (const part of [null, "text", { text: "ok", functionCall: {} }, { functionCall: {} }]) {
    assert.throws(() => proactiveVertexText({ candidates: [{ content: { parts: [part] } }] }), /executable output/);
  }
  assert.throws(
    () => proactiveVertexText({ candidates: [{ content: { parts: [{ text: null }] } }] }),
    /empty reply/,
  );
});

test("response normalization strips controls, bounds text, and emits no actions", () => {
  const response = proactiveTurnResponse(` \u0000help\u000B me\u000C now\u007F `);
  assert.equal(response.display, "help  me  now");
  assert.equal(response.text, response.display);
  assert.equal(response.persisted, false);
  assert.deepEqual(response.actions, []);
  assert.equal(proactiveTurnResponse("x".repeat(5000)).text.length, 4000);
  for (const empty of [null, "", " \u0000 "]) assert.throws(() => proactiveTurnResponse(empty), /empty reply/);
});

test("every packaged prompt has a deterministic fallback and unknown prompts do not", () => {
  for (const prompt of PROACTIVE_ACCEPTED_PROMPTS) assert.ok(proactiveFallbackReply(prompt).length > 40);
  assert.equal(proactiveFallbackReply("unknown"), "");
});

test("public bounds and validation error metadata remain stable", () => {
  assert.equal(PROACTIVE_TURN_MAX_BODY_BYTES, 2048);
  assert.equal(PROACTIVE_PROVIDER_MAX_RESPONSE_BYTES, 64 * 1024);
  assert.equal(PROACTIVE_PROVIDER_MAX_OUTPUT_TOKENS, 512);
  const defaultError = new ProactiveTurnValidationError("bad");
  assert.equal(defaultError.statusCode, 422);
  assert.equal(defaultError.name, "ProactiveTurnValidationError");
  assert.equal(new ProactiveTurnValidationError("bad", 400).statusCode, 400);
});
