import assert from "node:assert/strict";
import test from "node:test";
import {
  CAPABILITY_STATES,
  DELEGATED_OPT_IN_KEY,
  DELEGATED_PROFILE,
  PROGRAM_STORE_KEY,
  RECEIPT_STORE_KEY,
  REVIEWED_OPT_IN_KEY,
  REVIEWED_PROFILE,
  createUserScriptsRuntime,
  sourceDigest,
} from "../extension/user-scripts-runtime.js";

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function createHarness({ enabled = false, delegated = false, permission = true, toggleError = null, supported = true } = {}) {
  const values = {
    [REVIEWED_OPT_IN_KEY]: enabled,
    [DELEGATED_OPT_IN_KEY]: delegated,
  };
  const registrations = new Map();
  const calls = { execute: [], register: [], update: [], unregister: [], getScripts: [] };
  const storage = {
    async get(query) {
      if (typeof query === "string") return { [query]: clone(values[query]) };
      const result = {};
      for (const [key, fallback] of Object.entries(query || {})) result[key] = key in values ? clone(values[key]) : clone(fallback);
      return result;
    },
    async set(patch) {
      Object.assign(values, clone(patch));
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
    runtime: createUserScriptsRuntime({ chromeApi, now: () => new Date("2026-07-15T12:00:00.000Z") }),
    values,
  };
}

async function reviewedProgram({ revision = 1, source = "document.body.dataset.moa = 'on';", world = "USER_SCRIPT", mode = "persistent", target, runAt = "document_idle" } = {}) {
  const normalizedTarget = target || (mode === "persistent" ? {
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
  return {
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
    authority: {
      profile: REVIEWED_PROFILE,
      approval_id: `approval-${revision}`,
    },
  };
}

function reviewedAuthorization(program) {
  return {
    approval_id: program.authority.approval_id,
    binding: {
      artifact_id: program.artifact_id,
      revision: program.revision,
      source_sha256: program.source_sha256,
      mode: program.mode,
      world: program.world,
      run_at: program.run_at,
      target: {
        tab_id: program.mode === "immediate" ? program.target.tab_id : null,
        document_id: program.mode === "immediate" ? program.target.document_id : null,
        frame_scope: "top",
        origins: [...program.target.origins].sort(),
        matches: [...program.target.matches].sort(),
        excludes: [...program.target.excludes].sort(),
      },
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
      role: "delegate",
      task_id: "task-1",
      run_id: "run-1",
      delegation_envelope_id: "envelope-1",
    },
  };
}

function delegatedAuthorization(program, mainWorld = false) {
  return {
    envelope_id: "envelope-1",
    current: true,
    effect_classes: ["script.evaluate"],
    grants: { main_world: mainWorld },
    target: {
      tab_id: program.target.tab_id,
      document_id: program.target.document_id,
      frame_scope: "top",
      origins: [...program.target.origins],
      matches: [],
      excludes: [],
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
  assert.equal(harness.values[PROGRAM_STORE_KEY].moa_script_demo.active_revision, 1);
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
  const failedUpdate = await preserve.runtime.update(revisionTwo, reviewedAuthorization(revisionTwo));
  assert.equal(failedUpdate.ok, false);
  assert.equal(failedUpdate.rollback, "preserved");
  assert.equal(preserve.registrations.get("moa_script_demo").js[0].code, revisionOne.source);
  assert.equal(preserve.values[PROGRAM_STORE_KEY].moa_script_demo.active_revision, 1);

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
  assert.equal((await harness.runtime.update(revisionTwo, reviewedAuthorization(revisionTwo))).ok, true);
  assert.equal(harness.registrations.get("moa_script_demo").js[0].code, revisionTwo.source);
  assert.equal(harness.values[PROGRAM_STORE_KEY].moa_script_demo.active_revision, 2);

  const rollback = await harness.runtime.rollback(revisionOne.artifact_id, 1, reviewedAuthorization(revisionOne));
  assert.equal(rollback.ok, true);
  assert.equal(harness.registrations.get("moa_script_demo").js[0].code, revisionOne.source);
  assert.equal(harness.values[PROGRAM_STORE_KEY].moa_script_demo.active_revision, 1);

  const state = await harness.runtime.setProfileEnabled(REVIEWED_PROFILE, false);
  assert.equal(state.state, CAPABILITY_STATES.DISABLED);
  assert.equal(harness.registrations.size, 0);
  assert.equal(harness.values[PROGRAM_STORE_KEY].moa_script_demo.disabled, true);
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
