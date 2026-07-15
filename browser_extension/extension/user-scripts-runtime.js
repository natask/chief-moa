const REVIEWED_PROFILE = "reviewed_standalone_v1";
const DELEGATED_PROFILE = "delegated_runtime_v1";
const REVIEWED_OPT_IN_KEY = "ageeReviewedUserScriptsEnabled";
const DELEGATED_OPT_IN_KEY = "ageeDelegatedUserScriptsEnabled";
const PROGRAM_STORE_KEY = "ageeUserScriptPrograms";
const RECEIPT_STORE_KEY = "ageeUserScriptReceipts";
const IDEMPOTENCY_STORE_KEY = "ageeUserScriptIdempotency";
const RECEIPT_LIMIT = 100;
const SOURCE_MAX_BYTES = 128 * 1024;
const RESULT_MAX_BYTES = 16 * 1024;
const MAX_PATTERNS = 16;
const sharedOperationQueues = new WeakMap();

const CAPABILITY_STATES = Object.freeze({
  DISABLED: "disabled",
  AVAILABLE: "available",
  CHROME_TOGGLE_REQUIRED: "chrome_toggle_required",
  PERMISSION_REVOKED: "permission_revoked",
  UNSUPPORTED: "unsupported",
});

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function bytes(value) {
  return new TextEncoder().encode(value).byteLength;
}

async function sourceDigest(source, subtle = globalThis.crypto?.subtle) {
  if (!subtle?.digest) throw new Error("sha256_unavailable");
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(source));
  return `sha256:${[...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function profileOptInKey(profile) {
  if (profile === REVIEWED_PROFILE) return REVIEWED_OPT_IN_KEY;
  if (profile === DELEGATED_PROFILE) return DELEGATED_OPT_IN_KEY;
  throw new Error("profile_unsupported");
}

function boundedAuthorityId(value, required = false) {
  if (value == null && !required) return null;
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new Error("authority_id_invalid");
  return value;
}

function exactObjectKeys(value, required, optional = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("authority_variant_invalid");
  const keys = Object.keys(value).sort();
  const allowed = [...required, ...optional];
  if (required.some((key) => !(key in value)) || keys.some((key) => !allowed.includes(key))) throw new Error("authority_variant_invalid");
}

function exactOrigin(value) {
  if (typeof value !== "string" || value.length > 256) throw new Error("origin_invalid");
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("origin_invalid");
  }
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.origin !== value) {
    throw new Error("origin_not_exact");
  }
  return parsed.origin;
}

function matchPatternOrigin(value) {
  if (typeof value !== "string" || value.length > 512 || !/^https?:\/\//.test(value)) throw new Error("match_invalid");
  const slash = value.indexOf("/", value.indexOf("//") + 2);
  if (slash < 0) throw new Error("match_invalid");
  const originText = value.slice(0, slash);
  if (originText.includes("*")) throw new Error("match_origin_not_exact");
  return exactOrigin(originText);
}

function normalizedPatterns(values, name) {
  if (!Array.isArray(values) || values.length > MAX_PATTERNS) throw new Error(`${name}_invalid`);
  const normalized = values.map((value) => {
    matchPatternOrigin(value);
    return value;
  });
  if (new Set(normalized).size !== normalized.length) throw new Error(`${name}_duplicate`);
  return [...normalized].sort();
}

function normalizedTarget(target, mode) {
  if (!target || typeof target !== "object" || target.frame_scope !== "top") throw new Error("target_scope_invalid");
  const origins = Array.isArray(target.origins) ? target.origins.map(exactOrigin).sort() : [];
  if (origins.length === 0 || origins.length > MAX_PATTERNS || new Set(origins).size !== origins.length) throw new Error("target_origins_invalid");
  const matches = normalizedPatterns(target.matches || [], "matches");
  const excludes = normalizedPatterns(target.excludes || [], "excludes");
  if (mode === "persistent") {
    if (matches.length === 0 || target.tab_id != null || target.document_id != null) throw new Error("persistent_scope_invalid");
    const matchOrigins = [...new Set(matches.map(matchPatternOrigin))].sort();
    if (stableJson(matchOrigins) !== stableJson(origins)) throw new Error("matches_origin_drift");
    if (excludes.some((pattern) => !origins.includes(matchPatternOrigin(pattern)))) throw new Error("excludes_origin_drift");
  } else {
    if (!Number.isInteger(target.tab_id) || target.tab_id < 0 || typeof target.document_id !== "string" || !target.document_id || target.document_id.length > 256) {
      throw new Error("immediate_scope_invalid");
    }
    if (matches.length || excludes.length || origins.length !== 1) throw new Error("immediate_scope_invalid");
  }
  return {
    tab_id: mode === "immediate" ? target.tab_id : null,
    document_id: mode === "immediate" ? target.document_id : null,
    frame_scope: "top",
    origins,
    matches,
    excludes,
  };
}

function scopeBinding(program) {
  return {
    mode: program.mode,
    world: program.world,
    run_at: program.run_at,
    target: program.target,
  };
}

async function programScopeDigest(program, subtle = globalThis.crypto?.subtle) {
  return sourceDigest(stableJson(scopeBinding(program)), subtle);
}

function normalizedGrantIds(values) {
  if (!Array.isArray(values) || values.length === 0 || values.length > 16) throw new Error("delegated_grants_invalid");
  const ids = values.map((value) => boundedAuthorityId(value, true));
  if (new Set(ids).size !== ids.length) throw new Error("delegated_grants_invalid");
  return [...ids].sort();
}

async function validateProgram(input, authorization, subtle) {
  if (!input || typeof input !== "object" || input.schema !== "moa.browser-program.v2") throw new Error("schema_invalid");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.artifact_id || "")) throw new Error("artifact_id_invalid");
  if (!Number.isInteger(input.revision) || input.revision < 1) throw new Error("revision_invalid");
  if (typeof input.source !== "string" || !input.source || bytes(input.source) > SOURCE_MAX_BYTES) throw new Error("source_invalid");
  const actualDigest = await sourceDigest(input.source, subtle);
  if (input.source_sha256 !== actualDigest) throw new Error("source_digest_mismatch");
  if (!new Set(["immediate", "persistent"]).has(input.mode)) throw new Error("mode_invalid");
  if (!new Set(["USER_SCRIPT", "MAIN"]).has(input.world)) throw new Error("world_invalid");
  if (input.run_at !== "document_idle") throw new Error("timing_invalid");
  const profile = input.authority?.profile;
  profileOptInKey(profile);
  const target = normalizedTarget(input.target, input.mode);
  const program = {
    schema: input.schema,
    artifact_id: input.artifact_id,
    revision: input.revision,
    name: String(input.name || "").slice(0, 120),
    purpose: String(input.purpose || "").slice(0, 500),
    source: input.source,
    source_sha256: actualDigest,
    mode: input.mode,
    world: input.world,
    run_at: input.run_at,
    target,
    authority: null,
  };
  const scopeDigest = await programScopeDigest(program, subtle);
  if (profile === REVIEWED_PROFILE) {
    if (["role", "task_id", "run_id", "delegation_envelope_id", "grant_ids", "grants", "delegated"].some((key) => input[key] != null)) {
      throw new Error("authority_variant_invalid");
    }
    if (input.world !== "USER_SCRIPT") throw new Error("reviewed_world_rejected");
    exactObjectKeys(input.authority, ["profile", "standalone"]);
    exactObjectKeys(input.authority.standalone, ["approval_id", "approved_source_sha256", "approved_scope_digest"]);
    const standalone = {
      approval_id: boundedAuthorityId(input.authority.standalone.approval_id, true),
      approved_source_sha256: input.authority.standalone.approved_source_sha256,
      approved_scope_digest: input.authority.standalone.approved_scope_digest,
    };
    if (standalone.approved_source_sha256 !== actualDigest) throw new Error("approval_source_mismatch");
    if (standalone.approved_scope_digest !== scopeDigest) throw new Error("approval_scope_mismatch");
    exactObjectKeys(authorization, ["approval"]);
    exactObjectKeys(authorization.approval, ["approval_id", "source_sha256", "scope_digest", "current"]);
    if (
      authorization.approval.current !== true ||
      authorization.approval.approval_id !== standalone.approval_id ||
      authorization.approval.source_sha256 !== actualDigest ||
      authorization.approval.scope_digest !== scopeDigest
    ) throw new Error("approval_invalid");
    program.authority = { profile, standalone };
  } else {
    if (["approval_id", "approved_source_sha256", "approved_scope_digest", "standalone"].some((key) => input[key] != null)) {
      throw new Error("authority_variant_invalid");
    }
    exactObjectKeys(input.authority, ["profile", "delegated"]);
    exactObjectKeys(
      input.authority.delegated,
      ["role", "task_id", "run_id", "delegation_envelope_id", "grant_ids"],
      ["checkpoint_approval_id"],
    );
    const delegated = {
      role: input.authority.delegated.role,
      task_id: boundedAuthorityId(input.authority.delegated.task_id, true),
      run_id: boundedAuthorityId(input.authority.delegated.run_id, true),
      delegation_envelope_id: boundedAuthorityId(input.authority.delegated.delegation_envelope_id, true),
      grant_ids: normalizedGrantIds(input.authority.delegated.grant_ids),
      checkpoint_approval_id: input.authority.delegated.checkpoint_approval_id == null
        ? null
        : boundedAuthorityId(input.authority.delegated.checkpoint_approval_id, true),
    };
    if (delegated.role !== "delegate") throw new Error("delegation_role_invalid");
    exactObjectKeys(
      authorization,
      ["delegated"],
    );
    exactObjectKeys(
      authorization.delegated,
      ["role", "task_id", "run_id", "delegation_envelope_id", "grant_bindings", "current"],
      ["checkpoint_approval_id", "checkpoint_current"],
    );
    const current = authorization.delegated;
    if (
      current.current !== true || current.role !== "delegate" ||
      current.task_id !== delegated.task_id || current.run_id !== delegated.run_id ||
      current.delegation_envelope_id !== delegated.delegation_envelope_id
    ) throw new Error("delegation_invalid");
    const effect = input.mode === "persistent" ? "script.persist" : "script.evaluate";
    if (!Array.isArray(current.grant_bindings) || current.grant_bindings.length !== delegated.grant_ids.length) throw new Error("delegated_grants_invalid");
    const grants = current.grant_bindings.map((grant) => {
      exactObjectKeys(grant, ["grant_id", "effect_class", "target", "world", "current"]);
      return {
        grant_id: boundedAuthorityId(grant.grant_id, true),
        effect_class: grant.effect_class,
        target: grant.target,
        world: grant.world,
        current: grant.current,
      };
    }).sort((left, right) => left.grant_id.localeCompare(right.grant_id));
    if (stableJson(grants.map((grant) => grant.grant_id)) !== stableJson(delegated.grant_ids)) throw new Error("delegated_grants_invalid");
    if (grants.some((grant) => grant.current !== true || grant.effect_class !== effect)) throw new Error("delegation_effect_rejected");
    if (grants.some((grant) => grant.world !== input.world)) throw new Error(input.world === "MAIN" ? "main_world_grant_required" : "delegation_world_mismatch");
    if (grants.some((grant) => stableJson(grant.target) !== stableJson(target))) throw new Error("delegation_scope_mismatch");
    if (delegated.checkpoint_approval_id) {
      if (current.checkpoint_approval_id !== delegated.checkpoint_approval_id || current.checkpoint_current !== true) throw new Error("checkpoint_invalid");
    } else if (current.checkpoint_approval_id != null || current.checkpoint_current != null) {
      throw new Error("checkpoint_unexpected");
    }
    program.authority = { profile, delegated };
  }
  return program;
}

function registrationId(artifactId) {
  return `moa_${artifactId.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 120)}`;
}

function registrationFor(program) {
  return {
    id: registrationId(program.artifact_id),
    matches: [...program.target.matches],
    excludeMatches: [...program.target.excludes],
    js: [{ code: program.source }],
    runAt: program.run_at,
    world: program.world,
    allFrames: false,
  };
}

function normalizedRegistration(value) {
  if (!value) return null;
  return {
    id: value.id,
    matches: [...(value.matches || [])].sort(),
    excludeMatches: [...(value.excludeMatches || [])].sort(),
    js: (value.js || []).map((entry) => ({ code: entry.code || null, file: entry.file || null })),
    runAt: value.runAt || "document_idle",
    world: value.world || "USER_SCRIPT",
    allFrames: value.allFrames === true,
  };
}

function registrationMatches(actual, expected) {
  return stableJson(normalizedRegistration(actual)) === stableJson(normalizedRegistration(expected));
}

function receiptRegistration(actual, sourceSha256) {
  const normalized = normalizedRegistration(actual);
  if (!normalized) return null;
  return { ...normalized, js: [{ source_sha256: sourceSha256 }] };
}

function receiptAuthority(program) {
  if (program.authority.profile === REVIEWED_PROFILE) {
    return { profile: REVIEWED_PROFILE, standalone: { ...program.authority.standalone } };
  }
  return {
    profile: DELEGATED_PROFILE,
    delegated: {
      role: "delegate",
      task_id: program.authority.delegated.task_id,
      run_id: program.authority.delegated.run_id,
      delegation_envelope_id: program.authority.delegated.delegation_envelope_id,
      grant_ids: [...program.authority.delegated.grant_ids],
      checkpoint_approval_id: program.authority.delegated.checkpoint_approval_id,
    },
  };
}

function programFingerprint(program) {
  return stableJson({
    artifact_id: program.artifact_id,
    revision: program.revision,
    source_sha256: program.source_sha256,
    mode: program.mode,
    world: program.world,
    run_at: program.run_at,
    target: program.target,
    authority: program.authority,
  });
}

function safeReason(error) {
  const message = String(error?.message || error || "rejected");
  return /^[a-z][a-z0-9_]{0,63}$/.test(message) ? message : "user_scripts_api_error";
}

function receiptResult(value) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return { present: true, redacted: true, byte_count: null, truncated: true };
  }
  return {
    present: value != null,
    redacted: true,
    byte_count: bytes(serialized),
    truncated: bytes(serialized) > RESULT_MAX_BYTES,
  };
}

function detectedChromeMajor(userAgent = globalThis.navigator?.userAgent) {
  const match = String(userAgent || "").match(/(?:Chrome|Chromium)\/(\d+)/);
  return match ? Number(match[1]) : null;
}

function boundedResult(value) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return { truncated: true, summary: "unserializable_result" };
  }
  if (bytes(serialized) <= RESULT_MAX_BYTES) return value;
  return { truncated: true, byte_count: bytes(serialized) };
}

function createUserScriptsRuntime({
  chromeApi = globalThis.chrome,
  now = () => new Date(),
  subtle = globalThis.crypto?.subtle,
  receiptLimit = RECEIPT_LIMIT,
  locks = globalThis.navigator?.locks,
  chromeMajor = detectedChromeMajor(),
} = {}) {
  const storage = chromeApi?.storage?.local;

  function serialized(operation) {
    const previous = sharedOperationQueues.get(storage) || Promise.resolve();
    const run = () => locks?.request
      ? locks.request("agee-user-scripts-runtime", { mode: "exclusive" }, operation)
      : operation();
    const next = previous.then(run, run);
    sharedOperationQueues.set(storage, next.catch(() => {}));
    return next;
  }

  async function storedPrograms() {
    const stored = await storage.get({ [PROGRAM_STORE_KEY]: {} });
    return stored[PROGRAM_STORE_KEY] && typeof stored[PROGRAM_STORE_KEY] === "object" ? stored[PROGRAM_STORE_KEY] : {};
  }

  async function writePrograms(programs) {
    await storage.set({ [PROGRAM_STORE_KEY]: programs });
  }

  async function idempotencyRecords() {
    const stored = await storage.get({ [IDEMPOTENCY_STORE_KEY]: [] });
    return Array.isArray(stored[IDEMPOTENCY_STORE_KEY]) ? stored[IDEMPOTENCY_STORE_KEY] : [];
  }

  async function idempotencyKey(operation, program) {
    return sourceDigest(stableJson({
      operation,
      artifact_id: program.artifact_id,
      revision: program.revision,
      source_sha256: program.source_sha256,
      authority: program.authority,
    }), subtle);
  }

  async function operationRecord(key) {
    return (await idempotencyRecords()).find((entry) => entry.key === key) || null;
  }

  async function beginOperation(key) {
    const records = await idempotencyRecords();
    await storage.set({
      [IDEMPOTENCY_STORE_KEY]: [
        ...records.filter((entry) => entry.key !== key),
        { key, state: "pending", started_at: now().toISOString() },
      ].slice(-receiptLimit),
    });
  }

  async function markOperationComplete(key, record) {
    const records = await idempotencyRecords();
    await storage.set({
      [IDEMPOTENCY_STORE_KEY]: [
        ...records.filter((entry) => entry.key !== key),
        { key, state: "completed", receipt_id: record.receipt_id, completed_at: record.recorded_at },
      ].slice(-receiptLimit),
    });
  }

  async function clearOperation(key) {
    const records = await idempotencyRecords();
    await storage.set({ [IDEMPOTENCY_STORE_KEY]: records.filter((entry) => entry.key !== key) });
  }

  async function receipt(fields) {
    const stored = await storage.get({ [RECEIPT_STORE_KEY]: [] });
    const records = Array.isArray(stored[RECEIPT_STORE_KEY]) ? stored[RECEIPT_STORE_KEY] : [];
    const record = {
      schema: "moa.browser-program-receipt.v1",
      receipt_id: `userscript_${now().getTime()}_${Math.random().toString(36).slice(2, 10)}`,
      recorded_at: now().toISOString(),
      ...fields,
    };
    await storage.set({ [RECEIPT_STORE_KEY]: [...records, record].slice(-receiptLimit) });
    return record;
  }

  async function permissionPresent(origins = null) {
    const permissions = chromeApi?.permissions;
    if (!permissions?.contains) return false;
    try {
      if (!(await permissions.contains({ permissions: ["userScripts"] }))) return false;
      if (!origins?.length) return true;
      return permissions.contains({ origins: origins.map((origin) => `${origin}/*`) });
    } catch {
      return false;
    }
  }

  function supportedApi() {
    const api = chromeApi?.userScripts;
    return Boolean(
      api &&
      typeof api.getScripts === "function" &&
      typeof api.execute === "function" &&
      typeof api.register === "function" &&
      typeof api.update === "function" &&
      typeof api.unregister === "function"
    );
  }

  function absentApiCanBeToggle() {
    const permissions = chromeApi?.runtime?.getManifest?.().permissions;
    return Number.isInteger(chromeMajor) && chromeMajor >= 135 && permissions?.includes("userScripts");
  }

  async function capability(profile) {
    const key = profileOptInKey(profile);
    const stored = await storage.get({ [key]: false });
    if (stored[key] !== true) return { state: CAPABILITY_STATES.DISABLED, profile };
    if (!(await permissionPresent())) return { state: CAPABILITY_STATES.PERMISSION_REVOKED, profile };
    if (!supportedApi()) {
      return {
        state: absentApiCanBeToggle() ? CAPABILITY_STATES.CHROME_TOGGLE_REQUIRED : CAPABILITY_STATES.UNSUPPORTED,
        profile,
      };
    }
    try {
      await chromeApi.userScripts.getScripts();
      return { state: CAPABILITY_STATES.AVAILABLE, profile };
    } catch (error) {
      return { state: CAPABILITY_STATES.CHROME_TOGGLE_REQUIRED, profile, reason: "chrome_user_scripts_unavailable" };
    }
  }

  async function operationState(program) {
    const current = await capability(program.authority.profile);
    if (current.state !== CAPABILITY_STATES.AVAILABLE) return current;
    if (!(await permissionPresent(program.target.origins))) {
      return { state: CAPABILITY_STATES.PERMISSION_REVOKED, profile: program.authority.profile };
    }
    return current;
  }

  async function readBack(id) {
    const scripts = await chromeApi.userScripts.getScripts({ ids: [id] });
    return scripts.find((script) => script.id === id) || null;
  }

  async function rejected(operation, input, error, { validated = false } = {}) {
    const reason = safeReason(error);
    const record = await receipt({
      operation,
      status: "rejected",
      artifact_id: typeof input?.artifact_id === "string" ? input.artifact_id.slice(0, 128) : null,
      revision: Number.isInteger(input?.revision) ? input.revision : null,
      source_sha256: /^sha256:[a-f0-9]{64}$/.test(input?.source_sha256 || "") ? input.source_sha256 : null,
      authority: validated ? receiptAuthority(input) : null,
      reason,
    });
    return { ok: false, status: "rejected", reason, receipt: record };
  }

  async function prepare(operation, input, authorization) {
    let program;
    try {
      program = await validateProgram(input, authorization, subtle);
    } catch (error) {
      return { result: await rejected(operation, input, error) };
    }
    const state = await operationState(program);
    if (state.state !== CAPABILITY_STATES.AVAILABLE) {
      return { result: await rejected(operation, program, state.state) };
    }
    const programs = await storedPrograms();
    const stored = programs[registrationId(program.artifact_id)];
    const sameRevision = stored?.revisions?.find((entry) => entry.revision === program.revision);
    if (sameRevision && programFingerprint(sameRevision) !== programFingerprint(program)) {
      return { result: await rejected(operation, program, "revision_immutable_conflict") };
    }
    return { program, stored };
  }

  async function execute(input, authorization) {
    return serialized(async () => {
      const prepared = await prepare("execute", input, authorization);
      if (prepared.result) return prepared.result;
      const { program } = prepared;
      if (program.mode !== "immediate") return rejected("execute", program, "mode_not_immediate", { validated: true });
      const key = await idempotencyKey("execute", program);
      const existing = await operationRecord(key);
      if (existing?.state === "completed") return { ok: true, status: "idempotent", receipt_id: existing.receipt_id };
      if (existing?.state === "pending") return { ok: false, status: "indeterminate", reason: "operation_already_started" };
      await beginOperation(key);
      try {
        const result = await chromeApi.userScripts.execute({
          target: { tabId: program.target.tab_id, documentIds: [program.target.document_id] },
          js: [{ code: program.source }],
          world: program.world,
          injectImmediately: false,
        });
        const record = await receipt({
          operation: "execute",
          status: "succeeded",
          artifact_id: program.artifact_id,
          revision: program.revision,
          source_sha256: program.source_sha256,
          profile: program.authority.profile,
          authority: receiptAuthority(program),
          world: program.world,
          target: program.target,
          result: receiptResult(result),
        });
        await saveSuccessfulProgram(program);
        await markOperationComplete(key, record);
        return { ok: true, status: "succeeded", result: boundedResult(result), receipt: record };
      } catch (error) {
        return rejected("execute", program, error, { validated: true });
      }
    });
  }

  async function saveSuccessfulProgram(program) {
    const programs = await storedPrograms();
    const id = registrationId(program.artifact_id);
    const previous = programs[id] || { artifact_id: program.artifact_id, active_revision: null, revisions: [] };
    const revisions = previous.revisions.filter((entry) => entry.revision !== program.revision);
    programs[id] = { ...previous, active_revision: program.revision, disabled: false, revisions: [...revisions, program].slice(-10) };
    await writePrograms(programs);
  }

  async function restoreRegistration(before, id) {
    const current = await readBack(id);
    if (before) {
      if (current) await chromeApi.userScripts.update([before]);
      else await chromeApi.userScripts.register([before]);
      return registrationMatches(await readBack(id), before);
    }
    if (current) await chromeApi.userScripts.unregister({ ids: [id] });
    return (await readBack(id)) == null;
  }

  async function persist(operation, input, authorization, precondition = null) {
    return serialized(async () => {
      const prepared = await prepare(operation, input, authorization);
      if (prepared.result) return prepared.result;
      const { program, stored } = prepared;
      if (program.mode !== "persistent") return rejected(operation, program, "mode_not_persistent", { validated: true });
      const key = await idempotencyKey(operation, program);
      const existing = await operationRecord(key);
      if (existing?.state === "completed") return { ok: true, status: "idempotent", receipt_id: existing.receipt_id };
      if (existing?.state === "pending") return { ok: false, status: "indeterminate", reason: "operation_already_started" };
      if (operation === "update") {
        try {
          exactObjectKeys(precondition, ["expected_revision"]);
        } catch {
          return rejected(operation, program, "update_precondition_required", { validated: true });
        }
        if (
          !Number.isInteger(precondition.expected_revision) ||
          stored?.active_revision !== precondition.expected_revision ||
          program.revision !== precondition.expected_revision + 1
        ) return rejected(operation, program, "update_revision_precondition_failed", { validated: true });
      }
      if (operation === "register" && stored?.active_revision != null && stored.active_revision !== program.revision) {
        return rejected(operation, program, "artifact_already_registered", { validated: true });
      }
      const expected = registrationFor(program);
      const before = await readBack(expected.id);
      if (operation === "register" && before && !registrationMatches(before, expected)) {
        return rejected(operation, program, "registration_id_conflict", { validated: true });
      }
      if (operation === "update" && !before) return rejected(operation, program, "registration_missing", { validated: true });
      await beginOperation(key);
      try {
        if (!before) await chromeApi.userScripts.register([expected]);
        else if (!registrationMatches(before, expected)) await chromeApi.userScripts.update([expected]);
        const after = await readBack(expected.id);
        if (!registrationMatches(after, expected)) throw new Error("registration_read_back_mismatch");
        await saveSuccessfulProgram(program);
        const record = await receipt({
          operation,
          status: "succeeded",
          artifact_id: program.artifact_id,
          revision: program.revision,
          source_sha256: program.source_sha256,
          profile: program.authority.profile,
          authority: receiptAuthority(program),
          world: program.world,
          target: program.target,
          registration_id: expected.id,
          registration_read_back: receiptRegistration(after, program.source_sha256),
        });
        await markOperationComplete(key, record);
        return { ok: true, status: "succeeded", registration: normalizedRegistration(after), receipt: record };
      } catch (error) {
        let rollback = "not_needed";
        try {
          if (before) {
            await chromeApi.userScripts.update([before]);
            rollback = registrationMatches(await readBack(expected.id), before) ? "preserved" : "failed";
          } else {
            await chromeApi.userScripts.unregister({ ids: [expected.id] });
            rollback = (await readBack(expected.id)) ? "failed" : "removed";
          }
        } catch {
          rollback = "failed";
        }
        if (rollback === "preserved" || rollback === "removed") await clearOperation(key);
        const result = await rejected(operation, program, error, { validated: true });
        return { ...result, rollback };
      }
    });
  }

  async function removeRegistration(artifactId, { removeSource = false, operation = "disable" } = {}) {
    return serialized(async () => {
      const id = registrationId(artifactId);
      const programs = await storedPrograms();
      const stored = programs[id];
      if (!stored || stored.artifact_id !== artifactId) return rejected(operation, { artifact_id: artifactId }, "program_not_found");
      let before;
      try {
        before = await readBack(id);
        const activeProgram = stored.revisions?.find((program) => program.revision === stored.active_revision);
        if (before && (!activeProgram || !registrationMatches(before, registrationFor(activeProgram)))) {
          throw new Error("registration_state_mismatch");
        }
        await chromeApi.userScripts.unregister({ ids: [id] });
        if (await readBack(id)) throw new Error("registration_removal_unverified");
        if (removeSource) delete programs[id];
        else programs[id] = { ...stored, active_revision: null, disabled: true };
        await writePrograms(programs);
        const record = await receipt({
          operation,
          status: "succeeded",
          artifact_id: artifactId,
          revision: stored.active_revision,
          registration_id: id,
          removal_verified: true,
          source_removed: removeSource,
          authority: stored.revisions?.find((program) => program.revision === stored.active_revision)
            ? receiptAuthority(stored.revisions.find((program) => program.revision === stored.active_revision))
            : null,
        });
        return { ok: true, status: "succeeded", receipt: record };
      } catch (error) {
        let rollback = "failed";
        try {
          rollback = await restoreRegistration(before, id) ? "preserved" : "failed";
        } catch {
          rollback = "failed";
        }
        const active = stored.revisions?.find((program) => program.revision === stored.active_revision);
        const result = await rejected(
          operation,
          active || { artifact_id: artifactId, revision: stored.active_revision },
          error,
          { validated: Boolean(active) },
        );
        return { ...result, rollback };
      }
    });
  }

  async function rollback(artifactId, revision, authorization) {
    const programs = await storedPrograms();
    const stored = programs[registrationId(artifactId)];
    const program = stored?.revisions?.find((entry) => entry.revision === revision);
    if (!program) return rejected("rollback", { artifact_id: artifactId, revision }, "rollback_revision_not_found");
    return persist("rollback", program, authorization);
  }

  async function setProfileEnabled(profile, enabled) {
    return serialized(async () => {
      const key = profileOptInKey(profile);
      if (enabled === true) {
        await storage.set({ [key]: true });
        return capability(profile);
      }
      const programs = await storedPrograms();
      const ids = Object.entries(programs)
        .filter(([, record]) => record.active_revision != null && record.revisions?.some((program) => program.authority?.profile === profile))
        .map(([id]) => id);
      const authorities = ids.map((id) => {
        const record = programs[id];
        return receiptAuthority(record.revisions.find((program) => program.revision === record.active_revision));
      });
      if (!ids.length) {
        await storage.set({ [key]: false });
        return { state: CAPABILITY_STATES.DISABLED, profile };
      }
      if (!supportedApi()) return { ...(await capability(profile)), ok: false, status: "rejected", reason: "unsupported" };
      let before = [];
      try {
        before = await chromeApi.userScripts.getScripts({ ids });
        for (const id of ids) {
          const record = programs[id];
          const activeProgram = record.revisions.find((program) => program.revision === record.active_revision);
          const actual = before.find((registration) => registration.id === id);
          if (!actual || !registrationMatches(actual, registrationFor(activeProgram))) throw new Error("registration_state_mismatch");
        }
        await chromeApi.userScripts.unregister({ ids });
        const remaining = await chromeApi.userScripts.getScripts({ ids });
        if (remaining.length) throw new Error("profile_disable_removal_unverified");
        for (const id of ids) programs[id] = { ...programs[id], active_revision: null, disabled: true };
        await writePrograms(programs);
        await storage.set({ [key]: false });
        await receipt({ operation: "profile_disable", status: "succeeded", profile, authorities, registration_ids: ids, removal_verified: true });
        return { state: CAPABILITY_STATES.DISABLED, profile, ok: true, status: "succeeded" };
      } catch (error) {
        let rollback = "failed";
        try {
          const current = await chromeApi.userScripts.getScripts({ ids });
          const currentById = new Map(current.map((registration) => [registration.id, registration]));
          for (const registration of before) {
            if (currentById.has(registration.id)) await chromeApi.userScripts.update([registration]);
            else await chromeApi.userScripts.register([registration]);
          }
          const restored = await chromeApi.userScripts.getScripts({ ids });
          rollback = before.length === restored.length && before.every((registration) => {
            const actual = restored.find((candidate) => candidate.id === registration.id);
            return registrationMatches(actual, registration);
          }) ? "preserved" : "failed";
        } catch {
          rollback = "failed";
        }
        const record = await receipt({
          operation: "profile_disable",
          status: "rejected",
          profile,
          authorities,
          registration_ids: ids,
          reason: safeReason(error),
          rollback,
        });
        return { ...(await capability(profile)), ok: false, status: "rejected", reason: safeReason(error), rollback, receipt: record };
      }
    });
  }

  return Object.freeze({
    capability,
    execute,
    register: (program, authorization) => persist("register", program, authorization),
    update: (program, authorization, precondition) => persist("update", program, authorization, precondition),
    rollback,
    disable: (artifactId) => removeRegistration(artifactId, { operation: "disable" }),
    unregister: (artifactId) => removeRegistration(artifactId, { operation: "unregister", removeSource: true }),
    setProfileEnabled,
  });
}

export {
  CAPABILITY_STATES,
  DELEGATED_OPT_IN_KEY,
  DELEGATED_PROFILE,
  IDEMPOTENCY_STORE_KEY,
  PROGRAM_STORE_KEY,
  RECEIPT_STORE_KEY,
  REVIEWED_OPT_IN_KEY,
  REVIEWED_PROFILE,
  createUserScriptsRuntime,
  programScopeDigest,
  registrationFor,
  sourceDigest,
  validateProgram,
};
