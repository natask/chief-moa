"use strict";

const crypto = require("node:crypto");

const PACKET_SCHEMA = "moa.intent-context-packet.v1";
const DEFAULT_EVENT_LIMIT = 500;

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function digest(value) {
  return crypto.createHash("sha256").update(stableJson(value)).digest("hex");
}

function boundedText(value, max = 2_000) {
  return String(value || "").trim().slice(0, max);
}

function packetContent(packet) {
  return {
    schema: packet.schema,
    intent_id: packet.intent_id,
    intent_version: packet.intent_version,
    lifecycle_state: packet.lifecycle_state,
    objective: packet.objective,
    constraints: packet.constraints,
    decisions: packet.decisions,
    acceptance_criteria: packet.acceptance_criteria,
    blockers: packet.blockers,
    next_action: packet.next_action,
    active_priorities: packet.active_priorities,
    run_refs: packet.run_refs,
    artifact_heads: packet.artifact_heads,
    citations: packet.citations,
    source_bounds: packet.source_bounds,
    compaction: packet.compaction,
    continuation_text: packet.continuation_text,
  };
}

function citation(event, sourceRef = "") {
  return {
    event_id: boundedText(event?.event_id, 160),
    event_type: boundedText(event?.event_type, 160),
    stream_version: Number(event?.stream_version || 0),
    occurred_at: boundedText(event?.occurred_at, 80),
    source_ref: boundedText(sourceRef, 400),
  };
}

function eventContaining(events, predicate, { last = false } = {}) {
  const candidates = events.filter((event) => {
    try { return predicate(event?.payload || {}); } catch { return false; }
  });
  return last ? candidates.at(-1) : candidates[0];
}

function citedNotes(notes, events) {
  return (Array.isArray(notes) ? notes : []).map((note) => {
    const event = events.find((item) => item.event_id === note.event_id)
      || eventContaining(events, (payload) =>
        [payload.decision, payload.blocker, payload.lesson]
          .some((value) => boundedText(value) === boundedText(note.summary)));
    return {
      summary: boundedText(note.summary),
      citation: citation(event, note.source_ref),
    };
  }).filter((item) => item.summary && item.citation.event_id);
}

function citedStrings(values, events, payloadKey) {
  return (Array.isArray(values) ? values : []).map((value) => {
    const text = boundedText(value);
    const event = eventContaining(events, (payload) =>
      Array.isArray(payload[payloadKey])
      && payload[payloadKey].some((item) => boundedText(item) === text));
    return { summary: text, citation: citation(event) };
  }).filter((item) => item.summary && item.citation.event_id);
}

function artifactHeads(refs, events) {
  const heads = new Map();
  for (const ref of Array.isArray(refs) ? refs : []) {
    const value = boundedText(ref, 400);
    if (!value) continue;
    const match = value.match(/^git:(.+)@([^:]+):(.+)$/);
    const key = match ? `git:${match[1]}:${match[3]}` : value;
    const event = eventContaining(events, (payload) =>
      Array.isArray(payload.artifact_refs) && payload.artifact_refs.includes(value), { last: true });
    heads.set(key, {
      artifact_key: key,
      ref: value,
      citation: citation(event),
    });
  }
  return [...heads.values()].filter((item) => item.citation.event_id);
}

function continuationText(input) {
  const lines = [
    `Intent: ${input.objective.summary}`,
    `State: ${input.lifecycle_state}`,
    ...input.constraints.map((item) => `Constraint: ${item.summary}`),
    ...input.decisions.map((item) => `Decision: ${item.summary}`),
    ...input.acceptance_criteria.map((item) => `Acceptance: ${item.summary}`),
    ...input.blockers.map((item) => `Blocker: ${item.summary}`),
    input.next_action.summary ? `Next action: ${input.next_action.summary}` : "",
    ...input.artifact_heads.map((item) => `Artifact: ${item.ref}`),
  ].filter(Boolean);
  return lines.join("\n").slice(0, 16_000);
}

async function listIntentEvents(events, intentId, limit = DEFAULT_EVENT_LIMIT) {
  const rows = [];
  for (let offset = 0; rows.length < limit; offset += 100) {
    const pageLimit = Math.min(100, limit - rows.length);
    const page = await events.listEvents({
      stream_id: `intent:${intentId}`,
      order: "asc",
      offset,
      limit: pageLimit,
    });
    rows.push(...page);
    if (page.length < pageLimit) break;
  }
  const probe = await events.listEvents({
    stream_id: `intent:${intentId}`,
    order: "asc",
    offset: rows.length,
    limit: 1,
  });
  return { rows, truncated: probe.length > 0 };
}

async function buildIntentContextPacket({
  events,
  state,
  generatedAt,
  compactionModel = "deterministic_projection",
  compactionVersion = "intent-context-packet-v1",
} = {}) {
  if (!events?.listEvents) throw new Error("context packet requires event substrate");
  if (!state?.exists || !state.intent_id) throw new Error("context packet requires an existing intent");
  const { rows, truncated } = await listIntentEvents(events, state.intent_id);
  if (!rows.length) throw new Error("context packet has no source events");

  const capture = rows.find((event) => event.event_type === "intent.captured");
  const objectiveEvent = eventContaining(rows, (payload) => payload.normalized_objective, { last: true }) || capture;
  const nextEvent = eventContaining(rows, (payload) => payload.next_step, { last: true });
  const constraints = citedNotes(state.constraints, rows);
  const decisions = citedNotes(state.decisions, rows);
  const blockers = citedNotes(state.blockers, rows);
  const acceptance = citedStrings(state.completion_criteria, rows, "completion_criteria");
  const artifacts = artifactHeads(state.artifact_refs, rows);
  const citations = [
    citation(objectiveEvent),
    ...constraints.map((item) => item.citation),
    ...decisions.map((item) => item.citation),
    ...acceptance.map((item) => item.citation),
    ...blockers.map((item) => item.citation),
    ...(nextEvent ? [citation(nextEvent)] : []),
    ...artifacts.map((item) => item.citation),
  ].filter((item, index, all) =>
    item.event_id && all.findIndex((other) => other.event_id === item.event_id) === index);

  const core = {
    schema: PACKET_SCHEMA,
    intent_id: state.intent_id,
    intent_version: state.version,
    lifecycle_state: state.lifecycle_state,
    objective: {
      summary: boundedText(state.normalized_objective || state.statement),
      citation: citation(objectiveEvent),
    },
    constraints,
    decisions,
    acceptance_criteria: acceptance,
    blockers,
    next_action: {
      summary: boundedText(state.next_step),
      citation: citation(nextEvent),
    },
    active_priorities: (state.active_priorities || []).map((item) => boundedText(item)).filter(Boolean),
    run_refs: [...(state.run_refs || [])],
    artifact_heads: artifacts,
    citations,
    source_bounds: {
      first_event_id: rows[0].event_id,
      last_event_id: rows.at(-1).event_id,
      first_stream_version: rows[0].stream_version,
      last_stream_version: rows.at(-1).stream_version,
      event_count: rows.length,
      truncated,
    },
    compaction: {
      model: boundedText(compactionModel, 160) || "deterministic_projection",
      version: boundedText(compactionVersion, 160) || "intent-context-packet-v1",
      input_event_count: rows.length,
      source_truncated: truncated,
    },
  };
  core.continuation_text = continuationText(core);
  const packetDigest = digest(core);
  return {
    ...core,
    packet_id: `intent_packet_${packetDigest.slice(0, 32)}`,
    packet_digest: packetDigest,
    generated_at: boundedText(generatedAt, 80) || new Date().toISOString(),
    continuation_allowed: !truncated
      && Boolean(core.objective.citation.event_id)
      && constraints.length === (state.constraints || []).length
      && acceptance.length === (state.completion_criteria || []).length,
  };
}

function validateIntentContextPacket(packet, { expectedIntentId, expectedIntentVersion } = {}) {
  if (!packet || packet.schema !== PACKET_SCHEMA) throw new Error("unsupported context packet schema");
  if (expectedIntentId && packet.intent_id !== expectedIntentId) throw new Error("context packet routed to wrong intent");
  if (expectedIntentVersion !== undefined && Number(packet.intent_version) !== Number(expectedIntentVersion)) {
    throw new Error(`stale context packet: expected intent version ${expectedIntentVersion}, packet has ${packet.intent_version}`);
  }
  if (digest(packetContent(packet)) !== packet.packet_digest) throw new Error("context packet digest mismatch");
  if (!packet.continuation_allowed) throw new Error("context packet is incomplete and cannot launch");
  if (!packet.objective?.citation?.event_id) throw new Error("context packet objective lacks citation");
  for (const item of [
    ...(packet.constraints || []),
    ...(packet.decisions || []),
    ...(packet.acceptance_criteria || []),
    ...(packet.blockers || []),
  ]) {
    if (!item?.citation?.event_id) throw new Error("context packet item lacks citation");
  }
  return packet;
}

module.exports = {
  PACKET_SCHEMA,
  buildIntentContextPacket,
  validateIntentContextPacket,
  packetContent,
  stableJson,
};
