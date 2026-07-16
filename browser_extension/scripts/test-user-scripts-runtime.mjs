import assert from "node:assert/strict";
import test from "node:test";
import {
  CAPABILITY_STATES,
  DELEGATED_OPT_IN_KEY,
  DELEGATED_PROFILE,
  EXECUTION_HISTORY_KEY,
  IDEMPOTENCY_STORE_KEY,
  PROGRAM_STORE_KEY,
  RECEIPT_STORE_KEY,
  REVIEWED_OPT_IN_KEY,
  REVIEWED_PROFILE,
  createUserScriptsRuntime,
  programScopeDigest,
  sourceDigest,
} from "../extension/user-scripts-runtime.js";

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function createHarness({ enabled = false, delegated = false, permission = true, toggleError = null, supported = true, chromeMajor = null } = {}) {
  const values = {
    [REVIEWED_OPT_IN_KEY]: enabled,
    [DELEGATED_OPT_IN_KEY]: delegated,
  };
  const registrations = new Map();
  const calls = { execute: [], register: [], update: [], unregister: [], getScripts: [] };
  const storage = {
    async get(query) {
      if (typeof query === "string") return { [query]: clone(values[query]) };
      if (Array.isArray(query)) {
        return Object.fromEntries(query.filter((key) => key in values).map((key) => [key, clone(values[key])]));
      }
      const result = {};
      for (const [key, fallback] of Object.entries(query || {})) result[key] = key in values ? clone(values[key]) : clone(fallback);
      return result;
    },
    async set(patch) {
      Object.assign(values, clone(patch));
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
    },
  };
  const userScripts = supported ? {
    async getScripts(filter) {
      calls.getScripts.push(clone(filter));
      if (toggleError) throw new Error(toggleError);
      const ids = filter?.ids;
      return [...registrations.values()].filter((record) => !ids || ids.includes(record.id)).map(clone);
    },
    async execute(injection) {
      calls.execute.push(clone(injection));
      return [{ frameId: 0, result: "ok" }];
    },
    async register(scripts) {
      calls.register.push(clone(scripts));
      for (const script of scripts) registrations.set(script.id, clone(script));
    },
    async update(scripts) {
      calls.update.push(clone(scripts));
      for (const script of scripts) registrations.set(script.id, clone(script));
    },
    async unregister({ ids }) {
      calls.unregister.push(clone(ids));
      for (const id of ids) registrations.delete(id);
    },
  } : undefined;
  const chromeApi = {
    storage: { local: storage },
    runtime: { getManifest: () => ({ permissions: ["userScripts"] }) },
    permissions: {
      async contains(request) {
        if (request.permissions?.includes("userScripts")) return permission;
        if (request.origins) return permission;
        return false;
      },
    },
    userScripts,
  };
  return {
    calls,
    chromeApi,
    registrations,
    runtime: createUserScriptsRuntime({ chromeApi, chromeMajor, now: () => new Date("2026-07-15T12:00:00.000Z") }),
    storage,
    values,
  };
}

async function reviewedProgram({ revision = 1, source = "document.body.dataset.moa = 'on';", world = "USER_SCRIPT", mode = "persistent", target, runAt = "document_idle" } = {}) {
  const normalizedTarget = target || (mode === "persistent" ? {
    tab_id: null,
    document_id: null,
    frame_scope: "top",
    origins: ["https://example.test"],
    matches: ["https://example.test/*"],
    excludes: ["https://example.test/private/*"],
  } : {
    tab_id: 7,
    document_id: "doc-7",
    frame_scope: "top",
    origins: ["https://example.test"],
    matches: [],
    excludes: [],
  });
  const program = {
    schema: "moa.browser-program.v2",
    artifact_id: "script-demo",
    revision,
    name: "Demo",
    purpose: "Test exact script authority",
    source,
    source_sha256: await sourceDigest(source),
    mode,
    world,
    run_at: runAt,
    target: normalizedTarget,
    authority: null,
  };
  program.authority = {
    profile: REVIEWED_PROFILE,
    standalone: {
      approval_id: `approval-${revision}`,
      approved_source_sha256: program.source_sha256,
      approved_scope_digest: await programScopeDigest(program),
    },
  };
  return program;
}

function reviewedAuthorization(program) {
  return {
    approval: {
      approval_id: program.authority.standalone.approval_id,
      source_sha256: program.source_sha256,
      scope_digest: program.authority.standalone.approved_scope_digest,
      current: true,
    },
  };
}

async function delegatedImmediate({ world = "USER_SCRIPT" } = {}) {
  const source = "document.documentElement.dataset.delegated = 'yes';";
  return {
    schema: "moa.browser-program.v2",
    artifact_id: "delegated-demo",
    revision: 1,
    source,
    source_sha256: await sourceDigest(source),
    mode: "immediate",
    world,
    run_at: "document_idle",
    target: {
      tab_id: 9,
      document_id: "doc-9",
      frame_scope: "top",
      origins: ["https://example.test"],
      matches: [],
      excludes: [],
    },
    authority: {
      profile: DELEGATED_PROFILE,
      delegated: {
        role: "delegate",
        task_id: "task-1",
        run_id: "run-1",
        delegation_envelope_id: "envelope-1",
        grant_ids: ["grant-script-evaluate"],
      },
    },
  };
}

function delegatedAuthorization(program, mainWorld = false) {
  return {
    delegated: {
      role: "delegate",
      task_id: "task-1",
      run_id: "run-1",
      delegation_envelope_id: "envelope-1",
      current: true,
      grant_bindings: [{
        grant_id: "grant-script-evaluate",
        effect_class: "script.evaluate",
        target: {
          tab_id: program.target.tab_id,
          document_id: program.target.document_id,
          frame_scope: "top",
          origins: [...program.target.origins],
          matches: [],
          excludes: [],
        },
        world: mainWorld ? "MAIN" : "USER_SCRIPT",
        current: true,
      }],
    },
  };
}

test("fresh install is disabled and creates zero user-script registrations", async () => {
  const harness = createHarness();
  assert.deepEqual(await harness.runtime.capability(REVIEWED_PROFILE), {
    state: CAPABILITY_STATES.DISABLED,
    profile: REVIEWED_PROFILE,
  });
  assert.equal(harness.calls.register.length, 0);
  assert.equal(harness.calls.execute.length, 0);
  assert.equal(harness.registrations.size, 0);
});

test("capability probe distinguishes unsupported, permission revoked, Chrome toggle, and available", async () => {
  assert.equal((await createHarness({ enabled: true, supported: false }).runtime.capability(REVIEWED_PROFILE)).state, CAPABILITY_STATES.UNSUPPORTED);
  assert.equal((await createHarness({ enabled: true, supported: false, chromeMajor: 143 }).runtime.capability(REVIEWED_PROFILE)).state, CAPABILITY_STATES.CHROME_TOGGLE_REQUIRED);
  assert.equal((await createHarness({ enabled: true, permission: false }).runtime.capability(REVIEWED_PROFILE)).state, CAPABILITY_STATES.PERMISSION_REVOKED);
  assert.equal((await createHarness({ enabled: true, toggleError: "User scripts are not allowed" }).runtime.capability(REVIEWED_PROFILE)).state, CAPABILITY_STATES.CHROME_TOGGLE_REQUIRED);
  assert.equal((await createHarness({ enabled: true }).runtime.capability(REVIEWED_PROFILE)).state, CAPABILITY_STATES.AVAILABLE);
});

test("digest, scope, timing, and reviewed MAIN-world drift are rejected before Chrome registration", async () => {
  const harness = createHarness({ enabled: true });
  const digestDrift = await reviewedProgram();
  digestDrift.source += "// changed";
  assert.equal((await harness.runtime.register(digestDrift, reviewedAuthorization(digestDrift))).reason, "source_digest_mismatch");

  const scopeDrift = await reviewedProgram({ target: {
    frame_scope: "top",
    origins: ["https://example.test"],
    matches: ["https://*.example.test/*"],
    excludes: [],
  } });
  assert.equal((await harness.runtime.register(scopeDrift, reviewedAuthorization(scopeDrift))).reason, "match_origin_not_exact");

  const timingDrift = await reviewedProgram({ runAt: "document_start" });
  assert.equal((await harness.runtime.register(timingDrift, reviewedAuthorization(timingDrift))).reason, "timing_invalid");

  const worldDrift = await reviewedProgram({ world: "MAIN" });
  assert.equal((await harness.runtime.register(worldDrift, reviewedAuthorization(worldDrift))).reason, "reviewed_world_rejected");
  assert.equal(harness.calls.register.length, 0);
  assert.equal(harness.calls.update.length, 0);
});

test("persistent registration succeeds only after exact Chrome read-back and stores bounded receipts", async () => {
  const harness = createHarness({ enabled: true });
  const program = await reviewedProgram();
  const result = await harness.runtime.register(program, reviewedAuthorization(program));
  assert.equal(result.ok, true);
  assert.equal(result.registration.id, "moa_script_demo");
  assert.equal(result.registration.world, "USER_SCRIPT");
  assert.deepEqual(result.registration.matches, ["https://example.test/*"]);
  assert.equal(harness.calls.register.length, 1);
  assert.ok(harness.calls.getScripts.length >= 3);
  assert.equal(harness.values[PROGRAM_STORE_KEY].moa_script_demo.active_registration.revision, 1);
  assert.equal(harness.values[RECEIPT_STORE_KEY].length, 1);
  assert.equal(JSON.stringify(harness.values[RECEIPT_STORE_KEY]).includes(program.source), false);

  const disabled = await harness.runtime.disable(program.artifact_id);
  assert.equal(disabled.ok, true);
  assert.equal(harness.registrations.size, 0);
  assert.equal(harness.values[PROGRAM_STORE_KEY].moa_script_demo.revisions[0].source, program.source);

  const removed = await harness.runtime.unregister(program.artifact_id);
  assert.equal(removed.ok, true);
  assert.equal(harness.values[PROGRAM_STORE_KEY].moa_script_demo, undefined);
});

test("failed update preserves the prior registration and failed first register removes the partial registration", async () => {
  const preserve = createHarness({ enabled: true });
  const revisionOne = await reviewedProgram();
  assert.equal((await preserve.runtime.register(revisionOne, reviewedAuthorization(revisionOne))).ok, true);
  const originalUpdate = preserve.chromeApi.userScripts.update;
  let firstUpdate = true;
  preserve.chromeApi.userScripts.update = async (scripts) => {
    await originalUpdate(scripts);
    if (firstUpdate) {
      firstUpdate = false;
      preserve.registrations.get(scripts[0].id).world = "MAIN";
    }
  };
  const revisionTwo = await reviewedProgram({ revision: 2, source: "document.body.dataset.moa = 'v2';" });
  const failedUpdate = await preserve.runtime.update(revisionTwo, reviewedAuthorization(revisionTwo), { expected_revision: 1 });
  assert.equal(failedUpdate.ok, false);
  assert.equal(failedUpdate.rollback, "preserved");
  assert.equal(preserve.registrations.get("moa_script_demo").js[0].code, revisionOne.source);
  assert.equal(preserve.values[PROGRAM_STORE_KEY].moa_script_demo.active_registration.revision, 1);

  const remove = createHarness({ enabled: true });
  const originalRegister = remove.chromeApi.userScripts.register;
  remove.chromeApi.userScripts.register = async (scripts) => {
    await originalRegister(scripts);
    remove.registrations.get(scripts[0].id).world = "MAIN";
  };
  const failedRegister = await remove.runtime.register(revisionOne, reviewedAuthorization(revisionOne));
  assert.equal(failedRegister.ok, false);
  assert.equal(failedRegister.rollback, "removed");
  assert.equal(remove.registrations.size, 0);
  assert.equal(remove.values[PROGRAM_STORE_KEY], undefined);
});

test("successful update can roll back to retained approved source and profile disable verifies removal", async () => {
  const harness = createHarness({ enabled: true });
  const revisionOne = await reviewedProgram();
  const revisionTwo = await reviewedProgram({ revision: 2, source: "document.body.dataset.moa = 'v2';" });
  assert.equal((await harness.runtime.register(revisionOne, reviewedAuthorization(revisionOne))).ok, true);
  assert.equal((await harness.runtime.update(revisionTwo, reviewedAuthorization(revisionTwo), { expected_revision: 1 })).ok, true);
  assert.equal(harness.registrations.get("moa_script_demo").js[0].code, revisionTwo.source);
  assert.equal(harness.values[PROGRAM_STORE_KEY].moa_script_demo.active_registration.revision, 2);

  const rollback = await harness.runtime.rollback(revisionOne.artifact_id, 1, reviewedAuthorization(revisionOne));
  assert.equal(rollback.ok, true);
  assert.equal(harness.registrations.get("moa_script_demo").js[0].code, revisionOne.source);
  assert.equal(harness.values[PROGRAM_STORE_KEY].moa_script_demo.active_registration.revision, 1);

  const state = await harness.runtime.setProfileEnabled(REVIEWED_PROFILE, false);
  assert.equal(state.state, CAPABILITY_STATES.DISABLED);
  assert.equal(harness.registrations.size, 0);
  assert.equal(harness.values[PROGRAM_STORE_KEY].moa_script_demo.disabled, true);
  assert.equal(harness.values[PROGRAM_STORE_KEY].moa_script_demo.active_registration, null);
  assert.equal(harness.values[PROGRAM_STORE_KEY].moa_script_demo.revisions.length, 2);
});

test("immediate execution uses userScripts only and MAIN requires a separate delegated grant", async () => {
  const reviewed = createHarness({ enabled: true });
  const immediate = await reviewedProgram({ mode: "immediate" });
  assert.equal((await reviewed.runtime.execute(immediate, reviewedAuthorization(immediate))).ok, true);
  assert.deepEqual(reviewed.calls.execute[0].target, { tabId: 7, documentIds: ["doc-7"] });

  const delegated = createHarness({ delegated: true });
  const main = await delegatedImmediate({ world: "MAIN" });
  assert.equal((await delegated.runtime.execute(main, delegatedAuthorization(main, false))).reason, "main_world_grant_required");
  assert.equal(delegated.calls.execute.length, 0);
  assert.equal((await delegated.runtime.execute(main, delegatedAuthorization(main, true))).ok, true);
  assert.equal(delegated.calls.execute[0].world, "MAIN");
  assert.equal("scripting" in delegated.chromeApi, false);
  assert.equal("debugger" in delegated.chromeApi, false);
});

test("immediate execution records history without creating persistent registration state", async () => {
  const harness = createHarness({ enabled: true });
  const immediate = await reviewedProgram({ mode: "immediate" });
  assert.equal((await harness.runtime.execute(immediate, reviewedAuthorization(immediate))).ok, true);
  assert.equal(harness.values[PROGRAM_STORE_KEY], undefined);
  assert.equal(harness.values[EXECUTION_HISTORY_KEY].length, 1);
  assert.equal(harness.values[EXECUTION_HISTORY_KEY][0].program.mode, "immediate");
  assert.equal(harness.values[EXECUTION_HISTORY_KEY][0].active_registration, undefined);
  const disabled = await harness.runtime.setProfileEnabled(REVIEWED_PROFILE, false);
  assert.equal(disabled.state, CAPABILITY_STATES.DISABLED);
  assert.equal(harness.calls.unregister.length, 0);
  assert.equal(harness.values[PROGRAM_STORE_KEY], undefined);
  assert.equal(harness.values[EXECUTION_HISTORY_KEY].length, 1);
  assert.equal((await harness.runtime.capability(REVIEWED_PROFILE)).state, CAPABILITY_STATES.DISABLED);
});

test("authority discriminator rejects mixed, incomplete, and substituted profile authority", async () => {
  const reviewedHarness = createHarness({ enabled: true });
  const mixedReviewed = await reviewedProgram();
  mixedReviewed.authority.delegated = {
    role: "delegate",
    task_id: "task-1",
    run_id: "run-1",
    delegation_envelope_id: "envelope-1",
    grant_ids: ["grant-1"],
  };
  assert.equal((await reviewedHarness.runtime.register(mixedReviewed, reviewedAuthorization(mixedReviewed))).reason, "authority_variant_invalid");

  const topLevelDelegateLeak = await reviewedProgram();
  topLevelDelegateLeak.task_id = "task-leak";
  assert.equal((await reviewedHarness.runtime.register(topLevelDelegateLeak, reviewedAuthorization(topLevelDelegateLeak))).reason, "authority_variant_invalid");

  const missingDigest = await reviewedProgram();
  delete missingDigest.authority.standalone.approved_scope_digest;
  assert.equal((await reviewedHarness.runtime.register(missingDigest, { approval: {} })).reason, "authority_variant_invalid");

  const substitutedAuthorization = await reviewedProgram();
  const substituted = reviewedAuthorization(substitutedAuthorization);
  substituted.delegated = { current: true };
  assert.equal((await reviewedHarness.runtime.register(substitutedAuthorization, substituted)).reason, "authority_variant_invalid");

  const delegatedHarness = createHarness({ delegated: true });
  const mixedDelegated = await delegatedImmediate();
  mixedDelegated.authority.standalone = {
    approval_id: "approval-1",
    approved_source_sha256: mixedDelegated.source_sha256,
    approved_scope_digest: await programScopeDigest(mixedDelegated),
  };
  assert.equal((await delegatedHarness.runtime.execute(mixedDelegated, delegatedAuthorization(mixedDelegated))).reason, "authority_variant_invalid");

  const missingRun = await delegatedImmediate();
  delete missingRun.authority.delegated.run_id;
  assert.equal((await delegatedHarness.runtime.execute(missingRun, delegatedAuthorization(missingRun))).reason, "authority_variant_invalid");
  assert.equal(reviewedHarness.calls.register.length, 0);
  assert.equal(delegatedHarness.calls.execute.length, 0);
});

test("delegated grants must exactly match current class, scope, world, and checkpoint", async () => {
  const harness = createHarness({ delegated: true });
  const program = await delegatedImmediate();

  const wrongClass = delegatedAuthorization(program);
  wrongClass.delegated.grant_bindings[0].effect_class = "script.persist";
  assert.equal((await harness.runtime.execute(program, wrongClass)).reason, "delegation_effect_rejected");

  const wrongScope = delegatedAuthorization(program);
  wrongScope.delegated.grant_bindings[0].target.document_id = "other-document";
  assert.equal((await harness.runtime.execute(program, wrongScope)).reason, "delegation_scope_mismatch");

  const unexpectedCheckpoint = delegatedAuthorization(program);
  unexpectedCheckpoint.delegated.checkpoint_approval_id = "checkpoint-1";
  unexpectedCheckpoint.delegated.checkpoint_current = true;
  assert.equal((await harness.runtime.execute(program, unexpectedCheckpoint)).reason, "checkpoint_unexpected");

  const checkpointed = await delegatedImmediate();
  checkpointed.authority.delegated.checkpoint_approval_id = "checkpoint-1";
  const staleCheckpoint = delegatedAuthorization(checkpointed);
  staleCheckpoint.delegated.checkpoint_approval_id = "checkpoint-1";
  staleCheckpoint.delegated.checkpoint_current = false;
  assert.equal((await harness.runtime.execute(checkpointed, staleCheckpoint)).reason, "checkpoint_invalid");
  assert.equal(harness.calls.execute.length, 0);
});

test("artifact revisions are immutable and updates require a next-revision precondition", async () => {
  const harness = createHarness({ enabled: true });
  const revisionOne = await reviewedProgram();
  assert.equal((await harness.runtime.register(revisionOne, reviewedAuthorization(revisionOne))).ok, true);

  const replacedRevision = await reviewedProgram({ revision: 1, source: "document.body.dataset.moa = 'replacement';" });
  assert.equal((await harness.runtime.update(replacedRevision, reviewedAuthorization(replacedRevision), { expected_revision: 1 })).reason, "revision_immutable_conflict");

  const revisionTwo = await reviewedProgram({ revision: 2, source: "document.body.dataset.moa = 'v2';" });
  assert.equal((await harness.runtime.update(revisionTwo, reviewedAuthorization(revisionTwo))).reason, "update_precondition_required");
  assert.equal((await harness.runtime.update(revisionTwo, reviewedAuthorization(revisionTwo), { expected_revision: 0 })).reason, "update_revision_precondition_failed");

  const skippedRevision = await reviewedProgram({ revision: 3, source: "document.body.dataset.moa = 'v3';" });
  assert.equal((await harness.runtime.update(skippedRevision, reviewedAuthorization(skippedRevision), { expected_revision: 1 })).reason, "update_revision_precondition_failed");
  assert.equal(harness.calls.update.length, 0);
  assert.equal(harness.registrations.get("moa_script_demo").js[0].code, revisionOne.source);

  const delegatedHarness = createHarness({ delegated: true });
  const delegated = await delegatedImmediate();
  assert.equal((await delegatedHarness.runtime.execute(delegated, delegatedAuthorization(delegated))).ok, true);
  const worldReplacement = await delegatedImmediate({ world: "MAIN" });
  assert.equal((await delegatedHarness.runtime.execute(worldReplacement, delegatedAuthorization(worldReplacement, true))).reason, "revision_immutable_conflict");
  const scopeReplacement = await delegatedImmediate();
  scopeReplacement.target.document_id = "replacement-document";
  assert.equal((await delegatedHarness.runtime.execute(scopeReplacement, delegatedAuthorization(scopeReplacement))).reason, "revision_immutable_conflict");
  assert.equal(delegatedHarness.calls.execute.length, 1);
});

test("concurrent duplicate approval and program attempts execute or register exactly once", async () => {
  const executeHarness = createHarness({ enabled: true });
  const secondRuntime = createUserScriptsRuntime({
    chromeApi: executeHarness.chromeApi,
    now: () => new Date("2026-07-15T12:00:00.000Z"),
  });
  const immediate = await reviewedProgram({ mode: "immediate" });
  const executeResults = await Promise.all([
    executeHarness.runtime.execute(immediate, reviewedAuthorization(immediate)),
    secondRuntime.execute(immediate, reviewedAuthorization(immediate)),
  ]);
  assert.equal(executeHarness.calls.execute.length, 1);
  assert.deepEqual(executeResults.map((result) => result.status).sort(), ["idempotent", "succeeded"]);

  const registerHarness = createHarness({ enabled: true });
  const persistent = await reviewedProgram();
  const registerResults = await Promise.all([
    registerHarness.runtime.register(persistent, reviewedAuthorization(persistent)),
    registerHarness.runtime.register(persistent, reviewedAuthorization(persistent)),
  ]);
  assert.equal(registerHarness.calls.register.length, 1);
  assert.deepEqual(registerResults.map((result) => result.status).sort(), ["idempotent", "succeeded"]);
  assert.equal(executeHarness.values[IDEMPOTENCY_STORE_KEY].length, 1);
  assert.equal(registerHarness.values[IDEMPOTENCY_STORE_KEY].length, 1);
});

test("receipts redact untrusted results and API errors while binding exact profile authority", async () => {
  const harness = createHarness({ enabled: true });
  harness.chromeApi.userScripts.execute = async (injection) => {
    harness.calls.execute.push(clone(injection));
    return [{ result: { token: "Bearer secret-result", console: "page-secret" } }];
  };
  const immediate = await reviewedProgram({ mode: "immediate" });
  const succeeded = await harness.runtime.execute(immediate, reviewedAuthorization(immediate));
  assert.equal(succeeded.ok, true);
  assert.equal(succeeded.receipt.result.redacted, true);
  assert.equal(succeeded.receipt.authority.standalone.approval_id, "approval-1");
  const receiptsJson = JSON.stringify(harness.values[RECEIPT_STORE_KEY]);
  assert.equal(receiptsJson.includes("secret-result"), false);
  assert.equal(receiptsJson.includes("page-secret"), false);

  const errorHarness = createHarness({ enabled: true });
  errorHarness.chromeApi.userScripts.execute = async () => {
    throw new Error("sk_live_secret");
  };
  const rejected = await errorHarness.runtime.execute(immediate, reviewedAuthorization(immediate));
  assert.equal(rejected.reason, "user_scripts_api_error");
  assert.equal(JSON.stringify(errorHarness.values[RECEIPT_STORE_KEY]).includes("sk_live_secret"), false);
  const ambiguousRetry = await errorHarness.runtime.execute(immediate, reviewedAuthorization(immediate));
  assert.equal(ambiguousRetry.status, "indeterminate");
  assert.equal(ambiguousRetry.reason, "operation_already_started");
  assert.equal(errorHarness.values[IDEMPOTENCY_STORE_KEY][0].state, "pending");
});

test("failed unregister and profile disable preserve registration and never report disabled", async () => {
  for (const operation of ["unregister", "profile_disable"]) {
    const harness = createHarness({ enabled: true });
    const program = await reviewedProgram();
    assert.equal((await harness.runtime.register(program, reviewedAuthorization(program))).ok, true);
    const originalUnregister = harness.chromeApi.userScripts.unregister;
    let failOnce = true;
    harness.chromeApi.userScripts.unregister = async (request) => {
      await originalUnregister(request);
      if (failOnce) {
        failOnce = false;
        throw new Error("Bearer removal-secret");
      }
    };
    const result = operation === "unregister"
      ? await harness.runtime.unregister(program.artifact_id)
      : await harness.runtime.setProfileEnabled(REVIEWED_PROFILE, false);
    assert.equal(result.ok, false, operation);
    assert.equal(result.rollback, "preserved", operation);
    if (operation === "profile_disable") assert.equal(result.state, CAPABILITY_STATES.AVAILABLE);
    assert.equal(harness.values[REVIEWED_OPT_IN_KEY], true);
    assert.equal(harness.registrations.get("moa_script_demo").js[0].code, program.source);
    assert.equal(harness.values[PROGRAM_STORE_KEY].moa_script_demo.active_registration.revision, 1);
    assert.equal(JSON.stringify(harness.values[RECEIPT_STORE_KEY]).includes("removal-secret"), false);
  }
});

test("storage failure rolls back exact program, profile, and registration state", async () => {
  for (const operation of ["program_disable", "profile_disable"]) {
    const harness = createHarness({ enabled: true });
    const program = await reviewedProgram();
    assert.equal((await harness.runtime.register(program, reviewedAuthorization(program))).ok, true);
    const programSnapshot = clone(harness.values[PROGRAM_STORE_KEY]);
    const profileSnapshot = harness.values[REVIEWED_OPT_IN_KEY];
    const originalSet = harness.storage.set.bind(harness.storage);
    let failed = false;
    harness.storage.set = async (patch) => {
      const isCommit = operation === "profile_disable"
        ? patch[REVIEWED_OPT_IN_KEY] === false
        : patch[PROGRAM_STORE_KEY]?.moa_script_demo?.active_registration === null;
      if (!failed && isCommit) {
        failed = true;
        await originalSet(patch);
        throw new Error("sk_live_secret");
      }
      return originalSet(patch);
    };
    const result = operation === "profile_disable"
      ? await harness.runtime.setProfileEnabled(REVIEWED_PROFILE, false)
      : await harness.runtime.disable(program.artifact_id);
    assert.equal(result.ok, false, operation);
    assert.equal(result.rollback, "preserved", operation);
    assert.equal(result.reason, "user_scripts_api_error", operation);
    assert.deepEqual(harness.values[PROGRAM_STORE_KEY], programSnapshot, operation);
    assert.equal(harness.values[REVIEWED_OPT_IN_KEY], profileSnapshot, operation);
    assert.equal(harness.registrations.get("moa_script_demo").js[0].code, program.source, operation);
    assert.equal(JSON.stringify(harness.values[RECEIPT_STORE_KEY]).includes("sk_live_secret"), false, operation);
  }
});

test("failed storage rollback reports blocked and a second disable removes live registration before disabled", async () => {
  const harness = createHarness({ enabled: true });
  const program = await reviewedProgram();
  assert.equal((await harness.runtime.register(program, reviewedAuthorization(program))).ok, true);
  const originalSet = harness.storage.set.bind(harness.storage);
  let failure = 0;
  harness.storage.set = async (patch) => {
    if (patch[REVIEWED_OPT_IN_KEY] === false && failure === 0) {
      failure += 1;
      await originalSet(patch);
      throw new Error("commit_failed");
    }
    if (patch[REVIEWED_OPT_IN_KEY] === true && failure === 1) {
      failure += 1;
      throw new Error("rollback_failed");
    }
    return originalSet(patch);
  };
  const blocked = await harness.runtime.setProfileEnabled(REVIEWED_PROFILE, false);
  assert.equal(blocked.state, "disable_blocked");
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.registration_live, true);
  assert.equal(harness.registrations.size, 1);

  const completed = await harness.runtime.setProfileEnabled(REVIEWED_PROFILE, false);
  assert.equal(completed.state, CAPABILITY_STATES.DISABLED);
  assert.equal(completed.ok, true);
  assert.equal(harness.registrations.size, 0);
  assert.equal(harness.values[PROGRAM_STORE_KEY].moa_script_demo.active_registration, null);
  assert.equal(harness.values[REVIEWED_OPT_IN_KEY], false);
});

test("profile disable removes an orphaned live Moa registration after metadata rollback failure", async () => {
  const harness = createHarness({ enabled: true });
  const program = await reviewedProgram();
  assert.equal((await harness.runtime.register(program, reviewedAuthorization(program))).ok, true);
  const originalSet = harness.storage.set.bind(harness.storage);
  let failure = 0;
  harness.storage.set = async (patch) => {
    if (patch[PROGRAM_STORE_KEY] && !patch[PROGRAM_STORE_KEY].moa_script_demo && failure === 0) {
      failure += 1;
      await originalSet(patch);
      throw new Error("commit_failed");
    }
    if (patch[PROGRAM_STORE_KEY]?.moa_script_demo && failure === 1) {
      failure += 1;
      throw new Error("rollback_failed");
    }
    return originalSet(patch);
  };
  const blocked = await harness.runtime.unregister(program.artifact_id);
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.registration_live, true);
  assert.equal(harness.values[PROGRAM_STORE_KEY].moa_script_demo, undefined);

  const disabled = await harness.runtime.setProfileEnabled(REVIEWED_PROFILE, false);
  assert.equal(disabled.state, CAPABILITY_STATES.DISABLED);
  assert.equal(disabled.ok, true);
  assert.equal(harness.registrations.size, 0);
  assert.equal(harness.values[REVIEWED_OPT_IN_KEY], false);
});
