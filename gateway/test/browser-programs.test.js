"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  BrowserProgramValidationError,
  PROGRAM_SCHEMA,
  RECEIPT_SCHEMA,
  canonicalizeSource,
  createBrowserProgramStore,
  createFileBrowserProgramAdapter,
  createInMemoryBrowserProgramAdapter,
  scopeDigest,
  sourceDigest,
  validateBrowserProgram,
  validateBrowserProgramReceipt,
} = require("../lib/browser-programs");

const AT = "2026-07-15T12:00:00.000Z";
const HASH = `sha256:${"a".repeat(64)}`;

function delegatedProgram(overrides = {}) {
  const source = overrides.source ?? "(() => { document.body.dataset.moa = 'on'; })();";
  const base = {
    schema: PROGRAM_SCHEMA,
    artifact_id: "script-chart-labels",
    revision: 1,
    source_turn_id: "turn-browser-1",
    name: "Label the chart",
    purpose: "Draw grounded explanatory labels",
    source,
    source_sha256: sourceDigest(canonicalizeSource(source)),
    mode: "immediate",
    world: "USER_SCRIPT",
    target: {
      tab_id: 42,
      document_id: "document-1",
      frame_scope: "top",
      origins: ["https://example.test"],
      matches: [],
      excludes: [],
    },
    timing: "explicit",
    effect: { class: "unknown_program_effect", declared_effect_classes: ["visual_modification"], operations: ["draw"] },
    authority: {
      profile: "delegated_runtime_v1",
      delegated: {
        role: "delegate",
        task_id: "task-browser-1",
        run_id: "run-browser-1",
        delegation_envelope_id: "envelope-browser-1",
        grants: [{
          grant_id: "grant-program-evaluate",
          class: "program_authority",
          world: "USER_SCRIPT",
          executor: "user_scripts_execute",
          origins: ["https://example.test"],
          frame_scope: "top",
          effect_classes: ["unknown_program_effect", "visual_modification"],
          bridge_capability: null,
        }],
        checkpoint_approval_id: null,
      },
    },
    bridge_capabilities: [],
    limits: { timeout_ms: 5_000, max_result_bytes: 4_096 },
    rollback: {
      prior_revision: null,
      capability: "unavailable",
      cleanup_entrypoint: null,
      unavailable_reason: "The immediate effect has no proven inverse",
    },
  };
  const merged = mergeProgram(base, overrides);
  if (!Object.hasOwn(overrides, "authority")) {
    const grant = merged.authority.delegated.grants[0];
    grant.world = merged.world;
    grant.executor = merged.mode === "persistent" ? "user_scripts_register" : "user_scripts_execute";
    grant.origins = structuredClone(merged.target.origins);
    grant.frame_scope = merged.target.frame_scope;
    grant.effect_classes = ["unknown_program_effect", ...merged.effect.declared_effect_classes];
  }
  return merged;
}

function standaloneProgram(overrides = {}) {
  const base = delegatedProgram({
    artifact_id: "script-reviewed-1",
    authority: {
      profile: "reviewed_standalone_v1",
      standalone: {
        approval_id: "approval-reviewed-1",
        approved_source_sha256: HASH,
        approved_scope_digest: HASH,
      },
    },
  });
  const merged = mergeProgram(base, overrides);
  merged.authority.standalone.approved_source_sha256 = merged.source_sha256;
  merged.authority.standalone.approved_scope_digest = scopeDigest(merged);
  return merged;
}

function persistentRevision(overrides = {}) {
  return delegatedProgram({
    artifact_id: "script-persistent-1",
    mode: "persistent",
    target: {
      tab_id: null,
      document_id: null,
      frame_scope: "top",
      origins: ["https://example.test"],
      matches: ["https://example.test/*"],
      excludes: ["https://example.test/private/*"],
    },
    timing: "document_idle",
    rollback: {
      prior_revision: null,
      capability: "cleanup_entrypoint",
      cleanup_entrypoint: "moaCleanup",
      unavailable_reason: null,
    },
    ...overrides,
  });
}

function receipt(program, operation, status, overrides = {}) {
  return {
    schema: RECEIPT_SCHEMA,
    receipt_id: `receipt-${operation}-1`,
    idempotency_key: `idem-${operation}-1`,
    operation,
    status,
    artifact_id: program.artifact_id,
    revision: program.revision,
    source_sha256: program.source_sha256,
    authority: structuredClone(program.authority),
    surface_id: "surface-browser-1",
    executor: operation === "proposal" ? "none" : "user_scripts_execute",
    world: program.world,
    target_digest: scopeDigest(program),
    before_evidence_refs: [],
    after_evidence_refs: [],
    result: { summary: "ok", error: null, console: [] },
    registration: { registration_id: null, read_back_verified: false, removal_verified: false },
    rollback: { prior_revision: null, cleanup_attempted: false, cleanup_succeeded: false, reason: null },
    recorded_at: AT,
    ...overrides,
  };
}

function mergeProgram(base, overrides) {
  const next = structuredClone(base);
  for (const [key, value] of Object.entries(overrides)) next[key] = structuredClone(value);
  if (Object.hasOwn(overrides, "source") && !Object.hasOwn(overrides, "source_sha256")) {
    next.source_sha256 = sourceDigest(canonicalizeSource(next.source));
  }
  return next;
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => error instanceof BrowserProgramValidationError && error.code === code);
}

test("canonical source digest and immutable proposal are inert", () => {
  const input = delegatedProgram({ source: "\uFEFFline1\r\nline2\r" });
  const validated = validateBrowserProgram(input);
  assert.equal(validated.source, "line1\nline2\n");
  assert.equal(validated.source_sha256, sourceDigest("line1\nline2\n"));
  assert.ok(Object.isFrozen(validated));

  const store = createBrowserProgramStore({ adapter: createInMemoryBrowserProgramAdapter() });
  const first = store.propose(input);
  assert.deepEqual({ state: first.state, executable: first.executable, duplicate: first.duplicate },
    { state: "proposed", executable: false, duplicate: false });
  assert.equal(store.propose(input).duplicate, true);
  assert.deepEqual(store.get(input.artifact_id, 1), first.artifact);
  assert.deepEqual(store.list(input.artifact_id), [first.artifact]);
  assert.equal(store.list("script-other").length, 0);

  const changed = delegatedProgram({ source: "document.body.remove();" });
  expectCode(() => store.propose(changed), "immutable_revision");
});

test("authority variants reject mixed, fabricated, missing, and invalid profile fields", () => {
  const mixedStandalone = standaloneProgram();
  mixedStandalone.authority.delegated = delegatedProgram().authority.delegated;
  expectCode(() => validateBrowserProgram(mixedStandalone), "mixed_authority");

  const mixedDelegated = delegatedProgram();
  mixedDelegated.authority.standalone = standaloneProgram().authority.standalone;
  expectCode(() => validateBrowserProgram(mixedDelegated), "mixed_authority");

  const missing = delegatedProgram();
  delete missing.authority.delegated.run_id;
  expectCode(() => validateBrowserProgram(missing), "invalid_id");

  const fabricatedRole = delegatedProgram();
  fabricatedRole.authority.delegated.role = "explain";
  expectCode(() => validateBrowserProgram(fabricatedRole), "unsupported_schema");

  const noGrants = delegatedProgram();
  noGrants.authority.delegated.grants = [];
  expectCode(() => validateBrowserProgram(noGrants), "invalid_delegated_authority");

  const standaloneMain = standaloneProgram({ world: "MAIN" });
  expectCode(() => validateBrowserProgram(standaloneMain), "invalid_standalone_authority");

  const standaloneBridge = standaloneProgram({ bridge_capabilities: [{ name: "storage.read", grant_id: "grant-storage" }] });
  standaloneBridge.authority.standalone.approved_scope_digest = scopeDigest(standaloneBridge);
  expectCode(() => validateBrowserProgram(standaloneBridge), "invalid_bridge");

  const badBridge = delegatedProgram({ bridge_capabilities: [{ name: "storage.read", grant_id: "grant-missing" }] });
  expectCode(() => validateBrowserProgram(badBridge), "invalid_bridge");

  const duplicateBridge = delegatedProgram({ bridge_capabilities: [
    { name: "page.notify", grant_id: "grant-program-evaluate" },
    { name: "page.notify", grant_id: "grant-program-evaluate" },
  ] });
  expectCode(() => validateBrowserProgram(duplicateBridge), "invalid_bridge");

  const validBridge = delegatedProgram({
    authority: {
      profile: "delegated_runtime_v1",
      delegated: {
        ...delegatedProgram().authority.delegated,
        checkpoint_approval_id: "approval-checkpoint-1",
        grants: [...delegatedProgram().authority.delegated.grants, {
          grant_id: "grant-page-notify",
          class: "bridge_authority",
          world: "USER_SCRIPT",
          executor: null,
          origins: ["https://example.test"],
          frame_scope: "top",
          effect_classes: [],
          bridge_capability: "page.notify",
        }],
      },
    },
    bridge_capabilities: [{ name: "page.notify", grant_id: "grant-page-notify" }],
  });
  assert.deepEqual(validateBrowserProgram(validBridge).bridge_capabilities,
    [{ name: "page.notify", grant_id: "grant-page-notify" }]);

  const standalonePersistentTiming = standaloneProgram({
    mode: "persistent",
    target: persistentRevision().target,
    timing: "document_start",
  });
  standalonePersistentTiming.authority.standalone.approved_scope_digest = scopeDigest(standalonePersistentTiming);
  expectCode(() => validateBrowserProgram(standalonePersistentTiming), "invalid_standalone_authority");
});

test("standalone approval binds exact source and exact scope", () => {
  assert.equal(validateBrowserProgram(standaloneProgram()).authority.profile, "reviewed_standalone_v1");
  const wrongSource = standaloneProgram();
  wrongSource.authority.standalone.approved_source_sha256 = HASH;
  expectCode(() => validateBrowserProgram(wrongSource), "approval_binding_mismatch");
  const wrongScope = standaloneProgram();
  wrongScope.authority.standalone.approved_scope_digest = HASH;
  expectCode(() => validateBrowserProgram(wrongScope), "approval_binding_mismatch");
});

test("mode, timing, target scope, matches, excludes, world, and limits are exact", () => {
  assert.equal(validateBrowserProgram(persistentRevision()).mode, "persistent");

  for (const [invalid, code] of [
    [delegatedProgram({ mode: "both" }), "invalid_enum"],
    [delegatedProgram({ world: "ISOLATED" }), "invalid_enum"],
    [delegatedProgram({ timing: "document_idle" }), "invalid_timing"],
    [persistentRevision({ timing: "explicit" }), "invalid_timing"],
    [delegatedProgram({ target: { ...delegatedProgram().target, origins: [] } }), "invalid_scope"],
    [delegatedProgram({ target: { ...delegatedProgram().target, matches: ["https://example.test/*"] } }), "invalid_scope"],
    [persistentRevision({ target: { ...persistentRevision().target, tab_id: 42 } }), "invalid_scope"],
    [persistentRevision({ target: { ...persistentRevision().target, matches: [] } }), "invalid_scope"],
    [persistentRevision({ target: { ...persistentRevision().target, matches: ["<all_urls>"] } }), "invalid_scope"],
    [persistentRevision({ target: { ...persistentRevision().target, excludes: ["https://other.test/*"] } }), "invalid_scope"],
    [delegatedProgram({ target: { ...delegatedProgram().target, origins: ["http://example.test"] } }), "invalid_scope"],
    [delegatedProgram({ target: { ...delegatedProgram().target, frame_scope: "named" } }), "invalid_enum"],
    [delegatedProgram({ limits: { timeout_ms: 49, max_result_bytes: 1 } }), "invalid_integer"],
    [delegatedProgram({ limits: { timeout_ms: 100, max_result_bytes: 16_385 } }), "invalid_integer"],
  ]) expectCode(() => validateBrowserProgram(invalid), code);
});

test("destructive application effects cannot masquerade as visual modification", () => {
  const masquerade = delegatedProgram({ effect: { class: "unknown_program_effect", declared_effect_classes: ["visual_modification"], operations: ["delete_application_data"] } });
  expectCode(() => validateBrowserProgram(masquerade), "effect_class_mismatch");
  const reverseMasquerade = delegatedProgram({ effect: { class: "unknown_program_effect", declared_effect_classes: ["destructive_site_action"], operations: ["hide"] } });
  expectCode(() => validateBrowserProgram(reverseMasquerade), "effect_class_mismatch");
  const destructive = delegatedProgram({ effect: { class: "unknown_program_effect", declared_effect_classes: ["destructive_site_action"], operations: ["delete_application_data"] } });
  destructive.authority.delegated.grants.push({
    grant_id: "grant-destructive-effect", class: "high_risk_effect", world: null, executor: null,
    origins: ["https://example.test"], frame_scope: "top", effect_classes: ["destructive_site_action"], bridge_capability: null,
  });
  assert.equal(validateBrowserProgram(destructive).effect.class, "unknown_program_effect");
  const standalone = standaloneProgram({ effect: destructive.effect });
  standalone.authority.standalone.approved_scope_digest = scopeDigest(standalone);
  expectCode(() => validateBrowserProgram(standalone), "invalid_standalone_authority");
});

test("revision lineage is immutable, contiguous, and binds the immediate prior revision", () => {
  const store = createBrowserProgramStore({ adapter: createInMemoryBrowserProgramAdapter() });
  const first = persistentRevision();
  store.propose(first);
  const second = persistentRevision({
    revision: 2,
    source: "(() => { document.body.dataset.revision = '2'; })();",
    rollback: { prior_revision: 1, capability: "prior_revision", cleanup_entrypoint: null, unavailable_reason: null },
  });
  assert.equal(store.propose(second).artifact.rollback.prior_revision, 1);

  const missingPrior = persistentRevision({ artifact_id: "script-missing-prior", revision: 2,
    rollback: { prior_revision: 1, capability: "prior_revision", cleanup_entrypoint: null, unavailable_reason: null } });
  expectCode(() => store.propose(missingPrior), "non_contiguous_revision");
  const noPrior = persistentRevision({ artifact_id: "script-no-prior", revision: 2,
    rollback: { prior_revision: null, capability: "unavailable", cleanup_entrypoint: null, unavailable_reason: "No prior" } });
  expectCode(() => store.propose(noPrior), "non_contiguous_revision");
  const skipped = persistentRevision({ revision: 3, source: "document.body.dataset.revision = '3';",
    rollback: { prior_revision: 1, capability: "prior_revision", cleanup_entrypoint: null, unavailable_reason: null } });
  expectCode(() => store.propose(skipped), "non_contiguous_revision");
});

test("proposal, apply, disable, and rollback receipts ingest idempotently and remain inert", () => {
  const store = createBrowserProgramStore({ adapter: createInMemoryBrowserProgramAdapter() });
  const program = persistentRevision();
  store.propose(program);
  const proposal = receipt(program, "proposal", "proposed");
  const apply = receipt(program, "apply", "applied", {
    executor: "user_scripts_register",
    registration: { registration_id: "moa-script-persistent-1", read_back_verified: true, removal_verified: false },
  });
  const disable = receipt(program, "disable", "disabled", {
    executor: "user_scripts_register",
    registration: { registration_id: "moa-script-persistent-1", read_back_verified: true, removal_verified: true },
  });
  const rollback = receipt(program, "rollback", "rolled_back", {
    executor: "user_scripts_register",
    rollback: { prior_revision: null, cleanup_attempted: true, cleanup_succeeded: true, reason: null },
  });

  for (const item of [proposal, apply, disable, rollback]) {
    const first = store.ingestReceipt(item);
    assert.equal(first.executable, false);
    assert.equal(first.duplicate, false);
    assert.equal(store.ingestReceipt(item).duplicate, true);
  }
  assert.deepEqual(store.listReceipts(program.artifact_id).map((item) => item.operation), ["apply", "disable", "proposal", "rollback"]);
  assert.equal(store.listReceipts(program.artifact_id, 1).length, 4);

  const conflict = structuredClone(apply);
  conflict.result.summary = "different";
  expectCode(() => store.ingestReceipt(conflict), "receipt_replay_conflict");
  const sameKeyDifferentId = structuredClone(apply);
  sameKeyDifferentId.receipt_id = "receipt-apply-other";
  expectCode(() => store.ingestReceipt(sameKeyDifferentId), "receipt_replay_conflict");
});

test("receipt transitions bind exact immutable artifact fields", () => {
  const store = createBrowserProgramStore({ adapter: createInMemoryBrowserProgramAdapter() });
  const program = delegatedProgram();
  store.propose(program);
  expectCode(() => store.ingestReceipt(receipt(program, "apply", "applied")), "proposal_receipt_required");
  expectCode(() => store.ingestReceipt(receipt(program, "disable", "disabled")), "apply_receipt_required");
  expectCode(() => store.ingestReceipt(receipt(program, "rollback", "rollback_unavailable")), "apply_receipt_required");

  for (const [field, value] of [
    ["source_sha256", HASH],
    ["authority", standaloneProgram().authority],
    ["world", "MAIN"],
    ["target_digest", HASH],
  ]) {
    const bad = receipt(program, "proposal", "proposed", { [field]: value });
    expectCode(() => store.ingestReceipt(bad), "receipt_binding_mismatch");
  }
  expectCode(() => store.ingestReceipt(receipt(program, "proposal", "proposed", { executor: "user_scripts_execute" })), "non_executable_proposal");
  expectCode(() => store.ingestReceipt(receipt(program, "proposal", "rejected", { executor: "user_scripts_execute" })), "non_executable_proposal");
  expectCode(() => store.ingestReceipt(receipt(program, "apply", "failed", { executor: "none" })), "invalid_executor");

  const standalone = standaloneProgram();
  store.propose(standalone);
  expectCode(() => store.ingestReceipt(receipt(standalone, "proposal", "proposed", { executor: "cdp_runtime_evaluate" })), "non_executable_proposal");
  store.ingestReceipt(receipt(standalone, "proposal", "proposed", {
    receipt_id: "receipt-standalone-proposal", idempotency_key: "idem-standalone-proposal",
  }));
  expectCode(() => store.ingestReceipt(receipt(standalone, "apply", "applied", { executor: "cdp_runtime_evaluate" })), "invalid_executor");

  const rejectedApply = receipt(program, "apply", "rejected", { executor: "none", receipt_id: "receipt-apply-rejected",
    idempotency_key: "idem-apply-rejected" });
  store.ingestReceipt(receipt(program, "proposal", "proposed"));
  assert.equal(store.ingestReceipt(rejectedApply).receipt.status, "rejected");
});

test("rollback-unavailable artifacts can only record honest unavailable receipts", () => {
  const store = createBrowserProgramStore({ adapter: createInMemoryBrowserProgramAdapter() });
  const program = delegatedProgram();
  store.propose(program);
  store.ingestReceipt(receipt(program, "proposal", "proposed"));
  store.ingestReceipt(receipt(program, "apply", "applied"));
  expectCode(() => store.ingestReceipt(receipt(program, "rollback", "rolled_back", {
    rollback: { prior_revision: null, cleanup_attempted: true, cleanup_succeeded: true, reason: null },
  })), "rollback_unavailable");
  assert.equal(store.ingestReceipt(receipt(program, "rollback", "rollback_unavailable")).receipt.status, "rollback_unavailable");

  const availableStore = createBrowserProgramStore({ adapter: createInMemoryBrowserProgramAdapter() });
  const available = persistentRevision();
  availableStore.propose(available);
  availableStore.ingestReceipt(receipt(available, "proposal", "proposed"));
  availableStore.ingestReceipt(receipt(available, "apply", "applied", { executor: "user_scripts_register",
    registration: { registration_id: "moa-script-persistent-1", read_back_verified: true, removal_verified: false } }));
  expectCode(() => availableStore.ingestReceipt(receipt(available, "rollback", "rollback_unavailable", { executor: "user_scripts_register" })), "invalid_rollback_status");
});

test("persistent receipt claims require registration read-back and verified removal", () => {
  const store = createBrowserProgramStore({ adapter: createInMemoryBrowserProgramAdapter() });
  const program = persistentRevision();
  store.propose(program);
  store.ingestReceipt(receipt(program, "proposal", "proposed"));
  expectCode(() => store.ingestReceipt(receipt(program, "apply", "applied", { executor: "user_scripts_execute" })), "invalid_executor");
  expectCode(() => store.ingestReceipt(receipt(program, "apply", "applied", { executor: "user_scripts_register" })), "invalid_registration");
  const applied = receipt(program, "apply", "applied", { executor: "user_scripts_register",
    registration: { registration_id: "moa-script-persistent-1", read_back_verified: true, removal_verified: false } });
  store.ingestReceipt(applied);
  expectCode(() => store.ingestReceipt(receipt(program, "disable", "disabled", { executor: "user_scripts_register" })), "invalid_registration");

  const immediate = delegatedProgram();
  const immediateStore = createBrowserProgramStore({ adapter: createInMemoryBrowserProgramAdapter() });
  immediateStore.propose(immediate);
  const badRegistration = receipt(immediate, "proposal", "proposed", {
    registration: { registration_id: "moa-impossible-registration", read_back_verified: true, removal_verified: false },
  });
  expectCode(() => immediateStore.ingestReceipt(badRegistration), "invalid_registration");

  const second = persistentRevision({ revision: 2, source: "document.body.dataset.v = '2';",
    rollback: { prior_revision: 1, capability: "prior_revision", cleanup_entrypoint: null, unavailable_reason: null } });
  store.propose(second);
  const wrongPrior = receipt(second, "proposal", "proposed");
  wrongPrior.receipt_id = "receipt-revision-2-proposal";
  wrongPrior.idempotency_key = "idem-revision-2-proposal";
  wrongPrior.rollback.prior_revision = null;
  expectCode(() => store.ingestReceipt(wrongPrior), "receipt_binding_mismatch");
});

test("secret-like source is rejected and receipt results are bounded and redacted", () => {
  for (const source of [
    "const api_key='secret-value-123';",
    "fetch('/x', {headers: {authorization: 'Bearer hidden-token'}});",
    "fetch('/x', {headers: {Auth: 'fixed-secret-value'}});",
    "const header = 'Bearer fixed-secret-value';",
  ]) expectCode(() => validateBrowserProgram(delegatedProgram({ source })), "credentials_forbidden");
  for (const source of [
    "document.cookie",
    "localStorage.getItem('token')",
    "localStorage['getItem']('password')",
    "window['sessionStorage']['getItem']('secret')",
    "headers['Authorization'] = token",
    "requestHeaders.Auth = token",
    "const request = { Auth: token }",
  ]) {
    expectCode(() => validateBrowserProgram(delegatedProgram({ source })), "undeclared_high_risk_effect");
  }

  const program = delegatedProgram();
  const redacted = validateBrowserProgramReceipt(receipt(program, "proposal", "proposed", {
    result: {
      summary: "authorization: Bearer very-secret-token",
      error: "password=hunter2",
      console: ["api_key=abc123", "safe"],
    },
    rollback: { prior_revision: null, cleanup_attempted: false, cleanup_succeeded: false, reason: "cookie=session-secret" },
  }));
  assert.deepEqual(redacted.result, { summary: "[REDACTED]", error: "[REDACTED]", console: ["[REDACTED]", "safe"] });
  assert.equal(redacted.rollback.reason, "[REDACTED]");

  expectCode(() => validateBrowserProgramReceipt(receipt(program, "proposal", "proposed", {
    result: { summary: "x".repeat(16_384), error: "x".repeat(16_384), console: [] },
  })), "result_too_large");
  expectCode(() => validateBrowserProgramReceipt(receipt(program, "proposal", "proposed", {
    result: { summary: "ok", error: null, console: [], password: "secret" },
  })), "credentials_forbidden");
});

test("strict closed schemas reject unknown fields and invalid rollback metadata", () => {
  const unknown = delegatedProgram();
  unknown.execute = true;
  expectCode(() => validateBrowserProgram(unknown), "unknown_field");

  const invalidCases = [
    delegatedProgram({ rollback: { prior_revision: 1, capability: "prior_revision", cleanup_entrypoint: null, unavailable_reason: null } }),
    delegatedProgram({ rollback: { prior_revision: null, capability: "prior_revision", cleanup_entrypoint: null, unavailable_reason: null } }),
    delegatedProgram({ rollback: { prior_revision: null, capability: "cleanup_entrypoint", cleanup_entrypoint: null, unavailable_reason: null } }),
    delegatedProgram({ rollback: { prior_revision: null, capability: "unavailable", cleanup_entrypoint: null, unavailable_reason: null } }),
    delegatedProgram({ rollback: { prior_revision: null, capability: "unavailable", cleanup_entrypoint: "cleanup", unavailable_reason: "none" } }),
    delegatedProgram({ rollback: { prior_revision: null, capability: "cleanup_entrypoint", cleanup_entrypoint: "cleanup", unavailable_reason: "extra" } }),
  ];
  for (const invalid of invalidCases) expectCode(() => validateBrowserProgram(invalid), "invalid_rollback");

  const badReceipt = receipt(delegatedProgram(), "proposal", "proposed");
  badReceipt.command = "execute";
  expectCode(() => validateBrowserProgramReceipt(badReceipt), "unknown_field");

  const credentialField = delegatedProgram();
  credentialField.api_key = "hidden";
  expectCode(() => validateBrowserProgram(credentialField), "credentials_forbidden");
});

test("validator edge bounds fail closed without coercion", () => {
  for (const source of [null, "", "x\0y", "x".repeat(128 * 1024 + 1)]) {
    const input = delegatedProgram();
    input.source = source;
    input.source_sha256 = HASH;
    expectCode(() => validateBrowserProgram(input), "invalid_source");
  }
  const duplicateOrigin = delegatedProgram({ target: { ...delegatedProgram().target,
    origins: ["https://example.test", "https://example.test"] } });
  expectCode(() => validateBrowserProgram(duplicateOrigin), "duplicate_value");
  const duplicateGrant = delegatedProgram();
  duplicateGrant.authority.delegated.grants.push(structuredClone(duplicateGrant.authority.delegated.grants[0]));
  expectCode(() => validateBrowserProgram(duplicateGrant), "duplicate_value");
  const emptyEffect = delegatedProgram({ effect: { class: "unknown_program_effect", declared_effect_classes: ["visual_modification"], operations: [] } });
  expectCode(() => validateBrowserProgram(emptyEffect), "invalid_effect");
  const unknownOperation = delegatedProgram({ effect: { class: "unknown_program_effect", declared_effect_classes: ["visual_modification"], operations: ["erase"] } });
  expectCode(() => validateBrowserProgram(unknownOperation), "invalid_enum");
  const malformed = delegatedProgram();
  malformed.target = [];
  expectCode(() => validateBrowserProgram(malformed), "invalid_schema");
  const exotic = delegatedProgram();
  exotic.effect = new Date();
  expectCode(() => validateBrowserProgram(exotic), "invalid_schema");
  const wrongDigest = delegatedProgram();
  wrongDigest.source_sha256 = HASH;
  expectCode(() => validateBrowserProgram(wrongDigest), "source_digest_mismatch");
  const badTimestamp = receipt(delegatedProgram(), "proposal", "proposed", { recorded_at: "yesterday" });
  expectCode(() => validateBrowserProgramReceipt(badTimestamp), "invalid_timestamp");
  const invalidBoolean = receipt(delegatedProgram(), "proposal", "proposed");
  invalidBoolean.registration.read_back_verified = "yes";
  expectCode(() => validateBrowserProgramReceipt(invalidBoolean), "invalid_boolean");
  const emptyConsole = receipt(delegatedProgram(), "proposal", "proposed");
  emptyConsole.result.console = [""];
  expectCode(() => validateBrowserProgramReceipt(emptyConsole), "invalid_text");
});

test("file adapter writes private atomic bounded state and rejects malformed persistence", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-browser-programs-"));
  const file = path.join(dir, "store.json");
  const store = createBrowserProgramStore({ adapter: createFileBrowserProgramAdapter(file) });
  const program = delegatedProgram();
  store.propose(program);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const reopened = createBrowserProgramStore({ adapter: createFileBrowserProgramAdapter(file) });
  assert.deepEqual(reopened.get(program.artifact_id, 1), validateBrowserProgram(program));
  assert.equal(reopened.get("script-absent", 1), null);
  assert.equal(reopened.list().length, 1);

  fs.writeFileSync(file, "not json");
  expectCode(() => reopened.list(), "invalid_store");
  expectCode(() => createFileBrowserProgramAdapter(""), "invalid_file_path");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("rollback outcomes reject contradictory cleanup claims", () => {
  const program = delegatedProgram();
  for (const [status, rollback] of [
    ["rolled_back", { prior_revision: null, cleanup_attempted: false, cleanup_succeeded: false, reason: null }],
    ["rolled_back", { prior_revision: null, cleanup_attempted: true, cleanup_succeeded: false, reason: "failed" }],
    ["rollback_unavailable", { prior_revision: null, cleanup_attempted: true, cleanup_succeeded: true, reason: null }],
    ["failed", { prior_revision: null, cleanup_attempted: true, cleanup_succeeded: true, reason: "contradiction" }],
  ]) expectCode(() => validateBrowserProgramReceipt(receipt(program, "rollback", status, { rollback })), "invalid_rollback_result");
  expectCode(() => validateBrowserProgramReceipt(receipt(program, "apply", "applied", {
    rollback: { prior_revision: null, cleanup_attempted: true, cleanup_succeeded: true, reason: null },
  })), "invalid_rollback_result");
});

test("MAIN and CDP require independent typed grants with exact scope", () => {
  const main = delegatedProgram({ world: "MAIN" });
  expectCode(() => validateBrowserProgram(main), "invalid_grant");
  main.authority.delegated.grants.push({
    grant_id: "grant-main-world", class: "world_authority", world: "MAIN", executor: null,
    origins: ["https://example.test"], frame_scope: "top", effect_classes: [], bridge_capability: null,
  });
  assert.equal(validateBrowserProgram(main).world, "MAIN");

  const cdp = delegatedProgram();
  cdp.authority.delegated.grants[0].executor = "cdp_runtime_evaluate";
  expectCode(() => validateBrowserProgram(cdp), "invalid_grant");
  cdp.authority.delegated.grants.push({
    grant_id: "grant-cdp-executor", class: "executor_authority", world: "USER_SCRIPT", executor: "cdp_runtime_evaluate",
    origins: ["https://example.test"], frame_scope: "top", effect_classes: [], bridge_capability: null,
  });
  const validated = validateBrowserProgram(cdp);
  const store = createBrowserProgramStore({ adapter: createInMemoryBrowserProgramAdapter() });
  store.propose(validated);
  store.ingestReceipt(receipt(validated, "proposal", "proposed"));
  assert.equal(store.ingestReceipt(receipt(validated, "apply", "applied", { executor: "cdp_runtime_evaluate" })).receipt.executor,
    "cdp_runtime_evaluate");

  const persistentCdp = persistentRevision();
  persistentCdp.authority.delegated.grants[0].executor = "cdp_runtime_evaluate";
  persistentCdp.authority.delegated.grants.push({
    grant_id: "grant-persistent-cdp", class: "executor_authority", world: "USER_SCRIPT", executor: "cdp_runtime_evaluate",
    origins: ["https://example.test"], frame_scope: "top", effect_classes: [], bridge_capability: null,
  });
  expectCode(() => validateBrowserProgram(persistentCdp), "invalid_grant");

  const widened = delegatedProgram();
  widened.authority.delegated.grants[0].origins = ["https://other.test"];
  expectCode(() => validateBrowserProgram(widened), "invalid_grant");
});

test("opaque source stays unknown and obvious high-risk signals require declarations and typed grants", () => {
  assert.equal(validateBrowserProgram(delegatedProgram()).effect.class, "unknown_program_effect");
  expectCode(() => validateBrowserProgram(delegatedProgram({ source: "fetch('/private')" })), "undeclared_high_risk_effect");
  expectCode(() => validateBrowserProgram(delegatedProgram({ source: "headers.set('Authorization', token)" })), "undeclared_high_risk_effect");
  expectCode(() => validateBrowserProgram(delegatedProgram({ source: "indexedDB.deleteDatabase('app')" })), "undeclared_high_risk_effect");

  const network = delegatedProgram({
    source: "fetch('/status')",
    effect: { class: "unknown_program_effect", declared_effect_classes: ["network_access"], operations: ["network_request"] },
  });
  expectCode(() => validateBrowserProgram(network), "invalid_grant");
  network.authority.delegated.grants.push({
    grant_id: "grant-network-effect", class: "high_risk_effect", world: null, executor: null,
    origins: ["https://example.test"], frame_scope: "top", effect_classes: ["network_access"], bridge_capability: null,
  });
  assert.deepEqual(validateBrowserProgram(network).effect.declared_effect_classes, ["network_access"]);

  const credential = delegatedProgram({
    source: "const token = window['localStorage']['getItem']('access_token'); headers.Auth = token;",
    effect: { class: "unknown_program_effect", declared_effect_classes: ["credential_access"], operations: ["read_credentials"] },
  });
  expectCode(() => validateBrowserProgram(credential), "invalid_grant");
  credential.authority.delegated.grants.push({
    grant_id: "grant-credential-effect", class: "high_risk_effect", world: null, executor: null,
    origins: ["https://example.test"], frame_scope: "top", effect_classes: ["credential_access"], bridge_capability: null,
  });
  assert.deepEqual(validateBrowserProgram(credential).effect.declared_effect_classes, ["credential_access"]);
});

test("append and reload reject chronology and persisted graph fabrication", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-browser-program-graph-"));
  const file = path.join(dir, "store.json");
  const adapter = createFileBrowserProgramAdapter(file);
  const store = createBrowserProgramStore({ adapter });
  const program = delegatedProgram();
  store.propose(program);
  const proposed = receipt(program, "proposal", "proposed");
  store.ingestReceipt(proposed);
  expectCode(() => store.ingestReceipt(receipt(program, "apply", "applied", {
    receipt_id: "receipt-apply-earlier", idempotency_key: "idem-apply-earlier", recorded_at: "2026-07-15T11:59:59.000Z",
  })), "receipt_timestamp_regression");
  const applied = receipt(program, "apply", "applied", {
    receipt_id: "receipt-apply-valid", idempotency_key: "idem-apply-valid", recorded_at: "2026-07-15T12:00:01.000Z",
  });
  store.ingestReceipt(applied);
  const validState = JSON.parse(fs.readFileSync(file, "utf8"));

  const mutations = [
    (state) => { state.receipts["receipt-apply-valid"].source_sha256 = HASH; },
    (state) => { delete state.receipts["receipt-proposal-1"]; },
    (state) => {
      const duplicate = structuredClone(state.receipts["receipt-apply-valid"]);
      duplicate.receipt_id = "receipt-duplicate-idempotency";
      state.receipts[duplicate.receipt_id] = duplicate;
    },
    (state) => { state.receipts["receipt-apply-valid"].recorded_at = "2026-07-15T11:00:00.000Z"; },
    (state) => { state.receipts["receipt-apply-valid"].executor = "cdp_runtime_evaluate"; },
  ];
  for (const mutate of mutations) {
    const state = structuredClone(validState);
    mutate(state);
    fs.writeFileSync(file, JSON.stringify(state));
    expectCode(() => createBrowserProgramStore({ adapter: createFileBrowserProgramAdapter(file) }).list(), "invalid_store");
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("file adapter serializes 32 concurrent writers without successful loss", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-browser-program-concurrency-"));
  const file = path.join(dir, "store.json");
  const modulePath = path.resolve(__dirname, "../lib/browser-programs.js");
  const writer = String.raw`
    const { createBrowserProgramStore, createFileBrowserProgramAdapter, sourceDigest } = require(process.argv[1]);
    const file = process.argv[2]; const index = Number(process.argv[3]);
    const source = "document.body.dataset.writer = '" + index + "';";
    const id = "script-writer-" + index;
    const program = { schema:"moa.browser-program.v2", artifact_id:id, revision:1, source_turn_id:"turn-writer-"+index,
      name:"writer "+index, purpose:"Concurrent serialization proof", source, source_sha256:sourceDigest(source),
      mode:"immediate", world:"USER_SCRIPT", target:{tab_id:index,document_id:"document-writer-"+index,frame_scope:"top",origins:["https://example.test"],matches:[],excludes:[]},
      timing:"explicit", effect:{class:"unknown_program_effect",declared_effect_classes:["visual_modification"],operations:["restyle"]},
      authority:{profile:"delegated_runtime_v1",delegated:{role:"delegate",task_id:"task-writer-"+index,run_id:"run-writer-"+index,delegation_envelope_id:"envelope-writer-"+index,
        grants:[{grant_id:"grant-writer-"+index,class:"program_authority",world:"USER_SCRIPT",executor:"user_scripts_execute",origins:["https://example.test"],frame_scope:"top",effect_classes:["unknown_program_effect","visual_modification"],bridge_capability:null}],checkpoint_approval_id:null}},
      bridge_capabilities:[], limits:{timeout_ms:1000,max_result_bytes:1024}, rollback:{prior_revision:null,capability:"unavailable",cleanup_entrypoint:null,unavailable_reason:"fixture"} };
    createBrowserProgramStore({adapter:createFileBrowserProgramAdapter(file)}).propose(program);
  `;
  const results = await Promise.all(Array.from({ length: 32 }, (_, index) => new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", writer, modulePath, file, String(index)], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("exit", (code) => resolve({ code, stderr }));
  })));
  assert.deepEqual(results.filter((result) => result.code !== 0), []);
  const store = createBrowserProgramStore({ adapter: createFileBrowserProgramAdapter(file) });
  assert.equal(store.list().length, 32);
  assert.equal(new Set(store.list().map((program) => program.artifact_id)).size, 32);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("file adapter cleans an uncommitted lock when metadata fsync fails", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-browser-program-lock-acquire-"));
  const file = path.join(dir, "store.json");
  const adapter = createFileBrowserProgramAdapter(file, {
    lockHooks: { beforeMetadataFsync() { throw new Error("injected metadata fsync failure"); } },
  });
  const store = createBrowserProgramStore({ adapter });
  assert.throws(() => store.propose(delegatedProgram()), (error) => {
    assert.equal(error.code, "store_lock_acquire_failed");
    assert.equal(error.committed, false);
    return true;
  });
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(`${file}.lock`), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("file adapter reports a confirmed commit on release failure and recovers its abandoned lock", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-browser-program-lock-release-"));
  const file = path.join(dir, "store.json");
  const first = delegatedProgram();
  const adapter = createFileBrowserProgramAdapter(file, {
    lockHooks: { beforeUnlink() { throw new Error("injected lock unlink failure"); } },
  });
  const store = createBrowserProgramStore({ adapter });
  assert.throws(() => store.propose(first), (error) => {
    assert.equal(error.code, "committed_lock_release_failed");
    assert.equal(error.committed, true);
    assert.equal(error.state_confirmed, true);
    return true;
  });
  assert.equal(fs.existsSync(`${file}.lock`), true);
  const recovered = createBrowserProgramStore({ adapter: createFileBrowserProgramAdapter(file) });
  assert.equal(recovered.get(first.artifact_id, first.revision).source_sha256, first.source_sha256);
  const second = delegatedProgram({ artifact_id: "script-after-lock-recovery" });
  assert.equal(recovered.propose(second).artifact.artifact_id, second.artifact_id);
  assert.equal(recovered.list().length, 2);
  assert.equal(fs.existsSync(`${file}.lock`), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("file adapter recovers a lock whose owning process is dead", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-browser-program-dead-lock-"));
  const file = path.join(dir, "store.json");
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  const deadPid = child.pid;
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  fs.writeFileSync(`${file}.lock`, JSON.stringify({
    schema: "moa.browser-program-lock.v1",
    pid: deadPid,
    acquired_at: AT,
    nonce: "a".repeat(32),
  }), { mode: 0o600 });
  const store = createBrowserProgramStore({ adapter: createFileBrowserProgramAdapter(file) });
  assert.equal(store.propose(delegatedProgram()).duplicate, false);
  assert.equal(fs.existsSync(`${file}.lock`), false);
  assert.equal(fs.existsSync(`${file}.lock.recovery`), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("typed grant shape and lifecycle defensive branches reject adversarial records", () => {
  const badProgramGrant = delegatedProgram();
  badProgramGrant.authority.delegated.grants[0].world = null;
  expectCode(() => validateBrowserProgram(badProgramGrant), "invalid_grant");

  const badWorldGrant = delegatedProgram({ world: "MAIN" });
  badWorldGrant.authority.delegated.grants.push({
    grant_id: "grant-main-world", class: "world_authority", world: "USER_SCRIPT", executor: null,
    origins: ["https://example.test"], frame_scope: "top", effect_classes: [], bridge_capability: null,
  });
  expectCode(() => validateBrowserProgram(badWorldGrant), "invalid_grant");

  const badExecutorGrant = delegatedProgram();
  badExecutorGrant.authority.delegated.grants.push({
    grant_id: "grant-cdp", class: "executor_authority", world: "USER_SCRIPT", executor: "user_scripts_execute",
    origins: ["https://example.test"], frame_scope: "top", effect_classes: [], bridge_capability: null,
  });
  expectCode(() => validateBrowserProgram(badExecutorGrant), "invalid_grant");

  const badBridgeGrant = delegatedProgram();
  badBridgeGrant.authority.delegated.grants.push({
    grant_id: "grant-bridge", class: "bridge_authority", world: "USER_SCRIPT", executor: null,
    origins: ["https://example.test"], frame_scope: "top", effect_classes: [], bridge_capability: null,
  });
  expectCode(() => validateBrowserProgram(badBridgeGrant), "invalid_grant");

  const badRiskGrant = delegatedProgram();
  badRiskGrant.authority.delegated.grants.push({
    grant_id: "grant-risk", class: "high_risk_effect", world: null, executor: null,
    origins: ["https://example.test"], frame_scope: "top", effect_classes: ["visual_modification"], bridge_capability: null,
  });
  expectCode(() => validateBrowserProgram(badRiskGrant), "invalid_grant");

  const uncoveredEffect = delegatedProgram();
  uncoveredEffect.authority.delegated.grants[0].effect_classes = ["unknown_program_effect"];
  expectCode(() => validateBrowserProgram(uncoveredEffect), "invalid_grant");

  const wrongMatchOrigin = persistentRevision({ target: {
    ...persistentRevision().target,
    matches: ["https://other.test/*"], excludes: [],
  } });
  expectCode(() => validateBrowserProgram(wrongMatchOrigin), "invalid_scope");

  const store = createBrowserProgramStore({ adapter: createInMemoryBrowserProgramAdapter() });
  const program = delegatedProgram();
  store.propose(program);
  store.ingestReceipt(receipt(program, "proposal", "proposed"));
  store.ingestReceipt(receipt(program, "apply", "applied"));
  const secondApply = receipt(program, "apply", "applied", {
    receipt_id: "receipt-apply-second", idempotency_key: "idem-apply-second", recorded_at: "2026-07-15T12:00:01.000Z",
  });
  expectCode(() => store.ingestReceipt(secondApply), "invalid_lifecycle");
  store.ingestReceipt(receipt(program, "disable", "disabled", {
    receipt_id: "receipt-disable-first", idempotency_key: "idem-disable-first", recorded_at: "2026-07-15T12:00:01.000Z",
  }));
  expectCode(() => store.ingestReceipt(receipt(program, "disable", "disabled", {
    receipt_id: "receipt-disable-second", idempotency_key: "idem-disable-second", recorded_at: "2026-07-15T12:00:02.000Z",
  })), "invalid_lifecycle");

  const credentialPurpose = delegatedProgram({ purpose: "authorization: Bearer secret-value" });
  expectCode(() => validateBrowserProgram(credentialPurpose), "credentials_forbidden");
});

test("malformed state fails visibly inside a locked transaction", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-browser-program-transaction-"));
  const file = path.join(dir, "store.json");
  fs.writeFileSync(file, "not json");
  const store = createBrowserProgramStore({ adapter: createFileBrowserProgramAdapter(file) });
  expectCode(() => store.propose(delegatedProgram()), "invalid_store");
  fs.rmSync(dir, { recursive: true, force: true });
});
