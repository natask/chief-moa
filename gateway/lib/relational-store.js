"use strict";

const crypto = require("node:crypto");

const { appendEventOnClient, withTransaction } = require("./event-substrate");

const TENANT_EVENT_SCOPE_VERSION = "tenant-event-scope.v1";

function createRelationalStore(options = {}) {
  if (!options.pool || typeof options.pool.connect !== "function") {
    throw new Error("createRelationalStore requires a pg pool");
  }
  const pool = options.pool;
  const originId = options.originId;
  const userId = trustedUserId(options.userId);

  return {
    upsertSession(record = {}) {
      return withTransaction(pool, (client) => upsertSessionOnClient(client, record, { originId, userId }));
    },
    upsertBranch(record = {}) {
      return withTransaction(pool, (client) => upsertBranchOnClient(client, record, { originId, userId }));
    },
    upsertChatTurn(record = {}) {
      return withTransaction(pool, (client) => upsertChatTurnOnClient(client, record, { originId, userId }));
    },
    upsertVoiceTurn(record = {}) {
      return withTransaction(pool, (client) => upsertVoiceTurnOnClient(client, record, { originId, userId }));
    },
    upsertAgentRun(record = {}) {
      return withTransaction(pool, (client) => upsertAgentRunOnClient(client, record, { originId, userId }));
    },
    upsertBrowserTask(record = {}) {
      return withTransaction(pool, (client) => upsertBrowserTaskOnClient(client, record, { originId, userId }));
    },
    upsertToolRequest(record = {}) {
      return withTransaction(pool, (client) => upsertToolRequestOnClient(client, record, { originId, userId }));
    },
  };
}

async function upsertSessionOnClient(client, input, options) {
  const record = objectRecord(input);
  const id = text(record.id || record.session_id || record.sessionId);
  if (!id) throw new Error("session id is required");

  const now = new Date().toISOString();
  const createdAt = timestamp(record.created_at || record.createdAt, now);
  const updatedAt = timestamp(record.updated_at || record.updatedAt || record.created_at || record.createdAt, now);
  const data = restData(record, [
    "id", "session_id", "sessionId", "user_id", "userId", "kind", "label",
    "created_at", "createdAt", "updated_at", "updatedAt",
  ]);
  const rowResult = await client.query(
    `insert into sessions (
       id, user_id, kind, label, data, created_at, updated_at
     ) values (
       $1, $2, $3, $4, $5::jsonb, $6::timestamptz, $7::timestamptz
     )
     on conflict (id) do update set
       user_id = excluded.user_id,
       kind = excluded.kind,
       label = excluded.label,
       data = excluded.data,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at
     where sessions.user_id = excluded.user_id
     returning *, (xmax = 0) as inserted`,
    [
      id,
      userIdFor(record, options.userId),
      text(record.kind, "default"),
      text(record.label),
      JSON.stringify(data),
      createdAt,
      updatedAt,
    ],
  );

  return withEventResult(client, rowResult.rows[0], {
    event_type: "session.upserted",
    stream_id: sessionStreamId(id),
    idempotency_key: `session:${id}:upserted`,
    occurred_at: updatedAt,
    actor: { kind: "gateway", id: "relational-store" },
    correlation_id: id,
    payload: {
      session_id: id,
      kind: text(record.kind, "default"),
      label: text(record.label),
    },
  }, options);
}

async function upsertBranchOnClient(client, input, options) {
  const record = objectRecord(input);
  const sessionId = text(record.session_id || record.sessionId);
  const branchId = text(record.branch_id || record.branchId || record.id, "default");
  if (!sessionId) throw new Error("branch session_id is required");

  const now = new Date().toISOString();
  const createdAt = timestamp(record.created_at || record.createdAt, now);
  const updatedAt = timestamp(record.updated_at || record.updatedAt || record.created_at || record.createdAt, now);
  const data = restData(record, [
    "id", "session_id", "sessionId", "branch_id", "branchId", "user_id", "userId",
    "kind", "parent_branch_id", "parentBranchId", "fork_point", "forkPoint",
    "label", "summary", "created_at", "createdAt", "updated_at", "updatedAt",
  ]);
  const rowResult = await client.query(
    `insert into branches (
       session_id, branch_id, user_id, kind, parent_branch_id, fork_point,
       label, summary, data, created_at, updated_at
     ) values (
       $1, $2, $3, $4, $5, $6,
       $7, $8, $9::jsonb, $10::timestamptz, $11::timestamptz
     )
     on conflict (session_id, branch_id) do update set
       user_id = excluded.user_id,
       kind = excluded.kind,
       parent_branch_id = excluded.parent_branch_id,
       fork_point = excluded.fork_point,
       label = excluded.label,
       summary = excluded.summary,
       data = excluded.data,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at
     where branches.user_id = excluded.user_id
     returning *, (xmax = 0) as inserted`,
    [
      sessionId,
      branchId,
      userIdFor(record, options.userId),
      text(record.kind, "default"),
      nullableText(record.parent_branch_id || record.parentBranchId),
      nullableText(record.fork_point || record.forkPoint),
      text(record.label),
      text(record.summary),
      JSON.stringify(data),
      createdAt,
      updatedAt,
    ],
  );

  return withEventResult(client, rowResult.rows[0], {
    event_type: "branch.upserted",
    stream_id: sessionStreamId(sessionId),
    idempotency_key: `branch:${sessionId}:${branchId}:upserted`,
    occurred_at: updatedAt,
    actor: { kind: "gateway", id: "relational-store" },
    correlation_id: branchId,
    payload: {
      session_id: sessionId,
      branch_id: branchId,
      kind: text(record.kind, "default"),
      parent_branch_id: nullableText(record.parent_branch_id || record.parentBranchId),
      fork_point: nullableText(record.fork_point || record.forkPoint),
      label: text(record.label),
      summary: text(record.summary),
    },
  }, options);
}

async function upsertChatTurnOnClient(client, input, options) {
  const record = objectRecord(input);
  const turnId = text(record.turn_id || record.turnId || record.id);
  if (!turnId) throw new Error("chat turn id is required");

  const sessionId = text(record.session_id || record.sessionId || record.conversation_id || record.conversationId, "default");
  const branchId = text(record.branch_id || record.branchId, "default");
  const now = new Date().toISOString();
  const occurredAt = timestamp(record.occurred_at || record.occurredAt || record.ts || record.updated_at || record.updatedAt || record.created_at || record.createdAt, now);
  const createdAt = timestamp(record.created_at || record.createdAt || record.ts || occurredAt, now);
  const updatedAt = timestamp(record.updated_at || record.updatedAt || record.ts || occurredAt, createdAt);
  const data = restData(record, [
    "id", "user_id", "userId", "session_id", "sessionId", "branch_id", "branchId",
    "turn_id", "turnId", "device_id", "deviceId", "source", "model",
    "profile_version", "profileVersion", "occurred_at", "occurredAt",
    "created_at", "createdAt", "updated_at", "updatedAt", "ts",
  ]);
  if (text(record.id) && text(record.id) !== turnId && !data.conversation_id) {
    data.conversation_id = text(record.id);
  }
  const rowResult = await client.query(
    `insert into turns (
       id, user_id, session_id, branch_id, turn_id, device_id, source, model,
       profile_version, data, occurred_at, created_at, updated_at
     ) values (
       $1, $2, $3, $4, $5, $6, $7, $8,
       $9, $10::jsonb, $11::timestamptz, $12::timestamptz, $13::timestamptz
     )
     on conflict (id) do update set
       user_id = excluded.user_id,
       session_id = excluded.session_id,
       branch_id = excluded.branch_id,
       turn_id = excluded.turn_id,
       device_id = excluded.device_id,
       source = excluded.source,
       model = excluded.model,
       profile_version = excluded.profile_version,
       data = excluded.data,
       occurred_at = excluded.occurred_at,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at
     where turns.user_id = excluded.user_id
     returning *, (xmax = 0) as inserted`,
    [
      turnId,
      userIdFor(record, options.userId),
      sessionId,
      branchId,
      turnId,
      nullableText(record.device_id || record.deviceId),
      nullableText(record.source),
      nullableText(record.model),
      nullableText(record.profile_version || record.profileVersion),
      JSON.stringify(data),
      occurredAt,
      createdAt,
      updatedAt,
    ],
  );

  const userText = chatUserText(record);
  const responseText = chatResponseText(record);
  return withEventResult(client, rowResult.rows[0], {
    event_type: "chat.turn.completed",
    stream_id: sessionStreamId(sessionId),
    idempotency_key: `chat:${sessionId}:${turnId}:completed`,
    occurred_at: updatedAt,
    actor: { kind: "user", id: text(record.device_id || record.deviceId || record.source, "chat") },
    correlation_id: turnId,
    payload: {
      conversation_id: text(record.conversation_id || record.conversationId || record.id),
      session_id: sessionId,
      branch_id: branchId,
      turn_id: turnId,
      source: text(record.source),
      device_id: text(record.device_id || record.deviceId),
      model: text(record.model),
      profile_version: text(record.profile_version || record.profileVersion),
      user_text: truncate(userText, 4000),
      response_text: truncate(responseText, 4000),
    },
  }, options);
}

async function upsertVoiceTurnOnClient(client, input, options) {
  const record = objectRecord(input);
  const turnId = text(record.turn_id || record.turnId || record.id);
  if (!turnId) throw new Error("voice turn id is required");

  const sessionId = text(record.session_id || record.sessionId || record.conversation_id || record.conversationId, "default");
  const branchId = text(record.branch_id || record.branchId, "default");
  const now = new Date().toISOString();
  const occurredAt = timestamp(record.occurred_at || record.occurredAt || record.updated_at || record.updatedAt || record.created_at || record.createdAt, now);
  const createdAt = timestamp(record.created_at || record.createdAt || occurredAt, now);
  const data = restData(record, [
    "id", "user_id", "userId", "session_id", "sessionId", "conversation_id",
    "conversationId", "branch_id", "branchId", "turn_id", "turnId",
    "profile_version", "profileVersion", "classification", "source",
    "transcript", "blob_ref", "blobRef", "blob_sha256", "blobSha256",
    "occurred_at", "occurredAt", "created_at", "createdAt",
  ]);
  const rowResult = await client.query(
    `insert into voice_turns (
       id, user_id, session_id, conversation_id, branch_id, turn_id,
       profile_version, classification, source, transcript, blob_ref,
       blob_sha256, data, occurred_at, created_at
     ) values (
       $1, $2, $3, $4, $5, $6,
       $7, $8, $9, $10, $11,
       $12, $13::jsonb, $14::timestamptz, $15::timestamptz
     )
     on conflict (id) do update set
       user_id = excluded.user_id,
       session_id = excluded.session_id,
       conversation_id = excluded.conversation_id,
       branch_id = excluded.branch_id,
       turn_id = excluded.turn_id,
       profile_version = excluded.profile_version,
       classification = excluded.classification,
       source = excluded.source,
       transcript = excluded.transcript,
       blob_ref = excluded.blob_ref,
       blob_sha256 = excluded.blob_sha256,
       data = excluded.data,
       occurred_at = excluded.occurred_at,
       created_at = excluded.created_at
     where voice_turns.user_id = excluded.user_id
     returning *, (xmax = 0) as inserted`,
    [
      turnId,
      userIdFor(record, options.userId),
      sessionId,
      nullableText(record.conversation_id || record.conversationId || sessionId),
      branchId,
      turnId,
      nullableText(record.profile_version || record.profileVersion),
      nullableText(record.classification),
      nullableText(record.source),
      nullableText(record.transcript),
      nullableText(record.blob_ref || record.blobRef || record.audio?.storage_ref || record.audio?.href),
      nullableText(record.blob_sha256 || record.blobSha256 || record.audio?.sha256),
      JSON.stringify(data),
      occurredAt,
      createdAt,
    ],
  );

  const response = voiceResponsePayload(record.response);
  return withEventResult(client, rowResult.rows[0], {
    event_type: "voice.turn.completed",
    stream_id: sessionStreamId(sessionId),
    idempotency_key: `voice:${sessionId}:${turnId}:completed`,
    occurred_at: timestamp(record.updated_at || record.updatedAt || occurredAt, occurredAt),
    actor: { kind: "gateway", id: "voice-router" },
    correlation_id: turnId,
    payload: {
      session_id: sessionId,
      conversation_id: text(record.conversation_id || record.conversationId || sessionId),
      branch_id: branchId,
      turn_id: turnId,
      source: text(record.source),
      device_id: text(record.device_id || record.deviceId),
      classification: text(record.classification),
      profile_version: text(record.profile_version || record.profileVersion),
      transcript: truncate(text(record.transcript), 4000),
      response,
      references: {
        agent_run_ids: Array.isArray(record.references?.agent_run_ids) ? record.references.agent_run_ids : [],
        conversation_id: text(record.references?.conversation_id),
        voice_session_status: text(record.references?.voice_session?.status),
        voice_session_provider: text(record.references?.voice_session?.provider),
      },
    },
  }, options);
}

async function upsertAgentRunOnClient(client, input, options) {
  const record = objectRecord(input);
  const id = text(record.id || record.run_id || record.runId);
  if (!id) throw new Error("agent run id is required");

  const now = new Date().toISOString();
  const status = text(record.status, "pending");
  const createdAt = timestamp(record.created_at || record.createdAt, now);
  const updatedAt = timestamp(record.updated_at || record.updatedAt || record.finished_at || record.finishedAt || record.started_at || record.startedAt || record.created_at || record.createdAt, createdAt);
  const data = restData(record, [
    "id", "run_id", "runId", "user_id", "userId", "status", "harness",
    "session_id", "sessionId", "branch_id", "branchId", "prompt", "instruction",
    "text", "result", "output", "stderr", "error", "created_at", "createdAt",
    "updated_at", "updatedAt", "started_at", "startedAt", "finished_at", "finishedAt",
  ]);
  const sessionId = nullableText(record.session_id || record.sessionId || record.conversation_id || record.conversationId);
  const rowResult = await client.query(
    `insert into agent_runs (
       id, user_id, status, harness, session_id, branch_id, prompt, result,
       error, data, created_at, updated_at, started_at, finished_at
     ) values (
       $1, $2, $3, $4, $5, $6, $7, $8,
       $9, $10::jsonb, $11::timestamptz, $12::timestamptz, $13::timestamptz, $14::timestamptz
     )
     on conflict (id) do update set
       user_id = excluded.user_id,
       status = excluded.status,
       harness = excluded.harness,
       session_id = excluded.session_id,
       branch_id = excluded.branch_id,
       prompt = excluded.prompt,
       result = excluded.result,
       error = excluded.error,
       data = excluded.data,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at,
       started_at = excluded.started_at,
       finished_at = excluded.finished_at
     where agent_runs.user_id = excluded.user_id
     returning *, (xmax = 0) as inserted`,
    [
      id,
      userIdFor(record, options.userId),
      status,
      nullableText(record.harness),
      sessionId,
      nullableText(record.branch_id || record.branchId),
      nullableText(record.prompt || record.instruction || record.text),
      nullableText(record.result || record.output || record.stdout),
      nullableText(record.error || record.stderr),
      JSON.stringify(data),
      createdAt,
      updatedAt,
      nullableTimestamp(record.started_at || record.startedAt),
      nullableTimestamp(record.finished_at || record.finishedAt),
    ],
  );

  return withEventResult(client, rowResult.rows[0], {
    event_type: `agent.run.${eventSuffix(status)}`,
    stream_id: runStreamId(id),
    idempotency_key: `agent-run:${id}:import:${status}`,
    occurred_at: updatedAt,
    actor: { kind: "agent", id },
    correlation_id: id,
    payload: {
      run_id: id,
      status,
      harness: text(record.harness),
      session_id: text(sessionId),
      branch_id: text(record.branch_id || record.branchId, "default"),
      prompt_preview: truncate(text(record.prompt || record.instruction || record.text), 4000),
      result: truncate(text(record.result || record.output || record.stdout), 4000),
      error: truncate(text(record.error || record.stderr), 4000),
    },
  }, options);
}

async function upsertBrowserTaskOnClient(client, input, options) {
  const record = objectRecord(input);
  const id = text(record.id || record.task_id || record.taskId);
  if (!id) throw new Error("browser task id is required");

  const now = new Date().toISOString();
  const createdAt = timestamp(record.created_at || record.createdAt, now);
  const updatedAt = timestamp(record.updated_at || record.updatedAt || record.finished_at || record.finishedAt || record.created_at || record.createdAt, createdAt);
  const data = restData(record, [
    "id", "task_id", "taskId", "user_id", "userId", "status", "instruction",
    "prompt", "task", "url", "source", "conversation_id", "conversationId",
    "branch_id", "branchId", "profile_version", "profileVersion",
    "agent_run_id", "agentRunId", "claimed_by", "claimedBy", "claimed_at",
    "claimedAt", "created_at", "createdAt", "updated_at", "updatedAt",
  ]);
  const rowResult = await client.query(
    `insert into browser_tasks (
       id, user_id, status, instruction, url, source, conversation_id, branch_id,
       profile_version, agent_run_id, claimed_by, claimed_at, data, created_at,
       updated_at
     ) values (
       $1, $2, $3, $4, $5, $6, $7, $8,
       $9, $10, $11, $12::timestamptz, $13::jsonb, $14::timestamptz,
       $15::timestamptz
     )
     on conflict (id) do update set
       user_id = excluded.user_id,
       status = excluded.status,
       instruction = excluded.instruction,
       url = excluded.url,
       source = excluded.source,
       conversation_id = excluded.conversation_id,
       branch_id = excluded.branch_id,
       profile_version = excluded.profile_version,
       agent_run_id = excluded.agent_run_id,
       claimed_by = excluded.claimed_by,
       claimed_at = excluded.claimed_at,
       data = excluded.data,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at
     where browser_tasks.user_id = excluded.user_id
     returning *, (xmax = 0) as inserted`,
    [
      id,
      userIdFor(record, options.userId),
      nullableText(record.status),
      nullableText(record.instruction || record.prompt || record.task),
      nullableText(record.url),
      nullableText(record.source),
      nullableText(record.conversation_id || record.conversationId),
      nullableText(record.branch_id || record.branchId),
      nullableText(record.profile_version || record.profileVersion),
      nullableText(record.agent_run_id || record.agentRunId),
      nullableText(record.claimed_by || record.claimedBy),
      nullableTimestamp(record.claimed_at || record.claimedAt),
      JSON.stringify(data),
      createdAt,
      updatedAt,
    ],
  );

  const stage = browserTaskStage(record);
  const receipt = latestReceipt(record);
  const receiptKey = stage === "receipt" && receipt?.id ? `:${receipt.id}` : "";
  return withEventResult(client, rowResult.rows[0], {
    event_type: stage === "receipt" ? "browser.task.receipt" : `browser.task.${stage}`,
    stream_id: record.conversation_id || record.conversationId ? sessionStreamId(record.conversation_id || record.conversationId) : `browser-task:${id}`,
    idempotency_key: `browser-task:${id}:${stage}${receiptKey}`,
    occurred_at: timestamp(receipt?.ts || record.updated_at || record.updatedAt || record.created_at || record.createdAt, updatedAt),
    actor: {
      kind: stage === "queued" ? "gateway" : "extension",
      id: text(receipt?.client_id || receipt?.clientId || record.claimed_by || record.claimedBy || record.source, "browser"),
    },
    correlation_id: text(record.agent_run_id || record.agentRunId || id),
    payload: {
      task: summarizeBrowserTask(record, { includeActions: stage === "queued" }),
      receipt: receipt ? summarizeBrowserReceipt(receipt) : null,
    },
  }, options);
}

async function upsertToolRequestOnClient(client, input, options) {
  const record = objectRecord(input);
  const id = text(record.id || record.request_id || record.requestId);
  if (!id) throw new Error("tool request id is required");

  const now = new Date().toISOString();
  const createdAt = timestamp(record.created_at || record.createdAt, now);
  const updatedAt = timestamp(record.updated_at || record.updatedAt || record.finished_at || record.finishedAt || record.created_at || record.createdAt, createdAt);
  const data = restData(record, [
    "id", "request_id", "requestId", "user_id", "userId", "status",
    "target_device_id", "targetDeviceId", "surface", "target_surface_type",
    "targetSurfaceType", "tool", "name", "source", "claimed_at", "claimedAt",
    "created_at", "createdAt", "updated_at", "updatedAt",
  ]);
  const rowResult = await client.query(
    `insert into tool_requests (
       id, user_id, status, target_device_id, surface, tool, source,
       claimed_at, data, created_at, updated_at
     ) values (
       $1, $2, $3, $4, $5, $6, $7,
       $8::timestamptz, $9::jsonb, $10::timestamptz, $11::timestamptz
     )
     on conflict (id) do update set
       user_id = excluded.user_id,
       status = excluded.status,
       target_device_id = excluded.target_device_id,
       surface = excluded.surface,
       tool = excluded.tool,
       source = excluded.source,
       claimed_at = excluded.claimed_at,
       data = excluded.data,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at
     where tool_requests.user_id = excluded.user_id
     returning *, (xmax = 0) as inserted`,
    [
      id,
      userIdFor(record, options.userId),
      nullableText(record.status),
      nullableText(record.target_device_id || record.targetDeviceId),
      nullableText(record.surface || record.target_surface_type || record.targetSurfaceType),
      nullableText(record.tool || record.name),
      nullableText(record.source),
      nullableTimestamp(record.claimed_at || record.claimedAt),
      JSON.stringify(data),
      createdAt,
      updatedAt,
    ],
  );

  const stage = toolRequestStage(record);
  const receipt = latestReceipt(record);
  const receiptKey = stage === "receipt" && receipt?.id ? `:${receipt.id}` : "";
  return withEventResult(client, rowResult.rows[0], {
    event_type: stage === "receipt" ? "tool.request.receipt" : `tool.request.${stage}`,
    stream_id: record.session_id || record.sessionId ? sessionStreamId(record.session_id || record.sessionId) : `tool-request:${id}`,
    idempotency_key: `tool-request:${id}:${stage}${receiptKey}`,
    occurred_at: timestamp(receipt?.ts || record.updated_at || record.updatedAt || record.created_at || record.createdAt, updatedAt),
    actor: {
      kind: stage === "queued" ? "gateway" : "device",
      id: text(receipt?.device_id || receipt?.deviceId || record.claimed_by || record.claimedBy || record.source_device_id || record.sourceDeviceId || record.source, "device"),
    },
    correlation_id: id,
    payload: {
      request: summarizeToolRequest(record, { includeInput: stage === "queued" }),
      receipt: receipt ? summarizeToolReceipt(receipt) : null,
    },
  }, options);
}

async function withEventResult(client, row, eventInput, options) {
  if (!row) throw new Error("record identifier is already owned by another user");
  const scopedEventInput = tenantEventInput(eventInput, options.userId);
  const eventWasPresent = await productEventExists(client, scopedEventInput);
  const event = await appendEventOnClient(client, scopedEventInput, { originId: options.originId });
  return {
    row: withoutInserted(row),
    event,
    rowInserted: Boolean(row?.inserted),
    eventInserted: !eventWasPresent,
  };
}

async function productEventExists(client, input) {
  const eventId = text(input.event_id || input.eventId);
  const idempotencyKey = text(input.idempotency_key || input.idempotencyKey);
  const where = [];
  const params = [];
  if (eventId) {
    params.push(eventId);
    where.push(`event_id = $${params.length}`);
  }
  if (idempotencyKey) {
    params.push(idempotencyKey);
    where.push(`idempotency_key = $${params.length}`);
  }
  if (!where.length) return false;
  const result = await client.query(`select 1 from product_events where ${where.join(" or ")} limit 1`, params);
  return result.rowCount > 0;
}

function objectRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("record object is required");
  }
  return value;
}

function userIdFor(record, trustedUserIdValue) {
  const claimed = text(record.user_id || record.userId);
  if (claimed && claimed !== trustedUserIdValue) {
    throw new Error("record user_id does not match trusted store identity");
  }
  return trustedUserIdValue;
}

function trustedUserId(value) {
  const userId = text(value);
  if (!userId) throw new Error("createRelationalStore requires userId");
  if (userId.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9_.:@-]*$/.test(userId)) {
    throw new Error("createRelationalStore userId is invalid");
  }
  return userId;
}

function tenantEventInput(input, userId) {
  // Preserve the already-shipped single-owner event identity so re-running the
  // legacy importer remains idempotent across this staged change. `owner` is a
  // reserved seeded principal; new hosted identities use derived namespaces.
  if (userId === "owner") {
    return {
      ...input,
      authority: {
        ...(input.authority && typeof input.authority === "object" ? input.authority : {}),
        tenant_id: userId,
      },
    };
  }
  return {
    ...input,
    stream_id: tenantEventIdentifier("stream", userId, input.stream_id),
    idempotency_key: input.idempotency_key
      ? tenantEventIdentifier("idempotency", userId, input.idempotency_key)
      : null,
    authority: {
      ...(input.authority && typeof input.authority === "object" ? input.authority : {}),
      tenant_id: userId,
    },
  };
}

function tenantEventIdentifier(domain, userId, value) {
  const rawValue = text(value);
  const namespace = tenantEventNamespace(userId, domain);
  const label = tenantEventLabel(rawValue, domain === "stream" ? "event" : "key");
  const digest = tenantEventHash("value", domain, userId, rawValue);
  return `${namespace}:${label}:h:${digest}`;
}

function tenantEventNamespace(userId, domain) {
  return `tenant:v1:${domain}:${tenantEventHash("tenant", domain, userId)}`;
}

function tenantEventHash(kind, domain, userId, value = "") {
  return crypto
    .createHash("sha256")
    .update([TENANT_EVENT_SCOPE_VERSION, kind, domain, userId, value].join("\u0000"))
    .digest("hex");
}

function tenantEventLabel(value, fallback) {
  const raw = text(String(value || "").split(":")[0], fallback).toLowerCase();
  const normalized = raw
    .replace(/[^a-z0-9_.-]/g, ".")
    .replace(/\.+/g, ".")
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 24);
  return normalized || fallback;
}

function text(value, fallback = "") {
  if (value === null || value === undefined) return fallback;
  const output = String(value).trim();
  return output || fallback;
}

function nullableText(value) {
  const output = text(value);
  return output || null;
}

function timestamp(value, fallback) {
  const output = nullableTimestamp(value);
  return output || fallback;
}

function nullableTimestamp(value) {
  const raw = text(value);
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function restData(record, knownKeys) {
  const known = new Set(knownKeys);
  const data = {};
  for (const [key, value] of Object.entries(record)) {
    if (!known.has(key) && value !== undefined) {
      data[key] = value;
    }
  }
  return data;
}

function withoutInserted(row) {
  if (!row) return null;
  const { inserted, ...rest } = row;
  return rest;
}

function sessionStreamId(sessionId) {
  return `session:${text(sessionId, "default")}`;
}

function runStreamId(runId) {
  return `run:${text(runId, "unknown")}`;
}

function eventSuffix(value) {
  return text(value, "recorded").toLowerCase().replace(/_/g, ".").replace(/[^a-z0-9_.:-]/g, ".");
}

function chatUserText(record) {
  return text(record.user_text || record.userText)
    || latestMessageText(record.request_messages || record.requestMessages, "user")
    || latestMessageText(record.messages, "user");
}

function chatResponseText(record) {
  return text(record.response_text || record.responseText || record.text)
    || latestMessageText(record.messages, "assistant")
    || text(record.response?.display || record.response?.text || record.response?.speak);
}

function latestMessageText(messages, role) {
  if (!Array.isArray(messages)) return "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object") continue;
    if (role && String(message.role || "") !== role) continue;
    const content = message.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const joined = content
        .map((item) => typeof item === "string" ? item : item?.text || item?.content || "")
        .filter(Boolean)
        .join("\n");
      if (joined) return joined;
    }
  }
  return "";
}

function voiceResponsePayload(response) {
  const source = response && typeof response === "object" && !Array.isArray(response) ? response : {};
  return {
    display: truncate(text(source.display || source.text), 4000),
    speak: truncate(text(source.speak), 1200),
    action_count: Array.isArray(source.actions) ? source.actions.length : 0,
    actions: Array.isArray(source.actions) ? source.actions.slice(0, 20) : [],
  };
}

function browserTaskStage(record) {
  const status = text(record.status).toLowerCase();
  if (latestReceipt(record)) return "receipt";
  if (status === "claimed" || record.claimed_by || record.claimedBy) return "claimed";
  return "queued";
}

function toolRequestStage(record) {
  const status = text(record.status).toLowerCase();
  if (latestReceipt(record)) return "receipt";
  if (status === "claimed" || record.claimed_by || record.claimedBy) return "claimed";
  return "queued";
}

function latestReceipt(record) {
  const receipts = Array.isArray(record.receipts) ? record.receipts : [];
  return receipts.length ? receipts[receipts.length - 1] : null;
}

function summarizeBrowserTask(task, options = {}) {
  return {
    id: text(task.id || task.task_id || task.taskId),
    status: text(task.status),
    instruction: text(task.instruction || task.prompt || task.task),
    url: text(task.url),
    cdp_actions: options.includeActions && Array.isArray(task.cdp_actions) ? task.cdp_actions : undefined,
    action_count: Array.isArray(task.cdp_actions) ? task.cdp_actions.length : 0,
    source: text(task.source),
    conversation_id: text(task.conversation_id || task.conversationId),
    branch_id: text(task.branch_id || task.branchId, "default"),
    profile_version: text(task.profile_version || task.profileVersion),
    agent_run_id: text(task.agent_run_id || task.agentRunId),
    claimed_by: text(task.claimed_by || task.claimedBy),
    claimed_at: text(task.claimed_at || task.claimedAt),
    lease_expires_at: text(task.lease_expires_at || task.leaseExpiresAt),
    receipt_count: Array.isArray(task.receipts) ? task.receipts.length : 0,
    latest_receipt: latestReceipt(task),
    error: text(task.error),
    created_at: text(task.created_at || task.createdAt),
    updated_at: text(task.updated_at || task.updatedAt),
    finished_at: text(task.finished_at || task.finishedAt),
  };
}

function summarizeBrowserReceipt(receipt) {
  return {
    id: text(receipt.id),
    ts: text(receipt.ts),
    ok: receipt.ok !== false,
    client_id: text(receipt.client_id || receipt.clientId),
    summary: text(receipt.summary),
    error: text(receipt.error),
    action_results: receipt.action_results || receipt.actionResults || [],
    page_state: receipt.page_state || receipt.pageState || {},
  };
}

function summarizeToolRequest(record, options = {}) {
  return {
    id: text(record.id || record.request_id || record.requestId),
    status: text(record.status),
    tool: text(record.tool || record.name),
    input: options.includeInput ? record.input || record.arguments || {} : undefined,
    source: text(record.source),
    source_device_id: text(record.source_device_id || record.sourceDeviceId),
    source_surface_type: text(record.source_surface_type || record.sourceSurfaceType),
    target_device_id: text(record.target_device_id || record.targetDeviceId),
    target_surface_type: text(record.target_surface_type || record.targetSurfaceType || record.surface),
    session_id: text(record.session_id || record.sessionId),
    branch_id: text(record.branch_id || record.branchId, "default"),
    instruction: text(record.instruction || record.reason),
    claimed_by: text(record.claimed_by || record.claimedBy),
    claimed_at: text(record.claimed_at || record.claimedAt),
    lease_expires_at: text(record.lease_expires_at || record.leaseExpiresAt),
    receipt_count: Array.isArray(record.receipts) ? record.receipts.length : 0,
    latest_receipt: latestReceipt(record),
    error: text(record.error),
    created_at: text(record.created_at || record.createdAt),
    updated_at: text(record.updated_at || record.updatedAt),
    finished_at: text(record.finished_at || record.finishedAt),
  };
}

function summarizeToolReceipt(receipt) {
  return {
    id: text(receipt.id),
    ts: text(receipt.ts),
    ok: receipt.ok !== false,
    device_id: text(receipt.device_id || receipt.deviceId),
    summary: text(receipt.summary),
    error: text(receipt.error),
    result: receipt.result ?? null,
    local_receipt: receipt.local_receipt || receipt.localReceipt || null,
  };
}

function truncate(value, max) {
  const raw = text(value);
  return raw.length > max ? raw.slice(0, max) : raw;
}

module.exports = {
  createRelationalStore,
};
