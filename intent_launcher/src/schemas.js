const object = (required, properties) => ({
  type: "object",
  additionalProperties: true,
  required,
  properties,
});

const string = { type: "string", minLength: 1 };

export const schemas = Object.freeze({
  messageCreate: object(["message", "idempotency_key"], {
    message: string,
    idempotency_key: string,
    workspace_id: string,
    routing: { type: "object" },
  }),
  intentCreate: object(["statement", "normalized_objective", "idempotency_key"], {
    intent_id: string,
    statement: string,
    normalized_objective: string,
    idempotency_key: string,
    project_id: string,
  }),
  mutation: object(["idempotency_key", "expected_intent_version"], {
    idempotency_key: string,
    expected_intent_version: { type: "integer", minimum: 0 },
  }),
  claim: object(["agent_id", "run_id", "idempotency_key", "expected_intent_version"], {
    agent_id: string,
    run_id: string,
    idempotency_key: string,
    expected_intent_version: { type: "integer", minimum: 0 },
    lease_seconds: { type: "integer", minimum: 60, maximum: 86400 },
  }),
  progress: object(["agent_id", "run_id", "idempotency_key", "expected_intent_version"], {
    agent_id: string,
    run_id: string,
    idempotency_key: string,
    expected_intent_version: { type: "integer", minimum: 0 },
    progress: string,
    next_step: string,
    evidence_refs: { type: "array", items: string },
    artifact_refs: { type: "array", items: string },
  }),
  product: object(["product_id", "revision", "locator", "digest", "provenance"], {
    product_id: string,
    revision: string,
    locator: string,
    digest: { type: "string", pattern: "^sha256:[a-fA-F0-9]{64}$" },
    media_type: string,
    provenance: { type: "object" },
  }),
  attention: object(["idempotency_key", "message"], {
    idempotency_key: string,
    message: string,
    run_id: string,
  }),
});

export function assertSchema(name, value) {
  const schema = schemas[name];
  if (!schema) throw new TypeError(`unknown schema: ${name}`);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} input must be an object`);
  }
  for (const field of schema.required) {
    if (value[field] === undefined || value[field] === null || value[field] === "") {
      throw new TypeError(`${name}.${field} is required`);
    }
  }
  const expected = value.expected_intent_version;
  if (expected !== undefined && (!Number.isSafeInteger(expected) || expected < 0)) {
    throw new TypeError(`${name}.expected_intent_version must be a non-negative integer`);
  }
  return value;
}
