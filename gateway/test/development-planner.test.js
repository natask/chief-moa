"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { extractPlan, planningMessages } = require("../lib/development-planner");

test("planner extracts bare, fenced, and wrapped task graphs", () => {
  const tasks = [{ task_id: "build", title: "Build" }];
  assert.deepEqual(extractPlan(JSON.stringify(tasks)), tasks);
  assert.deepEqual(extractPlan(`\`\`\`json\n${JSON.stringify({ tasks })}\n\`\`\``), tasks);
  assert.deepEqual(extractPlan(`Result:\n${JSON.stringify({ tasks })}\nDone.`), tasks);
});

test("planner rejects missing and malformed model output", () => {
  assert.throws(() => extractPlan(""), /no task graph/);
  assert.throws(() => extractPlan("nothing useful"), /no JSON/);
  assert.throws(() => extractPlan("{broken}"), /invalid JSON/);
  assert.throws(() => extractPlan('{"answer":true}'), /must contain tasks/);
});

test("planning prompt preserves bounded riff, evidence, and release authority", () => {
  const messages = planningMessages({ intent_id: "intent", objective: "Build it", riff: "x".repeat(100_000), acceptance_criteria: ["Works"], evidence_refs: ["video-note://one"] });
  assert.match(messages[0].content, /Do not add deployment/);
  assert.match(messages[1].content, /video-note:\/\/one/);
  assert.match(messages[1].content, /\[truncated\]/);
  assert.ok(messages[1].content.length < 45_000);
});
