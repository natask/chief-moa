"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  CONVERSATION_HOST_CONTRACT_VERSION,
  conversationHostContract,
  createBrokerLauncher,
} = require("../lib/broker-launcher");

function fixture(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moa-broker-launcher-"));
  const contextPacksDir = path.join(root, "context-packs");
  const launcherProfilesPath = path.join(root, "profiles.json");
  fs.mkdirSync(contextPacksDir);
  const calls = { sessions: [], starts: [], events: [], truncations: [] };
  let id = 0;
  const options = {
    launcherProfilesPath,
    contextPacksDir,
    routerDefaultHarness: "echo",
    maxAgentPromptBytes: 65536,
    durableSessionContextBlock: (input) => {
      calls.sessions.push(input);
      return `session:${input.sessionId}:${input.branchId}`;
    },
    readAgentRun: (runId) => ({ id: runId, status: "running" }),
    summarizeAgentRun: (run) => ({ id: run.id, status: run.status }),
    readAgentEvents: (runId) => Array.from({ length: 14 }, (_, index) => ({ runId, index })),
    findProject: (projectId) => ({ id: projectId, name: "Project" }),
    listAgentRuns: () => [],
    isTerminalRunStatus: (status) => ["completed", "failed", "cancelled"].includes(status),
    randomId: (prefix) => `${prefix}-${++id}`,
    truncate: (value, length) => String(value).slice(0, length),
    truncateToBytes: (value, length) => {
      calls.truncations.push(length);
      return String(value).slice(0, length);
    },
    startAgentRun: (input) => {
      calls.starts.push(input);
      return { id: "run-created", harness: input.harness, status: "queued", source: input.source, created_at: "created" };
    },
    appendAgentEvent: (...args) => calls.events.push(args),
    cleanError: (error) => `clean:${error.message}`,
    sanitizeOptionalId: (value, fallback) => String(value || "").replace(/[^a-zA-Z0-9_-]/g, "") || fallback,
    ...overrides,
  };
  return {
    calls,
    contextPacksDir,
    launcher: createBrokerLauncher(options),
    launcherProfilesPath,
    options,
    root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function withFixture(fn, overrides) {
  const value = fixture(overrides);
  return Promise.resolve(fn(value)).finally(value.cleanup);
}

function profile(id, extra = {}) {
  return {
    id,
    description: `${id} description`,
    workflow_directory: `workflows/${id}`,
    instruction_file: `workflows/${id}/WORKFLOW.md`,
    context_files: ["README.md"],
    expected_output: `${id} output`,
    verification: ["npm test"],
    ...extra,
  };
}

function event(extra = {}) {
  return {
    id: "broker-1",
    source: "test",
    text: "continue existing work",
    session_id: "session-1",
    conversation_id: "conversation-1",
    branch_id: "branch-1",
    project_id: "project-1",
    subproject_id: "subproject-1",
    profile_version: "profile-1",
    evidence_refs: ["evidence-1"],
    created_at: "created",
    ...extra,
  };
}

function decision(extra = {}) {
  return {
    id: "route-1",
    target_type: "session",
    target_id: "session-1",
    action: "continue_session",
    confidence: 0.9,
    reason: "matched",
    ...extra,
  };
}

test("launcher validates injected dependencies", () => withFixture(({ options }) => {
  assert.throws(() => createBrokerLauncher({ ...options, startAgentRun: null }), /dependencies must be functions/);
  assert.throws(() => createBrokerLauncher(), /dependencies must be functions/);
}));

test("profile loading accepts object maps and falls back for invalid files", () => withFixture(({ launcher, launcherProfilesPath }) => {
  const profiles = { qa: profile("qa") };
  fs.writeFileSync(launcherProfilesPath, JSON.stringify(profiles));
  assert.deepEqual(launcher.launcherProfiles(), profiles);

  fs.writeFileSync(launcherProfilesPath, "[]");
  const fallback = launcher.launcherProfiles();
  assert.deepEqual(Object.keys(fallback), ["direct-answer", "coding", "security", "simplification", "fuzzing"]);
  assert.ok(fallback.simplification.constraints.some((item) => /Do not merge, deploy, promote/.test(item)));
  assert.match(fallback.simplification.repair_handoff, /separate independent verifier/);
  fs.writeFileSync(launcherProfilesPath, "null");
  assert.equal(launcher.launcherProfiles()["direct-answer"].id, "direct-answer");
  fs.writeFileSync(launcherProfilesPath, "{");
  assert.equal(launcher.launcherProfiles().coding.id, "coding");
}));

test("launch flag parsing preserves aliases and accepted string values", () => withFixture(({ launcher }) => {
  for (const body of [
    { launch_agent_run: true }, { launch_agent: "true" }, { launch: "1" },
    { activate: "yes" }, { auto_launch: "agent" }, { router: { launch: "run" } },
  ]) assert.equal(launcher.launchRequested(body), true);
  for (const body of [{}, { launch: false }, { launch: null }, { launch: "no" }]) {
    assert.equal(launcher.launchRequested(body), false);
  }
}));

test("profile selection covers workflow, evidence, new-fork, and text categories", () => withFixture(({ launcher }) => {
  const profiles = Object.fromEntries([
    "direct-answer", "coding", "qa", "design", "writing", "landscape-research", "security", "simplification", "fuzzing",
  ].map((id) => [id, profile(id)]));
  assert.equal(launcher.launcherProfileForDecision(decision({ target_type: "workflow", target_id: "qa" }), event(), profiles).id, "qa");
  assert.equal(launcher.launcherProfileForDecision(decision({ action: "attach_as_evidence" }), event(), profiles).id, "coding");
  assert.equal(launcher.launcherProfileForDecision(decision({ action: "create_new_fork" }), event({ text: "verify tests" }), profiles).id, "qa");
  assert.equal(launcher.launcherProfileForDecision(decision({ action: "create_new_fork" }), event({ text: "router work" }), profiles).id, "coding");
  assert.equal(launcher.launcherProfileForDecision(decision(), event({ text: "verify the release" }), profiles).id, "qa");
  assert.equal(launcher.launcherProfileForDecision(decision(), event({ text: "design the UI" }), profiles).id, "design");
  assert.equal(launcher.launcherProfileForDecision(decision(), event({ text: "rewrite the email" }), profiles).id, "writing");
  assert.equal(launcher.launcherProfileForDecision(decision(), event({ text: "research comparison" }), profiles).id, "landscape-research");
  assert.equal(launcher.launcherProfileForDecision(decision(), event({ text: "perform a security audit" }), profiles).id, "security");
  assert.equal(launcher.launcherProfileForDecision(decision(), event({ text: "deslop and reduce loc" }), profiles).id, "simplification");
  assert.equal(launcher.launcherProfileForDecision(decision(), event({ text: "fuzz the application" }), profiles).id, "fuzzing");
  assert.equal(launcher.launcherProfileForDecision(decision(), event({ text: "hello" }), profiles).id, "direct-answer");
  assert.equal(launcher.launcherProfileForDecision(decision(), event({ text: "hello" }), { coding: profile("coding") }).id, "coding");
  assert.equal(launcher.launcherProfileForDecision(decision(), event({ text: "hello" }), {}).id, "direct-answer");
}));

test("profile normalization bounds arrays and supplies scalar defaults", () => withFixture(({ launcher }) => {
  const profiles = {
    coding: {
      id: 7,
      description: null,
      context_files: Array.from({ length: 25 }, (_, index) => index),
      constraints: Array.from({ length: 15 }, (_, index) => `constraint-${index}`),
      verification: Array.from({ length: 15 }, (_, index) => index),
      principal_role: "security",
      execution_policy: "audit_only",
      repair_handoff: "separate repair",
    },
  };
  const normalized = launcher.launcherProfileForDecision(
    decision({ action: "attach_as_evidence" }), event(), profiles,
  );
  assert.equal(normalized.id, "7");
  assert.equal(normalized.description, "");
  assert.equal(normalized.workflow_directory, "");
  assert.deepEqual(normalized.context_files.slice(0, 2), ["0", "1"]);
  assert.equal(normalized.context_files.length, 20);
  assert.equal(normalized.constraints.length, 12);
  assert.equal(normalized.principal_role, "security");
  assert.equal(normalized.execution_policy, "audit_only");
  assert.equal(normalized.repair_handoff, "separate repair");
  assert.equal(normalized.verification.length, 12);
}));

test("principal context packs carry role policy, constraints, and repair handoff", () => withFixture(({ launcher }) => {
  const security = profile("security", {
    principal_role: "security",
    execution_policy: "audit_only",
    constraints: ["Audit only; do not repair findings in this run."],
    repair_handoff: "Use a separate repair and independent verifier.",
  });
  const pack = launcher.buildContextPack(
    event({ text: "perform a security audit" }),
    decision({ target_type: "workflow", target_id: "security", action: "invoke_workflow" }),
    security,
  );
  assert.equal(pack.principal_role, "security");
  assert.equal(pack.execution_policy, "audit_only");
  assert.ok(pack.constraints.some((item) => item.startsWith("Audit only")));
  assert.equal(pack.repair_handoff, "Use a separate repair and independent verifier.");
  assert.match(pack.launcher.prompt, /Principal role: security/);
  assert.match(pack.launcher.prompt, /Execution policy: audit_only/);
  assert.match(pack.launcher.prompt, /separate repair and independent verifier/);
}));

test("checked-in simplification context is candidate-only with independent verification", () => withFixture(({ launcher }) => {
  const profiles = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "agent-launcher-profiles.json"), "utf8"));
  const selected = launcher.launcherProfileForDecision(
    decision({ target_type: "workflow", target_id: "simplification", action: "invoke_workflow" }),
    event({ text: "deslop and reduce lines of code" }),
    profiles,
  );
  const pack = launcher.buildContextPack(
    event({ text: "deslop and reduce lines of code" }),
    decision({ target_type: "workflow", target_id: "simplification", action: "invoke_workflow" }),
    selected,
  );
  assert.equal(pack.principal_role, "simplification");
  assert.equal(pack.execution_policy, "behavior_preserving_changes");
  assert.ok(pack.constraints.some((item) => /edit, test, and commit one behavior-preserving candidate/.test(item)));
  assert.ok(pack.constraints.some((item) => /Do not merge, deploy, promote, publish, push master/.test(item)));
  assert.ok(pack.constraints.some((item) => /Do not weaken, delete, skip, or bypass checks/.test(item)));
  assert.match(pack.repair_handoff, /separate independent verifier/);
  assert.match(pack.repair_handoff, /Integration, merge, push, deployment, and promotion remain coordinator-owned/);
  assert.match(pack.launcher.prompt, /Do not merge, deploy, promote, publish, push master/);
  assert.match(pack.launcher.prompt, /Do not weaken, delete, skip, or bypass checks/);
  assert.match(pack.launcher.prompt, /separate independent verifier/);
}));

test("context packs preserve bounded event, session, project, run, and active-run context", () => withFixture(({ calls, launcher, launcherProfilesPath }) => {
  fs.writeFileSync(launcherProfilesPath, JSON.stringify({ coding: profile("coding"), "direct-answer": profile("direct-answer") }));
  const runs = Array.from({ length: 13 }, (_, index) => ({
    id: index === 0 ? "target-run" : `run-${index}`,
    active: index % 2 === 0,
    status: index % 2 === 0 ? "completed" : "running",
    updated_at: String(index).padStart(2, "0"),
  }));
  const custom = fixture({ listAgentRuns: () => runs });
  try {
    fs.writeFileSync(custom.launcherProfilesPath, JSON.stringify({ coding: profile("coding"), "direct-answer": profile("direct-answer") }));
    const route = decision({ target_type: "agent_run", target_id: "target-run", action: "attach_as_evidence" });
    const pack = custom.launcher.buildContextPack(event({ text: "x".repeat(4100) }), route, profile("coding"), {
      harness: "gemini",
      all_branches_context: true,
    });
    assert.equal(pack.inputs.broker_event.text.length, 4000);
    assert.equal(pack.inputs.target_run.id, "target-run");
    assert.equal(pack.inputs.target_run_events.length, 12);
    assert.equal(pack.inputs.active_runs.some((run) => run.id === "target-run"), false);
    assert.equal(pack.inputs.active_runs.length, 10);
    assert.equal(pack.conversation_host.version, CONVERSATION_HOST_CONTRACT_VERSION);
    assert.equal(pack.conversation_host.speaker_owner, "conversation_host");
    assert.equal(pack.conversation_host.handoff.session_context_attached, true);
    assert.deepEqual(pack.conversation_host.handoff.active_run_ids.slice(0, 2), ["target-run", "run-12"]);
    assert.equal(pack.conversation_host.control.stop_speaking, "revoke_current_output_only");
    assert.equal(pack.conversation_host.control.cancel_run, "explicit_targeted_run_control_only");
    assert.equal(pack.inputs.project.id, "project-1");
    assert.equal(pack.launcher.harness, "gemini");
    assert.match(pack.launcher.prompt, /Target agent run:/);
    assert.match(pack.launcher.prompt, /Project context:/);
    assert.match(pack.launcher.prompt, /Conversation host contract:/);
    assert.match(pack.launcher.prompt, /gateway_run_events_only/);
    assert.match(pack.launcher.prompt, /Worker agents must publish progress and results/);
    assert.match(pack.launcher.prompt, /Preserve the user's in-progress draft/);
    assert.equal(custom.calls.sessions[0].allBranches, true);
    assert.equal(custom.calls.truncations[0], 60000);
  } finally {
    custom.cleanup();
  }
  assert.deepEqual(calls.sessions, []);
}));

test("conversation host is stable across fresh launcher turns and keeps output control separate from run control", () => {
  const first = conversationHostContract(
    event({ id: "broker-first", branch_id: "branch-a" }),
    "prior conversation summary",
    null,
    [{ id: "run-a" }],
  );
  const next = conversationHostContract(
    event({ id: "broker-next", branch_id: "branch-a" }),
    "updated conversation summary",
    null,
    [{ id: "run-a" }, { id: "run-b" }],
  );

  assert.equal(first.host_id, "aggie");
  assert.equal(next.host_id, first.host_id);
  assert.equal(next.launcher_lifetime, "turn_scoped");
  assert.equal(next.state_source, "gateway_session_run_event_store");
  assert.deepEqual(next.handoff.active_run_ids, ["run-a", "run-b"]);
  assert.equal(next.presentation.background_completion, "queue_for_host");
  assert.equal(next.presentation.while_user_drafting, "preserve_draft_and_defer_speech");
  assert.equal(next.control.start_new_turn, "supersede_current_output_preserve_detached_runs");
});

test("context helpers fail soft when session, run, or project state is unavailable", () => withFixture(({ launcher }) => {
  const custom = fixture({
    readAgentRun: () => { throw new Error("missing run"); },
    findProject: () => { throw new Error("missing project"); },
  });
  try {
    const noContext = custom.launcher.buildContextPack(
      event({ session_id: "", conversation_id: "", project_id: "", branch_id: "" }),
      decision({ target_type: "agent_run", target_id: "run" }),
      profile("direct-answer", {
        description: "", workflow_directory: "", instruction_file: "",
        context_files: [], verification: [], expected_output: "",
      }),
    );
    assert.equal(noContext.inputs.session_context, "");
    assert.equal(noContext.inputs.target_run, null);
    assert.deepEqual(noContext.inputs.target_run_events, []);
    assert.equal(noContext.inputs.project, null);
    assert.doesNotMatch(noContext.launcher.prompt, /Bounded session context:/);
    assert.match(noContext.launcher.prompt, /Complete the selected workflow/);
    assert.equal(custom.launcher.projectContext(event(), decision({ target_type: "project", target_id: "missing" })), null);
  } finally {
    custom.cleanup();
  }
  assert.deepEqual(launcher.runContext(decision()), { target_run: null, target_run_events: [] });
  assert.equal(launcher.projectContext(event({ project_id: "" }), decision()), null);
  assert.equal(launcher.activeRunSummaries(decision()).length, 0);
}));

test("context construction uses body and conversation fallbacks", () => withFixture(({ calls, launcher }) => {
  const pack = launcher.buildContextPack(
    event({
      text: "", session_id: "", conversation_id: "conversation-only", branch_id: "",
      project_id: "", subproject_id: "", profile_version: "", evidence_refs: null,
    }),
    decision({ target_type: "project", target_id: "project-target", reason: "" }),
    profile("direct-answer", { description: "", context_files: [], verification: [] }),
    { branch_id: "body-branch" },
  );
  assert.equal(calls.sessions[0].sessionId, "conversation-only");
  assert.equal(calls.sessions[0].branchId, "body-branch");
  assert.equal(pack.inputs.project.id, "project-target");
  assert.deepEqual(pack.inputs.broker_event.evidence_refs, []);
  assert.equal(pack.launcher.harness, "echo");
  assert.match(pack.launcher.prompt, /project:project-target/);
}));

test("context-pack assembly excludes dismissals and annotates retained decisions", () => withFixture(({ launcher, launcherProfilesPath }) => {
  fs.writeFileSync(launcherProfilesPath, JSON.stringify({ "direct-answer": profile("direct-answer") }));
  const retained = decision();
  const dismissed = decision({ id: "dismiss", action: "dismiss_irrelevant" });
  const packs = launcher.contextPacksForDecisions(event(), [retained, dismissed], { branch_id: "body-branch" });
  assert.equal(packs.length, 1);
  assert.equal(retained.context_pack_id, packs[0].id);
  assert.equal(retained.launcher_profile_id, "direct-answer");
  assert.equal(retained.workflow_directory, "workflows/direct-answer");
  assert.equal(dismissed.context_pack_id, undefined);
}));

test("launch handling covers disabled, irrelevant, and blocked requests", () => withFixture(({ launcher }) => {
  assert.deepEqual(launcher.launchRunsIfRequested(event(), [decision()], [], {}), []);
  assert.deepEqual(launcher.launchRunsIfRequested(event(), [decision()], [], { launch: true }), []);

  const missing = decision({ action: "create_new_fork" });
  const blockedMissing = launcher.launchRunsIfRequested(event(), [missing], [], { launch: true });
  assert.equal(blockedMissing[0].status, "blocked");
  assert.equal(missing.launch, blockedMissing[0]);

  const route = decision({ action: "invoke_workflow" });
  const pack = { id: "pack", route_decision_id: route.id, launcher_profile_id: "qa" };
  const blockedPack = launcher.launchRunsIfRequested(event(), [route], [pack], { launch: true });
  assert.equal(pack.launch_result, blockedPack[0]);
}));

test("successful launch binds run, decision, pack, and activation event", () => withFixture(({ calls, launcher }) => {
  const route = decision({ action: "create_new_fork", context_pack_id: "pack", launcher_profile_id: "coding" });
  const pack = {
    id: "pack",
    route_decision_id: route.id,
    launcher_profile_id: "coding",
    workflow_directory: "workflow",
    instruction_file: "workflow/WORKFLOW.md",
    launcher: { prompt: "prompt", harness: "gemini", source: "custom-source" },
  };
  const launches = launcher.launchRunsIfRequested(event(), [route], [pack], { launch_agent: true, cwd: "/tmp/work" });
  assert.equal(launches[0].status, "launched");
  assert.equal(launches[0].agent_run_id, "run-created");
  assert.equal(route.launch, launches[0]);
  assert.equal(pack.launch_result, launches[0]);
  assert.equal(calls.starts[0].conversation_id, "conversation-1");
  assert.equal(calls.starts[0].session_id, "session-1");
  assert.equal(calls.starts[0].working_dir, "/tmp/work");
  assert.deepEqual(calls.events[0].slice(0, 2), ["run-created", "broker_activated"]);
}));

test("failed launches are cleaned and attached to both route and pack", () => withFixture(({ launcher }) => {
  const custom = fixture({ startAgentRun: () => { throw new Error("provider secret"); } });
  try {
    const route = decision({ action: "create_new_fork" });
    const pack = { id: "pack", route_decision_id: route.id, launcher: { prompt: "prompt", harness: "echo" } };
    const launches = custom.launcher.launchRunsIfRequested(event(), [route], [pack], { activate: true, working_dir: "/work" });
    assert.equal(launches[0].status, "failed");
    assert.equal(launches[0].error, "clean:provider secret");
    assert.equal(route.launch, launches[0]);
    assert.equal(pack.launch_result, launches[0]);
  } finally {
    custom.cleanup();
  }
  assert.ok(launcher);
}));

test("context-pack persistence sanitizes names and atomically writes JSON", () => withFixture(({ contextPacksDir, launcher }) => {
  launcher.writeContextPacks([{ id: "pack/one", value: 1 }, { id: "pack-two", value: 2 }]);
  assert.deepEqual(fs.readdirSync(contextPacksDir).sort(), ["pack-two.json", "packone.json"]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(contextPacksDir, "packone.json"), "utf8")).value, 1);
}));
