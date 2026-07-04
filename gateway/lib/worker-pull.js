"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_SCOPES = ["agent_runs:claim", "agent_runs:read_claim", "agent_runs:heartbeat", "agent_runs:append_event", "agent_runs:complete", "agent_runs:observe_cancel"];
const TERMINAL = new Set(["completed", "failed", "timed-out", "canceled"]);

class WorkerPullError extends Error {
  constructor(status, code, message, retryable = false) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

function createWorkerPullStore(options = {}) {
  const dataDir = path.resolve(options.dataDir || "./data");
  const registrationsPath = path.join(dataDir, "worker-registrations.json");
  const workersPath = path.join(dataDir, "workers.json");
  const leaseDurationMs = clamp(options.leaseDurationMs, 5000, 10 * 60_000, 60_000);
  const heartbeatIntervalMs = clamp(options.heartbeatIntervalMs, 1000, 5 * 60_000, 15_000);
  const runStore = validateRunStore(options.runStore || {});
  const recordEvent = typeof options.recordEvent === "function" ? options.recordEvent : null;
  fs.mkdirSync(dataDir, { recursive: true });

  function createRegistration(body = {}, request = {}) {
    const now = Date.now();
    const setupCode = setupCodeValue();
    const registration = {
      id: randomId("wreg"),
      name: truncate(body.name || "Moa worker", 120),
      setup_code_hash: hashSecret(setupCode),
      harness_allowlist: list(body.harness_allowlist || body.harnessAllowlist || ["echo"], sanitizeHarness, 20),
      project_allowlist: list(body.project_allowlist || body.projectAllowlist || [], sanitizeId, 50),
      max_parallel_claims: clamp(body.max_parallel_claims || body.maxParallelClaims, 1, 8, 1),
      expires_at: new Date(now + clamp(body.expires_in_seconds || body.expiresInSeconds, 60, 3600, 600) * 1000).toISOString(),
      created_at: new Date(now).toISOString(),
      created_by: actor(request.actor),
      used_at: "",
      worker_id: "",
    };
    const registrations = rows(registrationsPath);
    registrations.push(registration);
    writeRows(registrationsPath, registrations);
    event("worker.registration.created", { registration_id: registration.id, harness_allowlist: registration.harness_allowlist, project_allowlist: registration.project_allowlist });
    return {
      registration_id: registration.id,
      setup_code: setupCode,
      expires_at: registration.expires_at,
      register_url: "/v1/agent/workers/register",
      constraints: {
        max_parallel_claims: registration.max_parallel_claims,
        harness_allowlist: registration.harness_allowlist,
        project_allowlist: registration.project_allowlist,
      },
    };
  }

  function registerWorker(body = {}) {
    const registrationId = requiredId(body.registration_id || body.registrationId, "registration_id");
    const setupCode = String(body.setup_code || body.setupCode || "").trim();
    if (!setupCode) throw new WorkerPullError(400, "invalid_request", "setup_code is required");
    const registrations = rows(registrationsPath);
    const index = registrations.findIndex((item) => item.id === registrationId);
    if (index < 0) throw new WorkerPullError(404, "registration_not_found", "registration was not found");
    const registration = registrations[index];
    if (registration.used_at) throw new WorkerPullError(409, "registration_used", "registration code was already used");
    if (Date.parse(registration.expires_at || "") < Date.now()) throw new WorkerPullError(410, "registration_expired", "registration code expired");
    if (!safeHashEqual(registration.setup_code_hash, setupCode)) throw new WorkerPullError(401, "invalid_registration_code", "registration code is invalid");

    const workerBody = body.worker && typeof body.worker === "object" ? body.worker : {};
    const workerId = randomId("wrk");
    const tokenId = randomId("wkt");
    const token = `moa_wkt_${crypto.randomBytes(32).toString("base64url")}`;
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const workers = rows(workersPath);
    workers.push({
      id: workerId,
      worker_id: workerId,
      name: truncate(workerBody.name || registration.name || "Moa worker", 120),
      version: truncate(workerBody.version || "", 120),
      machine_label: truncate(workerBody.machine_label || workerBody.machineLabel || "", 120),
      capabilities: capabilities(workerBody.capabilities || {}),
      tokens: [{
        token_id: tokenId,
        token_hash: hashSecret(token),
        scopes: DEFAULT_SCOPES,
        harness_allowlist: registration.harness_allowlist,
        project_allowlist: registration.project_allowlist,
        max_parallel_claims: registration.max_parallel_claims,
        created_at: now,
        expires_at: expiresAt,
        revoked_at: "",
      }],
      created_at: now,
      updated_at: now,
      last_seen_at: "",
    });
    writeRows(workersPath, workers);
    registrations[index] = { ...registration, used_at: now, worker_id: workerId };
    writeRows(registrationsPath, registrations);
    event("worker.registered", { worker_id: workerId, token_id: tokenId });
    return {
      worker_id: workerId,
      worker_token: token,
      token_id: tokenId,
      expires_at: expiresAt,
      claim_url: "/v1/agent/workers/claim",
      websocket_url: "/v1/agent/workers/ws",
      heartbeat_interval_ms: heartbeatIntervalMs,
      lease_duration_ms: leaseDurationMs,
    };
  }

  function authenticate(request, requiredScope) {
    const header = String(request?.headers?.authorization || "");
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    if (!token) throw new WorkerPullError(401, "invalid_worker_token", "missing worker token");
    const tokenHash = hashSecret(token);
    for (const worker of rows(workersPath)) {
      for (const tokenRecord of worker.tokens || []) {
        if (tokenRecord.token_hash !== tokenHash) continue;
        if (tokenRecord.revoked_at || Date.parse(tokenRecord.expires_at || "") < Date.now()) {
          throw new WorkerPullError(401, "invalid_worker_token", "worker token is expired or revoked");
        }
        if (requiredScope && !(tokenRecord.scopes || []).includes(requiredScope)) {
          throw new WorkerPullError(403, "insufficient_scope", `worker token lacks ${requiredScope}`);
        }
        return {
          worker: { worker_id: worker.worker_id || worker.id, name: worker.name || "", version: worker.version || "" },
          token: {
            token_id: tokenRecord.token_id,
            scopes: tokenRecord.scopes || [],
            harness_allowlist: tokenRecord.harness_allowlist || [],
            project_allowlist: tokenRecord.project_allowlist || [],
            max_parallel_claims: tokenRecord.max_parallel_claims || 1,
            expires_at: tokenRecord.expires_at,
          },
        };
      }
    }
    throw new WorkerPullError(401, "invalid_worker_token", "worker token is invalid");
  }

  function claim(body = {}, auth) {
    requireScope(auth, "agent_runs:claim");
    const workerId = requiredId(body.worker_id || body.workerId, "worker_id");
    if (workerId !== auth.worker.worker_id) throw new WorkerPullError(403, "insufficient_scope", "worker_id does not match token");
    if (String(body.transport || "long_poll") !== "long_poll") throw new WorkerPullError(400, "invalid_request", "only long_poll transport is implemented");
    cleanupExpiredClaims();
    const acceptedHarnesses = intersect(list(body.accepted_harnesses || body.acceptedHarnesses || auth.token.harness_allowlist, sanitizeHarness, 20), auth.token.harness_allowlist);
    const acceptedProjects = intersect(list(body.accepted_projects || body.acceptedProjects || auth.token.project_allowlist, sanitizeId, 50), auth.token.project_allowlist);
    const run = nextRun(acceptedHarnesses, acceptedProjects);
    if (!run) return { claimed: false, retry_after_ms: 1000, server_time: new Date().toISOString() };

    const now = new Date();
    const claimId = randomId("clm");
    const lease = new Date(now.getTime() + leaseDurationMs).toISOString();
    const attempt = Number(run.attempt || 0) + 1;
    const next = runStore.updateRun(run.id, {
      status: "claimed",
      attempt,
      max_attempts: Number(run.max_attempts || 2),
      claimed_by_worker_id: workerId,
      claim_id: claimId,
      lease_expires_at: lease,
      last_heartbeat_at: now.toISOString(),
      retry_after_at: null,
      retry_reason: "",
      updated_at: now.toISOString(),
    });
    runStore.appendEvent(run.id, "claimed", { worker_id: workerId, claim_id: claimId, attempt, lease_expires_at: lease });
    event("worker.run.claimed", { worker_id: workerId, run_id: run.id, claim_id: claimId });
    return {
      claimed: true,
      claim: {
        claim_id: claimId,
        run_id: next.id,
        worker_id: workerId,
        attempt,
        lease_expires_at: lease,
        heartbeat_interval_ms: heartbeatIntervalMs,
        event_url: `/v1/agent/runs/${next.id}/events`,
        heartbeat_url: `/v1/agent/runs/${next.id}/heartbeat`,
        result_url: `/v1/agent/runs/${next.id}/result`,
      },
      run: claimPayload(next),
    };
  }

  function heartbeat(runId, body = {}, auth) {
    requireScope(auth, "agent_runs:heartbeat");
    const run = currentClaim(runId, body, auth);
    const now = new Date();
    const lease = new Date(now.getTime() + leaseDurationMs).toISOString();
    const status = String(body.status || "running").toLowerCase() === "claimed" ? "claimed" : "running";
    runStore.updateRun(run.id, { status, last_heartbeat_at: now.toISOString(), lease_expires_at: lease, progress: json(body.progress || {}), updated_at: now.toISOString() });
    runStore.appendEvent(run.id, "heartbeat", { worker_id: auth.worker.worker_id, claim_id: run.claim_id, status, progress: json(body.progress || {}), last_event_seq: Number(body.last_event_seq || body.lastEventSeq || 0) || 0, observed_at: iso(body.observed_at || body.observedAt || now.toISOString(), now.toISOString()) });
    return { ok: true, run_id: run.id, claim_id: run.claim_id, lease_expires_at: lease, cancel_requested: cancelRequested(run.id), server_time: new Date().toISOString() };
  }

  function appendEvents(runId, body = {}, auth) {
    requireScope(auth, "agent_runs:append_event");
    const run = currentClaim(runId, body, auth);
    const events = Array.isArray(body.events) ? body.events : [];
    if (!events.length) throw new WorkerPullError(400, "invalid_request", "events array is required");
    if (events.length > 50) throw new WorkerPullError(413, "event_too_large", "event batch is too large");
    const seen = new Set(runStore.readEvents(run.id).map((eventRow) => eventRow.worker_event_id || eventRow.event_id || "").filter(Boolean));
    let accepted = 0;
    let duplicate = 0;
    let lastSeq = Number(run.last_worker_event_seq || 0) || 0;
    for (const input of events) {
      const eventId = optionalId(input?.event_id || input?.eventId) || randomId("wevt");
      const seq = Math.max(0, Number(input?.seq || 0) || 0);
      lastSeq = Math.max(lastSeq, seq);
      if (seen.has(eventId)) {
        duplicate += 1;
        continue;
      }
      seen.add(eventId);
      runStore.appendEvent(run.id, eventType(input?.type || "worker_event"), { worker_id: auth.worker.worker_id, claim_id: run.claim_id, worker_event_id: eventId, seq, observed_at: iso(input?.observed_at || input?.observedAt || new Date().toISOString(), new Date().toISOString()), data: json(input?.data || {}) });
      accepted += 1;
    }
    runStore.updateRun(run.id, { status: run.status === "claimed" ? "running" : run.status, last_worker_event_seq: lastSeq, updated_at: new Date().toISOString() });
    return { ok: true, accepted, duplicate, last_event_seq: lastSeq, cancel_requested: cancelRequested(run.id) };
  }

  function result(runId, body = {}, auth) {
    requireScope(auth, "agent_runs:complete");
    const run = currentClaim(runId, body, auth);
    if (TERMINAL.has(run.status)) throw new WorkerPullError(409, "stale_claim", "run already has a terminal result");
    const status = String(body.status || "").toLowerCase();
    if (!TERMINAL.has(status)) throw new WorkerPullError(400, "invalid_request", "status must be completed, failed, timed-out, or canceled");
    const finished = iso(body.finished_at || body.finishedAt || new Date().toISOString(), new Date().toISOString());
    const artifacts = artifactRefs(body.artifacts || []);
    const deployments = deploymentRefs(body.deployments || []);
    const stdoutTail = truncate(body.stdout_tail || body.stdoutTail || "", 16000);
    const stderrTail = truncate(body.stderr_tail || body.stderrTail || "", 16000);
    const next = runStore.updateRun(run.id, {
      status,
      worker_id: auth.worker.worker_id,
      claimed_by_worker_id: auth.worker.worker_id,
      claim_id: run.claim_id,
      finished_at: finished,
      updated_at: finished,
      exit_code: body.exit_code == null ? null : Number(body.exit_code),
      signal: body.signal == null ? null : truncate(body.signal, 80),
      error: truncate(body.error || "", 4000),
      output: truncate(body.output || stdoutTail || stderrTail || "", 120000),
      stdout: appendTail(run.stdout || "", stdoutTail, 120000),
      stderr: appendTail(run.stderr || "", stderrTail, 120000),
      session_id: truncate(body.session_id || body.sessionId || run.session_id || "", 200),
      artifact_refs: artifacts.map((item) => item.artifact_id).filter(Boolean),
      deployment_refs: deployments.map((item) => item.candidate_id).filter(Boolean),
      output_artifact_refs: artifacts,
      deployment_candidate_refs: deployments,
    });
    runStore.appendEvent(run.id, status, { worker_id: auth.worker.worker_id, claim_id: run.claim_id, exit_code: next.exit_code, signal: next.signal, error: next.error, artifact_refs: next.artifact_refs || [], deployment_refs: next.deployment_refs || [] });
    event("worker.run.result", { worker_id: auth.worker.worker_id, run_id: run.id, claim_id: run.claim_id, status });
    return { ok: true, run: { id: next.id, status: next.status, worker_id: auth.worker.worker_id, claim_id: run.claim_id, finished_at: next.finished_at, artifact_refs: next.artifact_refs || [], deployment_refs: next.deployment_refs || [] } };
  }

  function status() {
    const runs = runStore.listRunsRaw();
    return {
      storage: "json-file",
      worker_count: rows(workersPath).length,
      pending_registration_count: rows(registrationsPath).filter((item) => !item.used_at && Date.parse(item.expires_at || "") > Date.now()).length,
      queued_run_count: runs.filter((run) => run.status === "queued").length,
      claimed_run_count: runs.filter((run) => run.status === "claimed" || run.status === "running").length,
      lease_duration_ms: leaseDurationMs,
      heartbeat_interval_ms: heartbeatIntervalMs,
    };
  }

  function cleanupExpiredClaims() {
    const now = Date.now();
    for (const run of runStore.listRunsRaw()) {
      if (!["claimed", "running"].includes(run.status)) continue;
      const expires = Date.parse(run.lease_expires_at || "");
      if (!Number.isFinite(expires) || expires >= now) continue;
      runStore.appendEvent(run.id, "claim_expired", { worker_id: run.claimed_by_worker_id || "", claim_id: run.claim_id || "", lease_expires_at: run.lease_expires_at || "" });
      const attempt = Number(run.attempt || 0);
      const maxAttempts = Number(run.max_attempts || 2);
      if (attempt < maxAttempts && !cancelRequested(run.id)) {
        runStore.updateRun(run.id, { status: "queued", claimed_by_worker_id: "", claim_id: "", lease_expires_at: "", retry_after_at: new Date(now + 1000).toISOString(), retry_reason: "worker claim expired", updated_at: new Date().toISOString() });
      } else {
        const ts = new Date().toISOString();
        runStore.updateRun(run.id, { status: "failed", error: "worker claim expired", finished_at: ts, updated_at: ts });
        runStore.appendEvent(run.id, "failed", { error: "worker claim expired" });
      }
    }
  }

  function nextRun(acceptedHarnesses, acceptedProjects) {
    const now = Date.now();
    return runStore.listRunsRaw()
      .filter((run) => run.status === "queued")
      .filter((run) => {
        const retry = Date.parse(run.retry_after_at || "");
        return !Number.isFinite(retry) || retry <= now;
      })
      .filter((run) => !acceptedHarnesses.length || acceptedHarnesses.includes(String(run.harness || "")))
      .filter((run) => {
        const projectId = String(run.project_id || "");
        return !acceptedProjects.length || (projectId && acceptedProjects.includes(projectId));
      })
      .sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")))[0] || null;
  }

  function currentClaim(runId, body, auth) {
    const id = requiredId(runId, "run_id");
    if (!runStore.exists(id)) throw new WorkerPullError(404, "run_not_found", "run does not exist");
    const run = runStore.readRun(id);
    const workerId = requiredId(body.worker_id || body.workerId, "worker_id");
    const claimId = requiredId(body.claim_id || body.claimId, "claim_id");
    if (workerId !== auth.worker.worker_id) throw new WorkerPullError(403, "insufficient_scope", "worker_id does not match token");
    if (run.claimed_by_worker_id !== workerId || run.claim_id !== claimId) throw new WorkerPullError(409, "stale_claim", "claim is no longer current for this run");
    if (!tokenAllowsRun(auth.token, run)) throw new WorkerPullError(403, "insufficient_scope", "token is not allowed for this run");
    return run;
  }

  function tokenAllowsRun(token, run) {
    if ((token.harness_allowlist || []).length && !token.harness_allowlist.includes(String(run.harness || ""))) return false;
    if ((token.project_allowlist || []).length && !token.project_allowlist.includes(String(run.project_id || ""))) return false;
    return true;
  }

  function cancelRequested(runId) {
    const run = runStore.exists(runId) ? runStore.readRun(runId) : null;
    return run?.cancel_requested === true || runStore.readEvents(runId).some((item) => item.type === "cancel_requested");
  }

  function event(type, payload) {
    if (!recordEvent) return;
    recordEvent({ event_type: type, stream_id: payload.run_id ? `run:${payload.run_id}` : "worker-pull", idempotency_key: `worker-pull:${type}:${payload.run_id || payload.worker_id || payload.registration_id || randomId("evt")}:${payload.claim_id || ""}`, occurred_at: new Date().toISOString(), actor: { kind: "gateway", id: "worker-pull" }, correlation_id: payload.run_id || payload.worker_id || payload.registration_id || "", payload });
  }

  return { createRegistration, registerWorker, authenticate, claim, heartbeat, appendEvents, result, status, cleanupExpiredClaims };
}

function claimPayload(run) {
  const conversationId = optionalId(run.conversation_id || run.session_id || "default") || "default";
  const projectId = optionalId(run.project_id || "proj_default") || "proj_default";
  return {
    id: run.id,
    status: "claimed",
    harness: String(run.harness || "echo"),
    prompt: String(run.prompt || ""),
    source: String(run.source || ""),
    timeout_ms: Number(run.timeout_ms || 0),
    resume_session_id: String(run.resume_session_id || ""),
    working_dir: { project_id: projectId, local_alias: localAlias(run.local_project_alias || run.project_alias || projectId) },
    session: {
      session_id: conversationId,
      conversation_id: conversationId,
      branch_id: optionalId(run.branch_id || "default") || "default",
      turn_id: optionalId(run.turn_id || ""),
      broker_event_id: optionalId(run.broker_event_id || ""),
      route_decision_id: optionalId(run.route_decision_id || ""),
    },
    work: {
      work_node_id: optionalId(run.work_node_id || ""),
      context_pack_ref: ref(run.context_pack_ref || ""),
      parent_run_id: optionalId(run.parent_run_id || ""),
      project_id: projectId,
      profile_version: optionalId(run.profile_version || ""),
    },
    artifacts: { input_refs: artifactRefs(run.input_artifact_refs || run.artifacts?.input_refs || []), output_refs: artifactRefs(run.output_artifact_refs || run.artifacts?.output_refs || []) },
    deployments: { candidate_refs: deploymentRefs(run.deployment_candidate_refs || run.deployments?.candidate_refs || []), apply_allowed: false, promotion_gate: "human" },
  };
}

function validateRunStore(runStore) {
  for (const key of ["exists", "readRun", "updateRun", "appendEvent", "readEvents", "listRunsRaw"]) {
    if (typeof runStore[key] !== "function") throw new Error(`worker pull runStore.${key} is required`);
  }
  return runStore;
}

function rows(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeRows(filePath, value) {
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2));
  fs.renameSync(tmpPath, filePath);
}

function hashSecret(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function safeHashEqual(expectedHash, plaintext) {
  const expected = Buffer.from(String(expectedHash || ""), "hex");
  const actual = Buffer.from(hashSecret(plaintext), "hex");
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function setupCodeValue() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let value = "";
  for (let i = 0; i < 8; i += 1) value += alphabet[crypto.randomInt(0, alphabet.length)];
  return `MOA-WORKER-${value.slice(0, 4)}-${value.slice(4)}`;
}

function capabilities(value) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    transports: list(input.transports || [], (item) => ["long_poll", "websocket"].includes(String(item)) ? String(item) : "", 10),
    harnesses: Array.isArray(input.harnesses) ? input.harnesses.slice(0, 20).map((item) => ({ id: sanitizeHarness(item?.id || item?.name || ""), version: truncate(item?.version || "", 120), supports_resume: item?.supports_resume === true || item?.supportsResume === true })).filter((item) => item.id) : [],
    projects: Array.isArray(input.projects) ? input.projects.slice(0, 50).map((item) => ({ id: sanitizeId(item?.id || ""), local_alias: localAlias(item?.local_alias || item?.localAlias || item?.id || ""), path_policy: "local_allowlist" })).filter((item) => item.id) : [],
  };
}

function requireScope(auth, scope) {
  if (!auth?.worker || !auth?.token) throw new WorkerPullError(401, "invalid_worker_token", "missing worker auth");
  if (scope && !(auth.token.scopes || []).includes(scope)) throw new WorkerPullError(403, "insufficient_scope", `worker token lacks ${scope}`);
}

function list(value, mapper, limit) {
  const raw = Array.isArray(value) ? value : String(value || "").split(",");
  return [...new Set(raw.slice(0, limit).map(mapper).filter(Boolean))];
}

function intersect(requested, allowed) {
  if (!allowed?.length) return requested || [];
  const allowedSet = new Set(allowed);
  return (requested || []).filter((item) => allowedSet.has(item));
}

function requiredId(value, field) {
  const id = sanitizeId(value);
  if (!id) throw new WorkerPullError(400, "invalid_request", `${field} is required`);
  return id;
}

function sanitizeId(value) {
  return String(value || "").trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 120);
}

function optionalId(value) {
  return sanitizeId(value);
}

function sanitizeHarness(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 80);
}

function eventType(value) {
  return String(value || "worker_event").trim().toLowerCase().replace(/[^a-z0-9_.:-]/g, "_").slice(0, 120) || "worker_event";
}

function localAlias(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9_.:-]/g, "-").slice(0, 120) || "default";
}

function ref(value) {
  return String(value || "").trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/[^a-zA-Z0-9_./:-]/g, "").slice(0, 500);
}

function json(value, depth = 0) {
  if (depth > 5) return null;
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return truncate(value, 4000);
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => json(item, depth + 1));
  if (typeof value === "object") {
    const output = {};
    for (const [key, item] of Object.entries(value).slice(0, 80)) output[String(key).slice(0, 120)] = json(item, depth + 1);
    return output;
  }
  return String(value).slice(0, 200);
}

function artifactRefs(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 50).map((item) => item && typeof item === "object" && !Array.isArray(item) ? { artifact_id: optionalId(item.artifact_id || item.artifactId || ""), kind: String(item.kind || "").replace(/[^a-zA-Z0-9_.:-]/g, "").slice(0, 80), uri: ref(item.uri || ""), sha256: String(item.sha256 || "").replace(/[^a-fA-F0-9]/g, "").slice(0, 64) } : null).filter((item) => item && (item.artifact_id || item.uri));
}

function deploymentRefs(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).map((item) => item && typeof item === "object" && !Array.isArray(item) ? { candidate_id: optionalId(item.candidate_id || item.candidateId || item.id || ""), target: String(item.target || "").replace(/[^a-zA-Z0-9_.:-]/g, "").slice(0, 120), preview_url: url(item.preview_url || item.previewUrl || ""), applied: false, apply_allowed: false } : null).filter((item) => item && (item.candidate_id || item.preview_url));
}

function url(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.href : "";
  } catch {
    return "";
  }
}

function actor(value) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return { kind: String(input.kind || "gateway").replace(/[^a-zA-Z0-9_.:-]/g, "").slice(0, 40) || "gateway", id: optionalId(input.id || "worker-pull") || "worker-pull" };
}

function iso(value, fallback) {
  const ms = Date.parse(String(value || ""));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : fallback;
}

function appendTail(current, tail, max) {
  const next = [String(current || "").trim(), String(tail || "").trim()].filter(Boolean).join("\n");
  return next.length > max ? next.slice(next.length - max) : next;
}

function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

function truncate(value, max) {
  const text = String(value || "");
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

module.exports = { WorkerPullError, createWorkerPullStore };
