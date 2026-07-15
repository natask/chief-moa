"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createBrowserAgentLoopStore } = require("../lib/browser-agent-loop");

function envelope(intent, options = {}) {
  const url = options.url || "https://example.test/work";
  return {
    version: "moa.browser-delegation.v1",
    confirmation: { confirmed: true, user_intent: intent },
    goal: intent,
    scope: { page_url: url, allowed_origins: [new URL(url).origin] },
    allowed_action_classes: options.actions || ["click", "wait"],
    approval_policy: { preauthorized: options.preauthorized || ["click", "wait"], always_ask: options.alwaysAsk || [] },
    checkpoints: ["before submit"],
    stop_conditions: ["goal complete", "scope changed"],
    max_steps: 3,
    completion_evidence: ["result visible"],
  };
}

function withStore(planNext, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moa-agent-loop-policy-"));
  const store = createBrowserAgentLoopStore({ dataDir: root, planNext });
  return Promise.resolve(fn(store)).finally(() => fs.rmSync(root, { recursive: true, force: true }));
}

test("agent-loop creation requires and persists the confirmed envelope", () => withStore(null, (store) => {
  assert.throws(() => store.create({ instruction: "work", url: "https://example.test/work" }), /confirmed delegation_envelope is required/);
  const task = store.create({ instruction: "work", url: "https://example.test/work", delegation_envelope: envelope("work") });
  assert.equal(task.max_steps, 3);
  assert.equal(store.get(task.id).delegation_envelope.version, "moa.browser-delegation.v1");
}));

test("agent-loop blocks disallowed actions and out-of-scope observations", () => withStore(
  async () => ({ kind: "navigate", url: "https://evil.test/" }),
  async (store) => {
    const task = store.create({
      instruction: "work",
      url: "https://example.test/work",
      delegation_envelope: envelope("work", { actions: ["navigate"], preauthorized: ["navigate"] }),
    });
    const navigation = await store.step(task.id, { observation: { step: 0, url: "https://example.test/work" } });
    assert.equal(navigation.action.kind, "finish");
    assert.equal(navigation.action.status, "blocked");
    assert.match(navigation.action.summary, /navigation origin is outside/);

    const second = store.create({ instruction: "stay", url: "https://example.test/work", delegation_envelope: envelope("stay") });
    const scope = await store.step(second.id, { observation: { step: 0, url: "https://evil.test/" } });
    assert.equal(scope.action.status, "blocked");
    assert.match(scope.action.summary, /page origin is outside/);
  },
));
