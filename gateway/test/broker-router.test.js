"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createBrokerRouter,
  looksLikeNewWork,
  meaningfulTokens,
  textOverlapScore,
  workflowRecommendation,
} = require("../lib/broker-router");

function makeRouter(overrides = {}) {
  let nextId = 0;
  return createBrokerRouter({
    listSessions: () => [],
    listProjects: () => [],
    listAgentRuns: () => [],
    isTerminalRunStatus: (status) => ["completed", "failed", "cancelled"].includes(status),
    randomId: (prefix) => `${prefix}-${++nextId}`,
    sanitizeOptionalId: (value, fallback) => {
      const safe = String(value || "").replace(/[^a-zA-Z0-9_-]/g, "");
      return safe || fallback || `generated-${++nextId}`;
    },
    ...overrides,
  });
}

test("router validates every injected dependency", () => {
  const valid = {
    listSessions() {},
    listProjects() {},
    listAgentRuns() {},
    isTerminalRunStatus() {},
    randomId() {},
    sanitizeOptionalId() {},
  };
  for (const name of Object.keys(valid)) {
    assert.throws(() => createBrokerRouter({ ...valid, [name]: null }), /dependencies must be functions/);
  }
});

test("workflow recommendation preserves category priority and confidence", () => {
  assert.deepEqual(workflowRecommendation("fuzz the application with adversarial tests"), {
    id: "fuzzing",
    confidence: 0.88,
    reason: "message explicitly asks for fuzzing or adversarial application testing",
  });
  assert.equal(workflowRecommendation("find security holes with a security audit").id, "security");
  assert.equal(workflowRecommendation("launch the security principal").id, "security");
  assert.equal(workflowRecommendation("deslop and reduce the lines of code").id, "simplification");
  assert.equal(workflowRecommendation("reducing lines of code and re-architecting modules").id, "simplification");
  assert.equal(workflowRecommendation("leveling code quality").id, "simplification");
  assert.equal(workflowRecommendation("security fuzzing before ordinary tests").id, "fuzzing");
  assert.deepEqual(workflowRecommendation("research and compare tests"), {
    id: "landscape-research",
    confidence: 0.82,
    reason: "message asks for research/search/comparison/report workflow",
  });
  assert.equal(workflowRecommendation("please validate the release").id, "qa");
  assert.equal(workflowRecommendation("design the frontend layout").id, "design");
  assert.equal(workflowRecommendation("implement the bug fix").id, "coding");
  assert.equal(workflowRecommendation("rewrite this email").id, "writing");
  assert.equal(workflowRecommendation("hello there"), null);
});

test("token helpers normalize, filter, bound, and score overlap", () => {
  assert.deepEqual(meaningfulTokens("The QUICK, fox and tiny ox from qa"), ["quick", "fox", "tiny"]);
  assert.equal(meaningfulTokens(Array.from({ length: 130 }, (_, index) => `word${index}`).join(" ")).length, 120);
  assert.equal(textOverlapScore("", "alpha beta gamma"), 0);
  assert.equal(textOverlapScore("alpha beta gamma", ""), 0);
  assert.equal(textOverlapScore("alpha beta gamma delta", "alpha beta gamma delta echo"), 1);
  assert.equal(textOverlapScore("alpha beta gamma delta", "alpha zulu yankee xray"), 0.25);
  assert.equal(looksLikeNewWork("start another separate fork"), true);
  assert.equal(looksLikeNewWork("continue existing work"), false);
});

test("decision creation applies defaults and clamps confidence", () => {
  const router = makeRouter();
  const low = router.decision({ targetType: "session", targetId: 0, action: "noop", confidence: -2 });
  const high = router.decision({
    targetType: "project",
    targetId: "project",
    action: "attach",
    confidence: 9,
    reason: "because",
    contextRefs: [{ type: "project", id: "project" }],
    cancellation: "cancel",
  });
  assert.equal(low.confidence, 0);
  assert.equal(low.target_id, "");
  assert.deepEqual(low.context_refs, []);
  assert.equal(low.cancellation_behavior, "none");
  assert.match(low.created_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(high.confidence, 1);
  assert.equal(high.reason, "because");
  assert.equal(high.cancellation_behavior, "cancel");
});

test("explicit session, project, and sanitized run IDs receive strongest routes", () => {
  const sanitizerCalls = [];
  const router = makeRouter({
    listSessions: () => [{ session_id: "session-1", branch_id: "branch-1", latest_transcript: "unrelated" }],
    listProjects: () => [{ id: "project-1", name: "Unrelated" }],
    listAgentRuns: () => [{ id: "runone", status: "running", active: true }],
    sanitizeOptionalId: (value, fallback) => {
      sanitizerCalls.push([value, fallback]);
      return String(value).replace(/[^a-zA-Z0-9_-]/g, "");
    },
  });
  const decisions = router.routeDecisions(
    { id: "event", text: "hello", session_id: "session-1", project_id: "project-1" },
    { agent_run_id: "run/one" },
  );
  assert.deepEqual(decisions.map((item) => [item.target_type, item.confidence]), [
    ["agent_run", 0.99],
    ["session", 0.98],
    ["project", 0.98],
  ]);
  assert.match(decisions[0].reason, /carried this agent_run_id/);
  assert.deepEqual(sanitizerCalls, [["run/one", ""]]);
});

test("overlap routes sessions, projects, and nonterminal runs without explicit IDs", () => {
  const router = makeRouter({
    listSessions: () => [{ session_id: "session", branch_id: "branch", latest_transcript: "alpha beta gamma delta" }],
    listProjects: () => [{ id: "project", name: "alpha beta gamma delta" }],
    listAgentRuns: () => [
      { id: "active", status: "running", active: false, prompt_preview: "alpha beta gamma delta" },
      { id: "terminal", status: "completed", active: false, prompt_preview: "alpha beta gamma delta" },
    ],
  });
  const decisions = router.routeDecisions({ id: "event", text: "alpha beta gamma delta" });
  assert.deepEqual(decisions.map((item) => item.target_type), ["session", "project", "agent_run"]);
  assert.match(decisions[0].reason, /overlaps recent session/);
  assert.match(decisions[1].reason, /known project name/);
  assert.match(decisions[2].reason, /active run context/);
});

test("broadcasts attach relevant runs and leave irrelevant active runs unchanged", () => {
  const router = makeRouter({
    listAgentRuns: () => [
      { id: "relevant", status: "running", active: true, prompt_preview: "notify all agents about alpha beta gamma" },
      { id: "irrelevant", status: "running", active: true, prompt_preview: "zulu yankee xray" },
    ],
  });
  const decisions = router.routeDecisions({ id: "event", text: "notify all agents about alpha beta gamma" });
  assert.deepEqual(decisions.map((item) => item.action), ["attach_as_evidence", "dismiss_irrelevant"]);
  assert.match(decisions[0].reason, /broadcast overlaps/);
  assert.equal(decisions[1].confidence, 0.1);

  const bodyBroadcast = router.routeDecisions({ id: "other", text: "plain words" }, { fanout_all_active: true });
  assert.equal(bodyBroadcast.filter((item) => item.action === "dismiss_irrelevant").length, 2);

  const phraseBroadcast = router.routeDecisions({ id: "phrase", text: "update all active agent forks" });
  assert.equal(phraseBroadcast.some((item) => item.action === "dismiss_irrelevant"), true);
});

test("missing optional context fields fail soft", () => {
  const router = makeRouter({
    listSessions: () => [{ session_id: "session" }],
    listProjects: () => [{ id: "project" }],
    listAgentRuns: () => [{ id: "run", status: "running" }],
  });
  const decisions = router.routeDecisions({ id: "event" });
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].action, "create_new_fork");
});

test("workflow and new-work routing preserve fork fallback behavior", () => {
  const router = makeRouter();
  const workflow = router.routeDecisions({ id: "event", text: "please verify this" });
  assert.deepEqual(workflow.map((item) => [item.target_type, item.action]), [["workflow", "invoke_workflow"]]);

  const fallback = router.routeDecisions({ id: "fallback", text: "hello there", session_id: "provided-session" });
  assert.equal(fallback[0].target_id, "provided-session");
  assert.equal(fallback[0].confidence, 0.62);

  const distinct = router.routeDecisions({ id: "new", text: "start a new test" });
  assert.deepEqual(distinct.map((item) => item.action), ["invoke_workflow", "create_new_fork"]);
  assert.equal(distinct[1].confidence, 0.48);
  assert.match(distinct[1].target_id, /^session-/);

  for (const [text, target] of [
    ["run a security review for vulnerabilities", "security"],
    ["simplify this code with behavior-preserving refactoring", "simplification"],
    ["start fuzzing the application", "fuzzing"],
  ]) {
    const routed = router.routeDecisions({ id: target, text });
    assert.equal(routed[0].target_type, "workflow");
    assert.equal(routed[0].target_id, target);
    assert.equal(routed[0].action, "invoke_workflow");
  }
});

test("result caps retain the strongest twelve primary routes and twenty-five dismissals", () => {
  const sessions = Array.from({ length: 20 }, (_, index) => ({
    session_id: `session-${index}`,
    branch_id: `branch-${index}`,
    latest_transcript: "alpha beta gamma delta",
  }));
  const runs = Array.from({ length: 30 }, (_, index) => ({
    id: `run-${index}`,
    status: "running",
    active: true,
    prompt_preview: "zulu yankee xray",
  }));
  const router = makeRouter({ listSessions: () => sessions, listAgentRuns: () => runs });
  const decisions = router.routeDecisions({ id: "event", text: "tell every agent alpha beta gamma delta" });
  assert.equal(decisions.filter((item) => item.action !== "dismiss_irrelevant").length, 12);
  assert.equal(decisions.filter((item) => item.action === "dismiss_irrelevant").length, 25);
  assert.equal(decisions.length, 37);
});
