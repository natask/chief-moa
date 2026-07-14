"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  contextPreflightMessages,
  contextPreflightTool,
  parseOpenAiContextPreflight,
  parseVertexContextPreflight,
  buildCanonicalContextArtifact,
  buildAdmittedAnswerMessages,
  scopeClientMessagesForAdmission,
  stashContextDecision,
  takeContextDecision,
  planTurnFilingThread,
  prepareContextDecision,
  brain,
} = require("../server");

test("decision preflight contains only bounded instruction, current turn, and decision schema", () => {
  const callerSecret = "CALLER_RECENCY_SECRET_SENTINEL";
  const standingSecret = "STANDING_FACT_SECRET_SENTINEL";
  const messages = contextPreflightMessages("current user turn");
  const serialized = JSON.stringify({ messages, tools: [contextPreflightTool()] });
  assert.equal(messages.length, 2);
  assert.match(serialized, /current user turn/);
  assert.match(serialized, /context_management/);
  assert.doesNotMatch(serialized, new RegExp(callerSecret));
  assert.doesNotMatch(serialized, new RegExp(standingSecret));
  assert.deepEqual(contextPreflightTool().function.parameters.required, ["action", "retrieval_query"]);
});

test("unsupported provider retains the deterministic prior without preflight", async () => {
  const prepared = await prepareContextDecision({
    text: "continue this work",
    contextAction: "",
    profile: { model: "unconfigured-test-model", reasoning_provider: "openai-compatible" },
  });
  assert.equal(prepared.decision.action, "continue");
  assert.deepEqual(prepared.preflight, {
    attempted: false,
    tool_called: false,
    fallback_reason: "unsupported_provider",
  });
});

test("filing resolution is an immutable plan shared by retrieval and commit", () => {
  const planned = planTurnFilingThread({
    sessionId: "pure-plan-session",
    callerBranchId: "default",
    decision: { action: "new", thread_label: "Cold work" },
  });
  assert.equal(Object.isFrozen(planned), true);
  assert.match(planned.branch_id, /^thr-/);
  assert.equal(planned.kind, "new");
  assert.equal(planned.persisted, true);
  assert.throws(() => { planned.branch_id = "mutated"; }, TypeError);
});

test("OpenAI and Vertex parsers require exactly one valid context decision tool", () => {
  const args = { action: "new", retrieval_query: "bounded query" };
  const openAi = (calls) => ({ choices: [{ message: { content: "discard me", tool_calls: calls } }] });
  const call = (name, value = args) => ({ function: { name, arguments: JSON.stringify(value) } });
  assert.deepEqual(parseOpenAiContextPreflight(openAi([call("context_management")])), args);
  assert.equal(parseOpenAiContextPreflight(openAi([])), null);
  assert.equal(parseOpenAiContextPreflight(openAi([call("context_management"), call("context_management")])), null);
  assert.equal(parseOpenAiContextPreflight(openAi([call("update_agent_profile")])), null);
  assert.equal(parseOpenAiContextPreflight(openAi([{ function: { name: "context_management", arguments: "{" } }])), null);

  const vertex = (parts) => ({ candidates: [{ content: { parts } }] });
  const fn = (name, value = args) => ({ functionCall: { name, args: value } });
  assert.deepEqual(parseVertexContextPreflight(vertex([fn("context_management")])), args);
  assert.equal(parseVertexContextPreflight(vertex([{ text: "plain answer" }])), null);
  assert.equal(parseVertexContextPreflight(vertex([fn("phone_action")])), null);
  assert.equal(parseVertexContextPreflight(vertex([fn("context_management"), fn("context_management")])), null);
});

test("standing-only artifact excludes recency, semantic recall, runs, and tasks", () => {
  const originalStanding = brain.recallStandingFacts;
  const originalRecall = brain.recall;
  brain.recallStandingFacts = () => [{ slug: "standing/test", snippet: "STANDING_ONLY_SENTINEL" }];
  brain.recall = () => { throw new Error("semantic recall must not run for standing-only scope"); };
  try {
    const artifact = buildCanonicalContextArtifact({
      sessionId: "standing-only-hostile",
      branchId: "new-cold",
      query: "CALLER_QUERY_SENTINEL",
      standingOnly: true,
    });
    assert.match(artifact.text, /STANDING_ONLY_SENTINEL/);
    assert.doesNotMatch(artifact.text, /CALLER_QUERY_SENTINEL/);
    assert.ok(artifact.sources.every((source) => source.section === "standing"));
  } finally {
    brain.recallStandingFacts = originalStanding;
    brain.recall = originalRecall;
  }
});

test("new and incognito chat answers keep only the current admitted user turn", () => {
  const hostileHistory = [
    { role: "user", content: "OLDER_CLIENT_HISTORY_SENTINEL" },
    { role: "assistant", content: "OLDER_ASSISTANT_SENTINEL" },
    { role: "user", content: "current admitted user turn" },
  ];
  const modelMessages = buildAdmittedAnswerMessages({
    systemBlocks: ["AUTHORITATIVE_ARTIFACT_SENTINEL"],
    messages: hostileHistory,
    action: "new",
    fallbackText: "current admitted user turn",
  });
  const serialized = JSON.stringify(modelMessages);
  assert.match(serialized, /AUTHORITATIVE_ARTIFACT_SENTINEL/);
  assert.match(serialized, /current admitted user turn/);
  assert.doesNotMatch(serialized, /OLDER_CLIENT_HISTORY_SENTINEL/);
  assert.doesNotMatch(serialized, /OLDER_ASSISTANT_SENTINEL/);

  const incognitoMessages = buildAdmittedAnswerMessages({
    systemBlocks: ["AUTHORITATIVE_ARTIFACT_SENTINEL"],
    messages: hostileHistory,
    action: "incognito",
    fallbackText: "current admitted user turn",
  });
  assert.equal(incognitoMessages.filter((message) => message.role === "user").length, 1);
  assert.equal(incognitoMessages.at(-1).content, "current admitted user turn");
});

test("fork and HTTP voice answer payloads drop caller-supplied history after admission", () => {
  const hostileVoiceMessages = [
    { role: "user", content: "VOICE_HISTORY_SENTINEL" },
    { role: "assistant", content: "VOICE_ASSISTANT_SENTINEL" },
    { role: "user", content: "fresh transcript turn" },
  ];
  const scoped = scopeClientMessagesForAdmission(hostileVoiceMessages, "fork", "fresh transcript turn");
  assert.deepEqual(scoped, [{ role: "user", content: "fresh transcript turn" }]);

  const modelMessages = buildAdmittedAnswerMessages({
    systemBlocks: ["FORK_ARTIFACT_SENTINEL"],
    messages: hostileVoiceMessages,
    action: "fork",
    fallbackText: "fresh transcript turn",
  });
  const serialized = JSON.stringify(modelMessages);
  assert.match(serialized, /FORK_ARTIFACT_SENTINEL/);
  assert.match(serialized, /fresh transcript turn/);
  assert.doesNotMatch(serialized, /VOICE_HISTORY_SENTINEL/);
  assert.doesNotMatch(serialized, /VOICE_ASSISTANT_SENTINEL/);
});

test("continue preserves the bounded caller-supplied message list", () => {
  const messages = [
    { role: "user", content: "previous question" },
    { role: "assistant", content: "previous answer" },
    { role: "user", content: "current question" },
  ];
  assert.deepEqual(scopeClientMessagesForAdmission(messages, "continue", "current question"), messages);
});

test("context decision stash hard-bounds to 500 fresh dropped turns", () => {
  for (let index = 0; index < 505; index += 1) {
    stashContextDecision("stash-bound-session", `turn-${index}`, { decision: { action: "continue" }, thread: { branch_id: "default" } });
  }
  assert.equal(takeContextDecision("stash-bound-session", "turn-0"), null);
  assert.equal(takeContextDecision("stash-bound-session", "turn-4"), null);
  assert.deepEqual(takeContextDecision("stash-bound-session", "turn-5"), { decision: { action: "continue" }, thread: { branch_id: "default" } });
  assert.deepEqual(takeContextDecision("stash-bound-session", "turn-504"), { decision: { action: "continue" }, thread: { branch_id: "default" } });
});
