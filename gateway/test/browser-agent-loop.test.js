"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  ACTION_KINDS,
  AGENT_SYSTEM_PROMPT,
  buildAgentToolDefs,
  buildPlannerContext,
  createBrowserAgentLoopStore,
  deterministicFallbackAction,
  observationForHistory,
  sanitizeAgentAction,
  sanitizeObservation,
} = require("../lib/browser-agent-loop");

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

test("sanitizes every declarative action shape", () => {
  assert.equal(ACTION_KINDS.length, 10);
  assert.equal(sanitizeAgentAction(null), null);
  assert.equal(sanitizeAgentAction([]), null);
  assert.equal(sanitizeAgentAction({ kind: "unknown" }), null);
  assert.deepEqual(sanitizeAgentAction({ action: "CLICK", index: "4" }), { kind: "click", index: 4 });
  assert.deepEqual(sanitizeAgentAction({ kind: "clear", index: 0 }), { kind: "clear", index: 0 });
  assert.equal(sanitizeAgentAction({ kind: "click", index: -1 }), null);
  assert.equal(sanitizeAgentAction({ kind: "clear", index: 100001 }), null);
  assert.deepEqual(sanitizeAgentAction({ kind: "type", index: 2, text: "x".repeat(2100) }), { kind: "type", index: 2, text: `${"x".repeat(2000)}...` });
  assert.equal(sanitizeAgentAction({ kind: "type", index: 2.5 }), null);
  assert.deepEqual(sanitizeAgentAction({ kind: "select", index: 3, text: "choice" }), { kind: "select", index: 3, text: "choice" });
  assert.equal(sanitizeAgentAction({ kind: "select" }), null);
  assert.deepEqual(sanitizeAgentAction({ kind: "scroll", direction: " UP " }), { kind: "scroll", direction: "up" });
  assert.equal(sanitizeAgentAction({ kind: "scroll", direction: "sideways" }), null);
  assert.deepEqual(sanitizeAgentAction({ kind: "navigate", url: "https://example.test/a" }), { kind: "navigate", url: "https://example.test/a" });
  assert.equal(sanitizeAgentAction({ kind: "navigate", url: "javascript:alert(1)" }), null);
  assert.equal(sanitizeAgentAction({ kind: "navigate", url: "not a url" }), null);
  assert.deepEqual(sanitizeAgentAction({ kind: "key", key: "Enter" }), { kind: "key", text: "Enter" });
  assert.equal(sanitizeAgentAction({ kind: "key" }), null);
  assert.deepEqual(sanitizeAgentAction({ kind: "wait" }), { kind: "wait" });
  assert.deepEqual(sanitizeAgentAction({ kind: "screenshot" }), { kind: "screenshot" });
  assert.deepEqual(sanitizeAgentAction({ kind: "finish" }), { kind: "finish", status: "done", summary: "" });
  assert.deepEqual(sanitizeAgentAction({ kind: "finish", status: "blocked", summary: "help" }), { kind: "finish", status: "blocked", summary: "help" });
  assert.equal(sanitizeAgentAction({ kind: "finish", status: "failed" }).status, "done");
});

test("bounds observations and strips screenshots from history", () => {
  assert.deepEqual(sanitizeObservation(null), {
    url: "", title: "", elements: [], page_text: "", screenshot: null,
    last_action: null, last_action_result: "", step: null,
  });
  const elements = Array.from({ length: 105 }, (_, i) => i === 1 ? null : {
    index: i,
    tag: "button",
    type: "submit",
    text: "label".repeat(30),
  });
  const observation = sanitizeObservation({
    url: "u".repeat(1100),
    title: "t".repeat(350),
    elements,
    page_text: "p".repeat(6100),
    screenshot: { encoding: "base64_jpeg", data: "jpeg-data" },
    last_action: { kind: "wait" },
    last_action_result: "r".repeat(600),
    step: 3,
  });
  assert.equal(observation.elements.length, 99);
  assert.equal(observation.elements[0].i, 0);
  assert.equal(observation.url.length, 1003);
  assert.equal(observation.page_text.length, 6003);
  assert.deepEqual(observationForHistory(observation).screenshot, { encoding: "stored_on_task" });
  assert.equal(observationForHistory({ ...observation, screenshot: { encoding: "omitted", reason: "nope" } }).screenshot.reason, "nope");
  assert.deepEqual(sanitizeObservation({ screenshot: { encoding: "base64_jpeg", data: "" } }).screenshot, { encoding: "omitted", reason: "no screenshot data" });
  assert.match(sanitizeObservation({ screenshot: { encoding: "base64_jpeg", data: "x".repeat(420 * 1024 + 1) } }).screenshot.reason, /too large/);
  assert.equal(sanitizeObservation({ screenshot: { reason: "custom" } }).screenshot.reason, "custom");
  assert.equal(sanitizeObservation({ elements: "bad", step: -1 }).step, null);
});

test("builds bounded text-only planner context and captures only the first tool call", async () => {
  const steps = Array.from({ length: 10 }, (_, step) => ({
    step,
    observation: { title: step === 0 ? "Older page" : "", url: step === 1 ? "https://old.test" : "" },
    action: step === 9 ? { kind: "finish", status: "blocked", summary: "Need user help" } : { kind: "wait" },
  }));
  const context = buildPlannerContext({ instruction: "Complete work", url: "https://start.test", steps }, sanitizeObservation({
    url: "https://current.test",
    title: "Current",
    elements: [{ i: 2, tag: "input", type: "text", label: "Name" }],
    page_text: "Visible text",
    last_action: { kind: "type", index: 2, text: "Nat" },
    last_action_result: "ok",
  }));
  assert.equal(context.system, AGENT_SYSTEM_PROMPT);
  assert.match(context.userText, /Earlier steps:/);
  assert.match(context.userText, /Recent steps:/);
  assert.match(context.userText, /summary: Need user help/);
  assert.match(context.userText, /Last action: type -> ok/);
  assert.match(context.userText, /\[2\] input\/text "Name"/);
  assert.match(context.userText, /Page text:/);
  assert.doesNotMatch(context.userText, /base64/);

  const capture = {};
  const tools = buildAgentToolDefs(capture);
  assert.deepEqual(await tools[0].handler({ kind: "click", index: 2 }), { ok: true, captured: true });
  await tools[1].handler({ status: "blocked", summary: "later" });
  assert.deepEqual(capture.action, { kind: "click", index: 2, text: undefined, direction: undefined, url: undefined });
  const finishCapture = {};
  await buildAgentToolDefs(finishCapture)[1].handler(null);
  assert.deepEqual(finishCapture.action, { kind: "finish", status: "done", summary: "" });
  assert.deepEqual(deterministicFallbackAction(0, {}), { kind: "wait" });
  assert.match(deterministicFallbackAction(1, { title: "Page" }).summary, /Page/);
  assert.match(deterministicFallbackAction(2, { url: "https://fallback.test" }).summary, /fallback/);
  assert.match(deterministicFallbackAction(3, {}).summary, /the page/);
});

test("creates, claims, lists, summarizes, and recovers persisted tasks", async (t) => {
  assert.throws(() => createBrowserAgentLoopStore(), /requires a dataDir/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moa-agent-loop-store-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createBrowserAgentLoopStore({ dataDir: root });
  assert.throws(() => store.create(), /instruction is required/);
  assert.throws(() => store.create({ instruction: "x", role: "orchestrator", delegation_envelope: envelope("x") }), /browser agent role/);
  assert.throws(() => store.create({ instruction: "x", role: "help", delegation_envelope: envelope("x") }), /delegate role/);
  const first = store.create({
    prompt: " first task ",
    url: "https://example.test/one",
    source: "test",
    conversation_id: "conv!1",
    branch_id: "!!!",
    agent_run_id: "run!1",
    turn_id: "turn!1",
    delegation_envelope: envelope("first task", { url: "https://example.test/one" }),
  });
  await new Promise((resolve) => setTimeout(resolve, 2));
  const second = store.create({ task: "second task", delegation_envelope: envelope("second task") });
  assert.equal(store.healthCounts().pending, 2);
  const claimed = store.claim("");
  assert.equal(claimed.claimed_by, "agee-extension");
  assert.equal(store.healthCounts().active, 1);
  assert.equal(store.list({ status: "pending", limit: 0 }).length, 1);
  assert.equal(store.list({ limit: 500 }).length, 2);
  assert.equal(store.get(first.id).branch_id, "default");
  assert.equal(store.get("missing"), null);

  const claimedPath = path.join(store.dir, `${claimed.id}.json`);
  const expired = JSON.parse(fs.readFileSync(claimedPath, "utf8"));
  expired.lease_expires_at = new Date(Date.now() - 1000).toISOString();
  fs.writeFileSync(claimedPath, JSON.stringify(expired));
  assert.equal(store.claim("extension-2").id, claimed.id);
  for (const task of store.list()) store.finish(task.id, { status: "done" });
  assert.equal(store.claim("none"), null);

  fs.writeFileSync(path.join(store.dir, "broken.json"), "{");
  fs.writeFileSync(path.join(store.dir, "ignored.tmp"), "{}");
  assert.equal(store.list().length, 2);
  assert.equal(store.getRecord("broken"), null);
  fs.rmSync(store.dir, { recursive: true, force: true });
  assert.deepEqual(store.list(), []);
});

test("steps with planner actions, fallback, screenshots, limits, and terminal guards", () => withStore(
  async ({ observation }) => {
    if (observation.title === "throw") throw new Error("planner offline");
    if (observation.title === "invalid") return { kind: "click", index: -1 };
    if (observation.title === "finish") return { kind: "finish", status: "done", summary: "complete" };
    return { kind: "click", index: 0 };
  },
  async (store) => {
    assert.deepEqual(await store.step("missing"), { error: "browser agent task not found", code: 404 });
    const task = store.create({ instruction: "work", delegation_envelope: envelope("work") });
    const clicked = await store.step(task.id, { observation: { title: "click", elements: [{ i: 0, tag: "button" }], screenshot: { encoding: "base64_jpeg", data: "jpeg" } } });
    assert.equal(clicked.action.kind, "click");
    assert.equal(store.get(task.id).has_screenshot, true);
    const fallback = await store.step(task.id, { observation: { title: "throw" } });
    assert.equal(fallback.action.kind, "finish");
    const invalid = await store.step(task.id, { observation: { step: 0, title: "invalid" } });
    assert.equal(invalid.action.kind, "wait");
    const limited = await store.step(task.id, { observation: { step: 3 } });
    assert.equal(limited.action.status, "blocked");

    const finishing = store.create({ instruction: "finish", delegation_envelope: envelope("finish") });
    assert.equal((await store.step(finishing.id, { title: "finish" })).done, true);
    store.finish(finishing.id, { status: "cancelled", summary: "cancelled" });
    assert.deepEqual(await store.step(finishing.id), { error: "browser agent task already cancelled", code: 409 });
  },
));

test("finishes task status variants and reports health counts", () => withStore(null, async (store) => {
  assert.deepEqual(store.finish("missing"), { error: "browser agent task not found", code: 404 });
  const failed = store.create({ instruction: "fail", delegation_envelope: envelope("fail") });
  const failedResult = store.finish(failed.id, { status: "failed" });
  assert.equal(failedResult.task.error, "browser agent task failed");
  const done = store.create({ instruction: "done", agent_run_id: "run-1", delegation_envelope: envelope("done") });
  const doneResult = store.finish(done.id, { status: "unexpected", summary: "ok" });
  assert.equal(doneResult.status, "done");
  assert.equal(doneResult.agent_run_id, "run-1");
  const cancelled = store.create({ instruction: "cancel", delegation_envelope: envelope("cancel") });
  assert.equal(store.finish(cancelled.id, { status: "cancelled" }).status, "cancelled");
  assert.deepEqual(store.healthCounts(), { pending: 0, active: 0 });
}));
