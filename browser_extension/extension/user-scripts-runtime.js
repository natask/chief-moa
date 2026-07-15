const REVIEWED_PROFILE = "reviewed_standalone_v1";
const DELEGATED_PROFILE = "delegated_runtime_v1";
const REVIEWED_OPT_IN_KEY = "ageeReviewedUserScriptsEnabled";
const DELEGATED_OPT_IN_KEY = "ageeDelegatedUserScriptsEnabled";
const PROGRAM_STORE_KEY = "ageeUserScriptPrograms";
const RECEIPT_STORE_KEY = "ageeUserScriptReceipts";
const RECEIPT_LIMIT = 100;
const SOURCE_MAX_BYTES = 128 * 1024;
const RESULT_MAX_BYTES = 16 * 1024;
const MAX_PATTERNS = 16;

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

function approvalBinding(program) {
  return {
    artifact_id: program.artifact_id,
    revision: program.revision,
    source_sha256: program.source_sha256,
    mode: program.mode,
    world: program.world,
    run_at: program.run_at,
    target: program.target,
  };
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
    authority: {
      profile,
      role: input.authority?.role || null,
      task_id: boundedAuthorityId(input.authority?.task_id),
      run_id: boundedAuthorityId(input.authority?.run_id),
      delegation_envelope_id: boundedAuthorityId(input.authority?.delegation_envelope_id),
      approval_id: boundedAuthorityId(input.authority?.approval_id),
    },
  };
  if (profile === REVIEWED_PROFILE) {
    if (input.world !== "USER_SCRIPT") throw new Error("reviewed_world_rejected");
    if (!program.authority.approval_id || authorization?.approval_id !== program.authority.approval_id) throw new Error("approval_missing");
    if (stableJson(authorization?.binding) !== stableJson(approvalBinding(program))) throw new Error("approval_scope_mismatch");
  } else {
    if (program.authority.role !== "delegate" || !program.authority.delegation_envelope_id) throw new Error("delegation_missing");
    if (authorization?.envelope_id !== program.authority.delegation_envelope_id || authorization?.current !== true) throw new Error("delegation_invalid");
    const effect = input.mode === "persistent" ? "script.persist" : "script.evaluate";
    if (!authorization?.effect_classes?.includes(effect)) throw new Error("delegation_effect_rejected");
    if (input.world === "MAIN" && authorization?.grants?.main_world !== true) throw new Error("main_world_grant_required");
    if (stableJson(authorization?.target) !== stableJson(target)) throw new Error("delegation_scope_mismatch");
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

function createUserScriptsRuntime({ chromeApi = globalThis.chrome, now = () => new Date(), subtle = globalThis.crypto?.subtle, receiptLimit = RECEIPT_LIMIT } = {}) {
  const storage = chromeApi?.storage?.local;
  let operationQueue = Promise.resolve();

  function serialized(operation) {
    const next = operationQueue.then(operation, operation);
    operationQueue = next.catch(() => {});
    return next;
  }

  async function storedPrograms() {
    const stored = await storage.get({ [PROGRAM_STORE_KEY]: {} });
    return stored[PROGRAM_STORE_KEY] && typeof stored[PROGRAM_STORE_KEY] === "object" ? stored[PROGRAM_STORE_KEY] : {};
  }

  async function writePrograms(programs) {
    await storage.set({ [PROGRAM_STORE_KEY]: programs });
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

  async function capability(profile) {
    const key = profileOptInKey(profile);
    const stored = await storage.get({ [key]: false });
    if (stored[key] !== true) return { state: CAPABILITY_STATES.DISABLED, profile };
    if (!supportedApi()) return { state: CAPABILITY_STATES.UNSUPPORTED, profile };
    if (!(await permissionPresent())) return { state: CAPABILITY_STATES.PERMISSION_REVOKED, profile };
    try {
      await chromeApi.userScripts.getScripts();
      return { state: CAPABILITY_STATES.AVAILABLE, profile };
    } catch (error) {
      return { state: CAPABILITY_STATES.CHROME_TOGGLE_REQUIRED, profile, reason: String(error?.message || error).slice(0, 200) };
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

  async function rejected(operation, input, error) {
    const reason = String(error?.message || error || "rejected").slice(0, 200);
    const record = await receipt({
      operation,
      status: "rejected",
      artifact_id: typeof input?.artifact_id === "string" ? input.artifact_id.slice(0, 128) : null,
      revision: Number.isInteger(input?.revision) ? input.revision : null,
      source_sha256: /^sha256:[a-f0-9]{64}$/.test(input?.source_sha256 || "") ? input.source_sha256 : null,
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
    return { program };
  }

  async function execute(input, authorization) {
    return serialized(async () => {
      const prepared = await prepare("execute", input, authorization);
      if (prepared.result) return prepared.result;
      const { program } = prepared;
      if (program.mode !== "immediate") return rejected("execute", program, "mode_not_immediate");
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
          world: program.world,
          target: program.target,
          result: boundedResult(result),
        });
        return { ok: true, status: "succeeded", result: boundedResult(result), receipt: record };
      } catch (error) {
        return rejected("execute", program, error);
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

  async function persist(operation, input, authorization) {
    return serialized(async () => {
      const prepared = await prepare(operation, input, authorization);
      if (prepared.result) return prepared.result;
      const { program } = prepared;
      if (program.mode !== "persistent") return rejected(operation, program, "mode_not_persistent");
      const expected = registrationFor(program);
      const before = await readBack(expected.id);
      if (operation === "register" && before && !registrationMatches(before, expected)) return rejected(operation, program, "registration_id_conflict");
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
          world: program.world,
          target: program.target,
          registration_id: expected.id,
          registration_read_back: receiptRegistration(after, program.source_sha256),
        });
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
        const result = await rejected(operation, program, error);
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
      try {
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
        });
        return { ok: true, status: "succeeded", receipt: record };
      } catch (error) {
        return rejected(operation, { artifact_id: artifactId, revision: stored.active_revision }, error);
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
    const key = profileOptInKey(profile);
    await storage.set({ [key]: enabled === true });
    if (enabled === true) return capability(profile);
    const programs = await storedPrograms();
    const ids = Object.entries(programs)
      .filter(([, record]) => record.revisions?.some((program) => program.authority?.profile === profile))
      .map(([id]) => id);
    if (ids.length && supportedApi()) {
      try {
        await chromeApi.userScripts.unregister({ ids });
        const remaining = await chromeApi.userScripts.getScripts({ ids });
        if (remaining.length) throw new Error("profile_disable_removal_unverified");
        for (const id of ids) programs[id] = { ...programs[id], active_revision: null, disabled: true };
        await writePrograms(programs);
        await receipt({ operation: "profile_disable", status: "succeeded", profile, registration_ids: ids, removal_verified: true });
      } catch (error) {
        await receipt({ operation: "profile_disable", status: "rejected", profile, registration_ids: ids, reason: String(error?.message || error).slice(0, 200) });
      }
    }
    return { state: CAPABILITY_STATES.DISABLED, profile };
  }

  return Object.freeze({
    capability,
    execute,
    register: (program, authorization) => persist("register", program, authorization),
    update: (program, authorization) => persist("update", program, authorization),
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
  PROGRAM_STORE_KEY,
  RECEIPT_STORE_KEY,
  REVIEWED_OPT_IN_KEY,
  REVIEWED_PROFILE,
  approvalBinding,
  createUserScriptsRuntime,
  registrationFor,
  sourceDigest,
  validateProgram,
};
