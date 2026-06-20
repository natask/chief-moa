"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const STATUSES = ["open", "running", "blocked", "done"];
const DEFAULT_STATUS = "open";
const EXECUTOR_KINDS = ["none", "local", "devin"];
const EVENT_TYPES = ["partial", "final", "tool_call", "tool_result", "status", "error"];
const ARTIFACT_KINDS = ["plan", "decision", "tool_spec", "result", "merged_answer", "note"];

function createPostgresWorkGraphStore(options = {}) {
  const databaseUrl = String(options.databaseUrl || "").trim();
  if (!databaseUrl && !options.pool) {
    throw new Error("DATABASE_URL is required for Postgres work graph storage");
  }

  const pool = options.pool || createPool(databaseUrl);
  const schemaPath = options.schemaPath || path.resolve(__dirname, "..", "schema.sql");
  const initialize = options.initialize !== false;
  let readyPromise = null;

  function ready() {
    if (!initialize) return Promise.resolve();
    if (!readyPromise) {
      readyPromise = fs.promises.readFile(schemaPath, "utf8").then((schema) => pool.query(schema));
    }
    return readyPromise;
  }

  async function create(input) {
    await ready();
    const title = coerceText(input?.title, 200) || "untitled";
    const intent = coerceText(input?.intent, 4000) || title;
    const parentId = coerceText(input?.parentId, 64) || null;
    const id = `wg_${crypto.randomBytes(6).toString("hex")}`;
    return withTransaction(pool, async (client) => {
      let contextRefs = [];
      if (parentId) {
        const parent = await getNodeForUpdate(client, parentId);
        if (!parent) {
          throw new Error(`parent node not found: ${parentId}`);
        }
        contextRefs = Array.isArray(parent.contextRefs) ? parent.contextRefs : [];
      }
      const result = await client.query(
        `insert into nodes (id, title, intent, parent_id, status, queue, corrections, context_refs)
         values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb)
         returning *`,
        [id, title, intent, parentId, DEFAULT_STATUS, "[]", "[]", JSON.stringify(contextRefs)],
      );
      return nodeFromRow(result.rows[0]);
    });
  }

  async function get(id) {
    await ready();
    const result = await pool.query("select * from nodes where id = $1", [id]);
    return result.rows[0] ? nodeFromRow(result.rows[0]) : null;
  }

  async function list(filter) {
    await ready();
    const status = filter?.status && STATUSES.includes(filter.status) ? filter.status : "";
    const result = status
      ? await pool.query("select * from nodes where status = $1 order by created_at desc", [status])
      : await pool.query("select * from nodes order by created_at desc");
    return result.rows.map(nodeFromRow);
  }

  async function children(id) {
    await ready();
    const result = await pool.query("select * from nodes where parent_id = $1 order by created_at desc", [id]);
    return result.rows.map(nodeFromRow);
  }

  async function enqueue(id, instruction) {
    const text = coerceText(instruction, 4000);
    if (!text) return get(id);
    return mutateJsonArray(id, "queue", (items) => {
      items.push({ at: new Date().toISOString(), text });
      return items;
    });
  }

  async function dequeue(id) {
    await ready();
    return withTransaction(pool, async (client) => {
      const node = await getNodeForUpdate(client, id);
      if (!node) return { node: null, item: null };
      const queue = Array.isArray(node.queue) ? node.queue : [];
      const item = queue.length > 0 ? queue.shift() : null;
      if (!item) return { node, item: null };
      const updated = await updateNodeJsonField(client, id, "queue", queue);
      return { node: updated, item };
    });
  }

  async function applyCorrection(id, text) {
    const correction = coerceText(text, 4000);
    if (!correction) return get(id);
    return mutateJsonArray(id, "corrections", (items) => {
      items.push({ at: new Date().toISOString(), text: correction });
      return items;
    });
  }

  async function setStatus(id, status, fields) {
    if (!STATUSES.includes(status)) {
      throw new Error(`invalid status: ${status}`);
    }
    await ready();
    const nextStep = coerceText(fields?.nextStep, 1000);
    const result = await pool.query(
      `update nodes
       set status = $2,
           next_step = case when $3::text is null then next_step else $3 end,
           updated_at = now()
       where id = $1
       returning *`,
      [id, status, nextStep],
    );
    return result.rows[0] ? nodeFromRow(result.rows[0]) : null;
  }

  async function addContextRefs(id, refs) {
    const incoming = Array.isArray(refs) ? refs : [refs];
    const clean = incoming.map((ref) => coerceText(ref, 200)).filter(Boolean);
    if (clean.length === 0) return get(id);
    return mutateJsonArray(id, "context_refs", (items) => {
      for (const ref of clean) {
        if (!items.includes(ref)) items.push(ref);
      }
      return items;
    });
  }

  async function bindExecutor(id, executor) {
    await ready();
    const kind = EXECUTOR_KINDS.includes(executor?.kind) ? executor.kind : "none";
    const ref = kind === "none" ? null : coerceText(executor?.ref, 200);
    const result = await pool.query(
      `update nodes
       set executor_kind = $2,
           executor_ref = $3,
           updated_at = now()
       where id = $1
       returning *`,
      [id, kind, ref || null],
    );
    return result.rows[0] ? nodeFromRow(result.rows[0]) : null;
  }

  async function appendEvent(input) {
    await ready();
    const nodeId = coerceText(input?.node_id || input?.nodeId, 64);
    if (!nodeId) throw new Error("node_id is required");
    const type = EVENT_TYPES.includes(input?.type) ? input.type : "status";
    const runId = coerceText(input?.run_id || input?.runId, 200);
    const payload = input?.payload && typeof input.payload === "object" && !Array.isArray(input.payload) ? input.payload : {};
    return withTransaction(pool, async (client) => {
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [nodeId]);
      const seqResult = await client.query("select coalesce(max(seq), 0) + 1 as next_seq from events where node_id = $1", [nodeId]);
      const seq = Number(seqResult.rows[0].next_seq);
      if (runId) {
        await upsertRunReference(client, {
          id: runId,
          nodeId,
          payload,
        });
      }
      const result = await client.query(
        `insert into events (node_id, run_id, seq, type, payload)
         values ($1, $2, $3, $4, $5::jsonb)
         returning *`,
        [nodeId, runId || null, seq, type, JSON.stringify(payload)],
      );
      return eventFromRow(result.rows[0]);
    });
  }

  async function listEvents(filter = {}) {
    await ready();
    const nodeId = coerceText(filter.node_id || filter.nodeId, 64);
    const runId = coerceText(filter.run_id || filter.runId, 200);
    const params = [];
    const where = [];
    if (nodeId) {
      params.push(nodeId);
      where.push(`node_id = $${params.length}`);
    }
    if (runId) {
      params.push(runId);
      where.push(`run_id = $${params.length}`);
    }
    const limit = clampLimit(filter.limit, 200);
    params.push(limit);
    const sql = `select * from events${where.length ? ` where ${where.join(" and ")}` : ""} order by node_id asc, seq asc limit $${params.length}`;
    const result = await pool.query(sql, params);
    return result.rows.map(eventFromRow);
  }

  async function addArtifact(input) {
    await ready();
    const kind = ARTIFACT_KINDS.includes(input?.kind) ? input.kind : "note";
    const nodeId = coerceText(input?.node_id || input?.nodeId, 64);
    const runId = coerceText(input?.run_id || input?.runId, 200);
    const title = coerceText(input?.title, 240) || "";
    const body = String(input?.body || "").slice(0, 200000);
    const refs = input?.refs && typeof input.refs === "object" && !Array.isArray(input.refs) ? input.refs : {};
    return withTransaction(pool, async (client) => {
      if (nodeId && runId) {
        await upsertRunReference(client, {
          id: runId,
          nodeId,
          payload: { status: "running" },
        });
      }
      const result = await client.query(
        `insert into artifacts (node_id, run_id, kind, title, body, refs)
         values ($1, $2, $3, $4, $5, $6::jsonb)
         returning id, node_id, run_id, kind, title, body, refs, created_at`,
        [nodeId || null, runId || null, kind, title, body, JSON.stringify(refs)],
      );
      return artifactFromRow(result.rows[0]);
    });
  }

  async function listArtifacts(filter = {}) {
    await ready();
    const params = [];
    const where = [];
    const nodeId = coerceText(filter.node_id || filter.nodeId, 64);
    const runId = coerceText(filter.run_id || filter.runId, 200);
    const kind = ARTIFACT_KINDS.includes(filter.kind) ? filter.kind : "";
    const q = coerceText(filter.q || filter.query, 200);
    if (nodeId) {
      params.push(nodeId);
      where.push(`node_id = $${params.length}`);
    }
    if (runId) {
      params.push(runId);
      where.push(`run_id = $${params.length}`);
    }
    if (kind) {
      params.push(kind);
      where.push(`kind = $${params.length}`);
    }
    if (q) {
      params.push(q);
      where.push(`search @@ websearch_to_tsquery('english', $${params.length})`);
    }
    const limit = clampLimit(filter.limit, 100);
    params.push(limit);
    const result = await pool.query(
      `select id, node_id, run_id, kind, title, body, refs, created_at
       from artifacts${where.length ? ` where ${where.join(" and ")}` : ""}
       order by created_at desc
       limit $${params.length}`,
      params,
    );
    return result.rows.map(artifactFromRow);
  }

  async function close() {
    if (typeof pool.end === "function") await pool.end();
  }

  async function mutateJsonArray(id, column, fn) {
    await ready();
    return withTransaction(pool, async (client) => {
      const node = await getNodeForUpdate(client, id);
      if (!node) return null;
      const current = Array.isArray(node[columnToNodeField(column)]) ? node[columnToNodeField(column)] : [];
      const next = fn([...current]);
      return updateNodeJsonField(client, id, column, next);
    });
  }

  return {
    graphPath: "postgres:nodes",
    create,
    get,
    list,
    children,
    enqueue,
    dequeue,
    applyCorrection,
    setStatus,
    addContextRefs,
    bindExecutor,
    appendEvent,
    listEvents,
    addArtifact,
    listArtifacts,
    close,
    statuses: () => STATUSES.slice(),
    storageInfo: () => ({
      work_graph: "postgres",
      postgres_configured: true,
      database_url_configured: Boolean(databaseUrl || options.pool),
      schema: "schema.sql",
    }),
  };
}

function createPool(databaseUrl) {
  const { Pool } = require("pg");
  return new Pool({ connectionString: databaseUrl });
}

async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // Preserve the original error.
    }
    throw error;
  } finally {
    client.release();
  }
}

async function getNodeForUpdate(client, id) {
  const result = await client.query("select * from nodes where id = $1 for update", [id]);
  return result.rows[0] ? nodeFromRow(result.rows[0]) : null;
}

async function updateNodeJsonField(client, id, column, value) {
  if (!["queue", "corrections", "context_refs"].includes(column)) {
    throw new Error(`unsupported JSON field: ${column}`);
  }
  const result = await client.query(
    `update nodes set ${column} = $2::jsonb, updated_at = now() where id = $1 returning *`,
    [id, JSON.stringify(value)],
  );
  return result.rows[0] ? nodeFromRow(result.rows[0]) : null;
}

async function upsertRunReference(client, input) {
  const status = postgresRunStatus(input.payload?.status);
  const result = String(input.payload?.result || input.payload?.text || "").slice(0, 120000);
  const error = String(input.payload?.error || "").slice(0, 120000);
  await client.query(
    `insert into runs (id, node_id, kind, status, instruction, result, error, finished_at)
     values ($1, $2, $3, $4, $5, $6, $7, case when $4 = 'running' then null else now() end)
     on conflict (id) do update
       set status = excluded.status,
           result = case when excluded.result = '' then runs.result else excluded.result end,
           error = case when excluded.error = '' then runs.error else excluded.error end,
           finished_at = case when excluded.status = 'running' then runs.finished_at else coalesce(runs.finished_at, now()) end`,
    [
      input.id,
      input.nodeId,
      String(input.payload?.kind || input.payload?.harness || "gateway-agent").slice(0, 80),
      status,
      String(input.payload?.instruction || "").slice(0, 4000),
      result,
      error,
    ],
  );
}

function postgresRunStatus(value) {
  const status = String(value || "").trim();
  if (status === "completed" || status === "done") return "done";
  if (status === "failed" || status === "timed-out" || status === "error") return "error";
  if (status === "canceled" || status === "cancelled") return "cancelled";
  return "running";
}

function nodeFromRow(row) {
  return {
    id: row.id,
    title: row.title,
    intent: row.intent,
    parentId: row.parent_id || null,
    status: row.status,
    queue: arrayJson(row.queue),
    corrections: arrayJson(row.corrections),
    contextRefs: arrayJson(row.context_refs),
    executor: { kind: row.executor_kind || "none", ref: row.executor_ref || null },
    nextStep: row.next_step || "",
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function eventFromRow(row) {
  return {
    id: row.id,
    node_id: row.node_id,
    run_id: row.run_id || "",
    seq: Number(row.seq),
    type: row.type,
    payload: row.payload && typeof row.payload === "object" ? row.payload : {},
    ts: iso(row.ts),
  };
}

function artifactFromRow(row) {
  return {
    id: row.id,
    node_id: row.node_id || "",
    run_id: row.run_id || "",
    kind: row.kind,
    title: row.title || "",
    body: row.body || "",
    refs: row.refs && typeof row.refs === "object" ? row.refs : {},
    created_at: iso(row.created_at),
  };
}

function columnToNodeField(column) {
  if (column === "context_refs") return "contextRefs";
  return column;
}

function arrayJson(value) {
  return Array.isArray(value) ? value : [];
}

function iso(value) {
  if (!value) return "";
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function coerceText(value, max) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

function clampLimit(value, fallback) {
  const numeric = Number(value || fallback);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(1, Math.min(Math.trunc(numeric), 500));
}

module.exports = {
  createPostgresWorkGraphStore,
};
