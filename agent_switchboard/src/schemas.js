import crypto from "node:crypto";

export const ACTIONS = Object.freeze([
  "observation", "new", "update", "fork", "merge", "status", "steer", "launch",
]);

export const ROUTE_DECISION_SCHEMA = "chief-moa.agent-switchboard.route-decision.v1";
export const MESSAGE_ENVELOPE_SCHEMA = "chief-moa.agent-switchboard.message-envelope.v1";

const object = (value) => value && typeof value === "object" && !Array.isArray(value);
const text = (value, max, label, required = false) => {
  const result = String(value ?? "").trim();
  if (required && !result) throw new TypeError(`${label} is required`);
  if (result.length > max) throw new TypeError(`${label} exceeds ${max} characters`);
  return result;
};
const optionalContext = (value, label) => {
  if (value === undefined || value === null) return undefined;
  if (!object(value)) throw new TypeError(`${label} must be an object`);
  return structuredClone(value);
};

export function validateEnvelope(input) {
  if (!object(input)) throw new TypeError("message envelope must be an object");
  const occurredAt = text(input.occurred_at, 64, "occurred_at", true);
  if (Number.isNaN(Date.parse(occurredAt))) throw new TypeError("occurred_at must be an ISO timestamp");
  const envelope = {
    schema: MESSAGE_ENVELOPE_SCHEMA,
    envelope_id: text(input.envelope_id, 160, "envelope_id", true),
    occurred_at: occurredAt,
    message: {
      role: text(input.message?.role, 40, "message.role", true),
      text: text(input.message?.text, 20_000, "message.text", true),
    },
    context: {},
  };
  for (const key of ["product", "page", "screen", "selection", "file", "provenance"]) {
    const value = optionalContext(input.context?.[key], `context.${key}`);
    if (value !== undefined) envelope.context[key] = value;
  }
  if (input.hints !== undefined) {
    if (!object(input.hints)) throw new TypeError("hints must be an object");
    envelope.hints = structuredClone(input.hints);
  }
  return Object.freeze(envelope);
}

export function assertChronological(envelopes) {
  let previous = -Infinity;
  const ids = new Set();
  return envelopes.map((raw) => {
    const envelope = validateEnvelope(raw);
    const timestamp = Date.parse(envelope.occurred_at);
    if (timestamp < previous) throw new TypeError("message envelopes must be chronological");
    if (ids.has(envelope.envelope_id)) throw new TypeError("envelope_id must be unique");
    previous = timestamp;
    ids.add(envelope.envelope_id);
    return envelope;
  });
}

export function stableDecisionId(envelopeId, action, targetIds = []) {
  const digest = crypto.createHash("sha256")
    .update(JSON.stringify([envelopeId, action, [...targetIds].sort()]))
    .digest("hex").slice(0, 24);
  return `route_${digest}`;
}

export function validateAction(action) {
  if (!object(action) || !ACTIONS.includes(action.type)) throw new TypeError("unsupported switchboard action");
  return structuredClone(action);
}
