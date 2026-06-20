"use strict";

// The work-graph: a durable forest of the tasks you have initiated.
//
// This is the spine of the branching-mind system (see
// scratch/vision/branching-mind-work-graph-problems-20260620.md and
// build-vs-reuse-devin-20260620.md). Your unit is a NODE, not a session. A node
// lives here forever; an executor (a local harness now, a Devin session later)
// is a disposable worker bound to a node while it does the node's current work.
//
// What this slice owns: the graph model (C10), per-branch queue (C12),
// context inheritance on fork (B7), corrections-win as a node-level log (D15),
// and the self-reported status + next step read side (C11/E19). It deliberately
// does NOT route utterances, assemble context, or talk to an executor yet —
// those hang off this store later.
//
// Storage mirrors agent-profile.js: one JSON file, atomic temp+rename writes,
// strict field coercion so a bad input never corrupts a node.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const GRAPH_FILENAME = "work-graph.json";

// A node's lifecycle. Kept small on purpose: open (created, no worker yet),
// running (a worker is on it), blocked (stuck, needs you), done (merged back).
const STATUSES = ["open", "running", "blocked", "done"];
const DEFAULT_STATUS = "open";

// An executor binds a node to whatever is doing its current work. kind "none"
// means no worker. "local" is a gateway harness run; "devin" is a Devin session.
// ref is that worker's id (a run id or a Devin session id), null when none.
const EXECUTOR_KINDS = ["none", "local", "devin"];

function createWorkGraphStore(options = {}) {
  const databaseUrl = String(options.databaseUrl || process.env.DATABASE_URL || "").trim();
  if (databaseUrl || options.pool) {
    const { createPostgresWorkGraphStore } = require("./work-graph-postgres");
    return createPostgresWorkGraphStore({
      databaseUrl,
      pool: options.pool,
      schemaPath: options.schemaPath,
      initialize: options.initialize,
    });
  }
  return createJsonWorkGraphStore(options);
}

function createJsonWorkGraphStore(options) {
  const dataDir = path.resolve(options?.dataDir || "./data");
  const graphPath = path.join(dataDir, GRAPH_FILENAME);
  const eventsPath = path.join(dataDir, "work-events.jsonl");
  const artifactsPath = path.join(dataDir, "work-artifacts.jsonl");

  fs.mkdirSync(dataDir, { recursive: true });

  // The whole forest is held in memory and flushed on every mutation. At one
  // user's scale this is cheap and keeps reads instant. Shape: { nodes: {id: node} }.
  let state = loadState(graphPath);

  // Create a node. With a parentId this is a FORK: the child inherits the
  // parent's context refs as of now (B7 — context inheritance on fork). Without
  // one it is a new root in the forest.
  function create(input) {
    const title = coerceText(input?.title, 200) || "untitled";
    const intent = coerceText(input?.intent, 4000) || title;
    const parentId = coerceText(input?.parentId, 64) || null;

    if (parentId && !state.nodes[parentId]) {
      throw new Error(`parent node not found: ${parentId}`);
    }

    const now = new Date().toISOString();
    const node = {
      id: `wg_${crypto.randomBytes(6).toString("hex")}`,
      title,
      // The original ask. Corrections layer on top; effectiveInstruction()
      // resolves what a worker should actually act on.
      intent,
      parentId,
      status: DEFAULT_STATUS,
      // Per-branch queue (C12): pending instructions you keep adding to.
      queue: [],
      // Corrections-win log (D15): newest correction is the effective instruction.
      corrections: [],
      // Context slice ids seeded into this node. On fork, copied from parent so
      // the child starts from where the parent was (B7). Assembly fills these later.
      contextRefs: parentId ? [...state.nodes[parentId].contextRefs] : [],
      executor: { kind: "none", ref: null },
      // Self-reported (C11): the simplest next step toward forward progress.
      nextStep: "",
      createdAt: now,
      updatedAt: now,
    };

    state.nodes[node.id] = node;
    flush();
    return clone(node);
  }

  function get(id) {
    const node = state.nodes[id];
    return node ? clone(node) : null;
  }

  // The "list all my tasks" read (E19). Optionally filter by status. Newest first.
  function list(filter) {
    const wantStatus = filter?.status && STATUSES.includes(filter.status) ? filter.status : null;
    return Object.values(state.nodes)
      .filter((node) => (wantStatus ? node.status === wantStatus : true))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map(clone);
  }

  // Direct children of a node, for walking the forest.
  function children(id) {
    return Object.values(state.nodes)
      .filter((node) => node.parentId === id)
      .map(clone);
  }

  // Add work to a branch without disturbing what it is currently doing (C12).
  function enqueue(id, instruction) {
    const text = coerceText(instruction, 4000);
    if (!text) {
      return get(id);
    }
    return mutate(id, (node) => {
      node.queue.push({ at: new Date().toISOString(), text });
    });
  }

  // Pop the next queued instruction, FIFO. Returns { node, item } or null item
  // when the queue is empty. The caller decides what to do with it.
  function dequeue(id) {
    const node = state.nodes[id];
    if (!node) {
      return { node: null, item: null };
    }
    const item = node.queue.length > 0 ? node.queue.shift() : null;
    if (item) {
      touch(node);
      flush();
    }
    return { node: clone(node), item };
  }

  // Corrections win (D15): a new input that contradicts the running branch is
  // logged and becomes the effective instruction. Launch order does not arbitrate.
  function applyCorrection(id, text) {
    const correction = coerceText(text, 4000);
    if (!correction) {
      return get(id);
    }
    return mutate(id, (node) => {
      node.corrections.push({ at: new Date().toISOString(), text: correction });
    });
  }

  // Status + self-reported next step (C11). nextStep is optional; passing it
  // updates it, omitting it leaves the prior value.
  function setStatus(id, status, fields) {
    if (!STATUSES.includes(status)) {
      throw new Error(`invalid status: ${status}`);
    }
    return mutate(id, (node) => {
      node.status = status;
      const nextStep = coerceText(fields?.nextStep, 1000);
      if (nextStep !== null) {
        node.nextStep = nextStep;
      }
    });
  }

  // Attach context slice ids to a node (B7 source side). Context assembly will
  // call this as it seeds a node; a fork then copies whatever is here at the
  // fork point. Dedupes and ignores empties so repeated assembly is idempotent.
  function addContextRefs(id, refs) {
    const incoming = Array.isArray(refs) ? refs : [refs];
    const clean = incoming.map((ref) => coerceText(ref, 200)).filter(Boolean);
    if (clean.length === 0) {
      return get(id);
    }
    return mutate(id, (node) => {
      for (const ref of clean) {
        if (!node.contextRefs.includes(ref)) {
          node.contextRefs.push(ref);
        }
      }
    });
  }

  // Bind or clear the disposable worker on a node. Clearing is kind "none".
  function bindExecutor(id, executor) {
    const kind = EXECUTOR_KINDS.includes(executor?.kind) ? executor.kind : "none";
    const ref = kind === "none" ? null : coerceText(executor?.ref, 200);
    return mutate(id, (node) => {
      node.executor = { kind, ref: ref || null };
    });
  }

  function appendEvent(input) {
    const nodeId = coerceText(input?.node_id || input?.nodeId, 64);
    if (!nodeId) {
      throw new Error("node_id is required");
    }
    if (!state.nodes[nodeId]) {
      throw new Error(`work node not found: ${nodeId}`);
    }
    const events = readJsonLines(eventsPath);
    const seq = events
      .filter((event) => event.node_id === nodeId)
      .reduce((max, event) => Math.max(max, Number(event.seq || 0)), 0) + 1;
    const event = {
      id: `evt_${crypto.randomBytes(8).toString("hex")}`,
      node_id: nodeId,
      run_id: coerceText(input?.run_id || input?.runId, 200) || "",
      seq,
      type: coerceText(input?.type, 40) || "status",
      payload: plainObject(input?.payload),
      ts: new Date().toISOString(),
    };
    appendJsonLine(eventsPath, event);
    return clone(event);
  }

  function listEvents(filter = {}) {
    const nodeId = coerceText(filter.node_id || filter.nodeId, 64);
    const runId = coerceText(filter.run_id || filter.runId, 200);
    const limit = clampLimit(filter.limit, 200);
    return readJsonLines(eventsPath)
      .filter((event) => (nodeId ? event.node_id === nodeId : true))
      .filter((event) => (runId ? event.run_id === runId : true))
      .sort((a, b) => {
        const nodeOrder = String(a.node_id || "").localeCompare(String(b.node_id || ""));
        return nodeOrder || Number(a.seq || 0) - Number(b.seq || 0);
      })
      .slice(0, limit)
      .map(clone);
  }

  function addArtifact(input) {
    const artifact = {
      id: crypto.randomUUID(),
      node_id: coerceText(input?.node_id || input?.nodeId, 64) || "",
      run_id: coerceText(input?.run_id || input?.runId, 200) || "",
      kind: coerceText(input?.kind, 40) || "note",
      title: coerceText(input?.title, 240) || "",
      body: String(input?.body || "").slice(0, 200000),
      refs: plainObject(input?.refs),
      created_at: new Date().toISOString(),
    };
    appendJsonLine(artifactsPath, artifact);
    return clone(artifact);
  }

  function listArtifacts(filter = {}) {
    const nodeId = coerceText(filter.node_id || filter.nodeId, 64);
    const runId = coerceText(filter.run_id || filter.runId, 200);
    const kind = coerceText(filter.kind, 40);
    const q = coerceText(filter.q || filter.query, 200);
    const needle = q ? q.toLowerCase() : "";
    const limit = clampLimit(filter.limit, 100);
    return readJsonLines(artifactsPath)
      .filter((artifact) => (nodeId ? artifact.node_id === nodeId : true))
      .filter((artifact) => (runId ? artifact.run_id === runId : true))
      .filter((artifact) => (kind ? artifact.kind === kind : true))
      .filter((artifact) => needle ? `${artifact.title || ""} ${artifact.body || ""}`.toLowerCase().includes(needle) : true)
      .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")))
      .slice(0, limit)
      .map(clone);
  }

  return {
    graphPath,
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
    statuses: () => STATUSES.slice(),
    storageInfo: () => ({
      work_graph: graphPath,
      work_events: eventsPath,
      work_artifacts: artifactsPath,
      postgres_configured: false,
    }),
  };

  // --- internals --------------------------------------------------------------

  function mutate(id, fn) {
    const node = state.nodes[id];
    if (!node) {
      return null;
    }
    fn(node);
    touch(node);
    flush();
    return clone(node);
  }

  function flush() {
    const tmpPath = `${graphPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2));
    fs.renameSync(tmpPath, graphPath);
  }
}

// The effective instruction a worker should act on: the newest correction if
// any (corrections win, D15), otherwise the original intent. Pure helper so the
// router/executor can resolve it without reaching into the store.
function effectiveInstruction(node) {
  if (!node) {
    return "";
  }
  if (Array.isArray(node.corrections) && node.corrections.length > 0) {
    return node.corrections[node.corrections.length - 1].text;
  }
  return node.intent || "";
}

function loadState(graphPath) {
  if (!fs.existsSync(graphPath)) {
    return { nodes: {} };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(graphPath, "utf8"));
    // A corrupt or unexpected file must not crash the gateway: start empty.
    if (!raw || typeof raw !== "object" || typeof raw.nodes !== "object" || !raw.nodes) {
      return { nodes: {} };
    }
    return { nodes: raw.nodes };
  } catch (error) {
    return { nodes: {} };
  }
}

function touch(node) {
  node.updatedAt = new Date().toISOString();
}

// Trim and length-cap a string field; return null for anything unusable so
// callers can tell "not provided" from an empty update.
function coerceText(value, max) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.slice(0, max);
}

function appendJsonLine(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`);
}

function readJsonLines(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function clampLimit(value, fallback) {
  const numeric = Number(value || fallback);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(1, Math.min(Math.trunc(numeric), 500));
}

function clone(node) {
  return JSON.parse(JSON.stringify(node));
}

module.exports = {
  createWorkGraphStore,
  effectiveInstruction,
  STATUSES,
  EXECUTOR_KINDS,
};
