"use strict";

const crypto = require("node:crypto");

// Connector adapters are gateway-side implementation details. Clients and
// models receive only the broker's opaque authorization, connection, execution,
// and receipt handles; provider credentials and vendor handles never cross this
// boundary.

const ADAPTER_DESCRIPTORS = Object.freeze([
  Object.freeze({
    kind: "builtin",
    label: "Moa built-in connectors",
    mode: "self_hosted",
    optional: false,
    credential_custody: "moa_gateway",
    enabled_by_default: true,
  }),
  Object.freeze({
    kind: "nango",
    label: "Nango adapter",
    mode: "external_broker",
    optional: true,
    credential_custody: "external_broker",
    enabled_by_default: false,
  }),
  Object.freeze({
    kind: "composio",
    label: "Composio adapter",
    mode: "external_broker",
    optional: true,
    credential_custody: "external_broker",
    enabled_by_default: false,
  }),
]);

const REQUIRED_METHODS = Object.freeze([
  "authorize",
  "callback",
  "refresh",
  "revoke",
  "health",
  "listCapabilities",
  "execute",
  "receipt",
]);

const SECRET_KEY = /^(?:access_token|refresh_token|id_token|api_key|client_secret|secret|password|credential|credentials|credential_ref|credential_reference|cookie|cookies|vendor_handle|external_handle|authorization_header)$/i;
const SECRET_VALUE = /(?:bearer\s+|(?:access|refresh|api|session)[_-]?token\s*[:=]|(?:sk|ghp|xox[baprs])-[a-z0-9_-]{8,})/i;
const IDENTIFIER = /^[a-z][a-z0-9_.-]{0,127}$/;

function listAdapterDescriptors() {
  return ADAPTER_DESCRIPTORS.map((descriptor) => ({ ...descriptor }));
}

function validateConnectorAdapter(adapter) {
  if (!adapter || typeof adapter !== "object") {
    throw brokerError("invalid_adapter", "connector adapter must be an object");
  }
  if (!IDENTIFIER.test(String(adapter.kind || ""))) {
    throw brokerError("invalid_adapter", "connector adapter kind is invalid");
  }
  for (const method of REQUIRED_METHODS) {
    if (typeof adapter[method] !== "function") {
      throw brokerError("invalid_adapter", `connector adapter ${adapter.kind} is missing ${method}()`);
    }
  }
  return adapter;
}

function createConnectorBroker({ adapters = [], now = () => Date.now() } = {}) {
  const registry = new Map();
  for (const candidate of adapters) {
    const adapter = validateConnectorAdapter(candidate);
    if (registry.has(adapter.kind)) {
      throw brokerError("duplicate_adapter", `duplicate connector adapter kind: ${adapter.kind}`);
    }
    registry.set(adapter.kind, adapter);
  }

  function adapterFor(kind) {
    const adapter = registry.get(String(kind || ""));
    if (!adapter) throw brokerError("adapter_unavailable", `connector adapter is unavailable: ${kind || "(empty)"}`);
    return adapter;
  }

  function actor(input) {
    const tenantId = boundedId(input?.tenantId, "tenant_id");
    const userId = boundedId(input?.userId, "user_id");
    return { tenantId, userId };
  }

  async function call(operation, input, invoke) {
    const identity = actor(input);
    const adapter = adapterFor(input.adapterKind);
    const result = await invoke(adapter, identity);
    assertNoSecrets(result, `${operation} adapter result`);
    return publicEnvelope(operation, adapter.kind, result, now());
  }

  return Object.freeze({
    descriptors: listAdapterDescriptors,
    adapterKinds: () => [...registry.keys()].sort(),
    authorize(input = {}) {
      return call("authorize", input, (adapter, identity) => adapter.authorize({ ...identity, request: clone(input.request || {}) }));
    },
    callback(input = {}) {
      return call("callback", input, (adapter, identity) => adapter.callback({
        ...identity,
        authorizationHandle: opaqueHandle(input.authorizationHandle, "authorization_handle"),
        callback: clone(input.callback || {}),
      }));
    },
    refresh(input = {}) {
      return call("refresh", input, (adapter, identity) => adapter.refresh({
        ...identity,
        connectionHandle: opaqueHandle(input.connectionHandle, "connection_handle"),
      }));
    },
    revoke(input = {}) {
      return call("revoke", input, (adapter, identity) => adapter.revoke({
        ...identity,
        connectionHandle: opaqueHandle(input.connectionHandle, "connection_handle"),
      }));
    },
    health(input = {}) {
      return call("health", input, (adapter, identity) => adapter.health({
        ...identity,
        connectionHandle: opaqueHandle(input.connectionHandle, "connection_handle"),
      }));
    },
    listCapabilities(input = {}) {
      return call("list_capabilities", input, (adapter, identity) => adapter.listCapabilities({
        ...identity,
        connectionHandle: opaqueHandle(input.connectionHandle, "connection_handle"),
      }));
    },
    execute(input = {}) {
      return call("execute", input, (adapter, identity) => adapter.execute({
        ...identity,
        connectionHandle: opaqueHandle(input.connectionHandle, "connection_handle"),
        capabilityKey: boundedId(input.capabilityKey, "capability_key"),
        executionId: opaqueHandle(input.executionId || createHandle("exec"), "execution_id"),
        idempotencyKey: boundedString(input.idempotencyKey || "", 200),
        input: clone(input.input || {}),
      }));
    },
    receipt(input = {}) {
      return call("receipt", input, (adapter, identity) => adapter.receipt({
        ...identity,
        connectionHandle: opaqueHandle(input.connectionHandle, "connection_handle"),
        receiptHandle: opaqueHandle(input.receiptHandle, "receipt_handle"),
      }));
    },
  });
}

// Bridges the current account-connections store into the common adapter
// contract. Capability execution and receipts are injected because the account
// store deliberately owns credentials, not service-specific API operations.
function createBuiltinConnectorAdapter({
  accountConnections,
  capabilities = () => [],
  executor,
  receiptReader,
} = {}) {
  if (!accountConnections) throw brokerError("invalid_adapter", "accountConnections is required");
  return validateConnectorAdapter({
    kind: "builtin",
    async authorize({ userId, request }) {
      if (request.connection_handle) {
        const result = accountConnections.requestReauth(userId, request.connection_handle);
        return authProjection(result);
      }
      return authProjection(accountConnections.create(userId, request));
    },
    async callback({ authorizationHandle, callback }) {
      const result = await accountConnections.completeOauthCallback({
        ...callback,
        state: callback.state || authorizationHandle,
      });
      return connectionProjection(result.connection);
    },
    async refresh({ userId, connectionHandle }) {
      return connectionProjection(await accountConnections.requestRefresh(userId, connectionHandle));
    },
    async revoke({ userId, connectionHandle }) {
      return connectionProjection(await accountConnections.disconnect(userId, connectionHandle));
    },
    async health({ userId, connectionHandle }) {
      return connectionProjection(accountConnections.get(userId, connectionHandle));
    },
    async listCapabilities({ userId, tenantId, connectionHandle }) {
      const connection = accountConnections.get(userId, connectionHandle);
      return capabilityProjection(await capabilities({ tenantId, userId, connection: connectionProjection(connection) }));
    },
    async execute(context) {
      if (typeof executor !== "function") throw brokerError("execution_unavailable", "built-in connector execution is not wired");
      return executionProjection(await executor(context));
    },
    async receipt(context) {
      if (typeof receiptReader !== "function") throw brokerError("receipt_unavailable", "built-in connector receipt storage is not wired");
      return receiptProjection(await receiptReader(context));
    },
  });
}

// Test-only, deterministic and network-free. Secrets exist only in this
// closure, standing in for a gateway credential store. They are never returned.
function createFixtureConnectorAdapter({ now = () => Date.now() } = {}) {
  const auth = new Map();
  const connections = new Map();
  const receipts = new Map();
  let sequence = 0;
  const next = (prefix) => `${prefix}_fixture_${String(++sequence).padStart(4, "0")}`;

  function owned(map, handle, tenantId, userId, kind) {
    const record = map.get(handle);
    if (!record || record.tenantId !== tenantId || record.userId !== userId) {
      throw brokerError("not_found", `${kind} not found`);
    }
    return record;
  }

  function view(record) {
    return {
      connection_handle: record.handle,
      service_id: record.serviceId,
      account_label: record.accountLabel,
      scopes: [...record.scopes],
      status: record.status,
      expires_at: record.expiresAt,
      health: record.status === "connected" ? "healthy" : record.status,
    };
  }

  const fixtureCapabilities = Object.freeze([
    Object.freeze({ capability_key: "fixture.items.list", risk_class: "read", required_scopes: ["fixture.read"] }),
    Object.freeze({ capability_key: "fixture.drafts.create", risk_class: "draft", required_scopes: ["fixture.write"] }),
  ]);

  return validateConnectorAdapter({
    kind: "fixture",
    async authorize({ tenantId, userId, request }) {
      const handle = next("authz");
      const scopes = normalizeStrings(request.scopes || ["fixture.read"]);
      auth.set(handle, { tenantId, userId, scopes, serviceId: "fixture", used: false });
      return {
        authorization_handle: handle,
        authorization_url: `https://fixture.invalid/authorize?handle=${encodeURIComponent(handle)}`,
        requested_scopes: scopes,
        status: "pending_user_auth",
      };
    },
    async callback({ tenantId, userId, authorizationHandle, callback }) {
      const pending = owned(auth, authorizationHandle, tenantId, userId, "authorization");
      if (pending.used) throw brokerError("callback_replayed", "authorization callback was already used");
      pending.used = true;
      if (callback.code !== "fixture-approved") throw brokerError("authorization_denied", "fixture authorization was denied");
      const handle = next("conn");
      const record = {
        handle,
        tenantId,
        userId,
        serviceId: pending.serviceId,
        accountLabel: boundedString(callback.account_label || "Fixture account", 120),
        scopes: pending.scopes,
        status: "connected",
        expiresAt: new Date(now() + 60 * 60 * 1000).toISOString(),
        credential: `fixture-secret-${handle}`,
      };
      connections.set(handle, record);
      return view(record);
    },
    async refresh({ tenantId, userId, connectionHandle }) {
      const record = owned(connections, connectionHandle, tenantId, userId, "connection");
      if (record.status !== "connected") throw brokerError("connection_unavailable", "connection is not active");
      record.expiresAt = new Date(now() + 60 * 60 * 1000).toISOString();
      record.credential = `fixture-secret-rotated-${connectionHandle}-${now()}`;
      return view(record);
    },
    async revoke({ tenantId, userId, connectionHandle }) {
      const record = owned(connections, connectionHandle, tenantId, userId, "connection");
      record.status = "revoked";
      record.credential = "";
      record.expiresAt = "";
      return view(record);
    },
    async health({ tenantId, userId, connectionHandle }) {
      return view(owned(connections, connectionHandle, tenantId, userId, "connection"));
    },
    async listCapabilities({ tenantId, userId, connectionHandle }) {
      const record = owned(connections, connectionHandle, tenantId, userId, "connection");
      return capabilityProjection(fixtureCapabilities.map((capability) => ({
        ...capability,
        availability: capability.required_scopes.every((scope) => record.scopes.includes(scope)) && record.status === "connected"
          ? "ready"
          : "needs_scope",
      })));
    },
    async execute({ tenantId, userId, connectionHandle, capabilityKey, executionId, idempotencyKey, input }) {
      const record = owned(connections, connectionHandle, tenantId, userId, "connection");
      if (record.status !== "connected") throw brokerError("connection_unavailable", "connection is not active");
      const capability = fixtureCapabilities.find((candidate) => candidate.capability_key === capabilityKey);
      if (!capability) throw brokerError("unknown_capability", "fixture capability is unknown");
      if (!capability.required_scopes.every((scope) => record.scopes.includes(scope))) {
        throw brokerError("insufficient_scope", "connection lacks a required capability scope");
      }
      const existing = idempotencyKey && [...receipts.values()].find((candidate) =>
        candidate.connectionHandle === connectionHandle && candidate.idempotencyKey === idempotencyKey);
      if (existing) return executionProjection(existing);
      const receiptHandle = next("rcpt");
      const created = {
        receiptHandle,
        connectionHandle,
        tenantId,
        userId,
        executionId,
        idempotencyKey,
        capabilityKey,
        status: "succeeded",
        completedAt: new Date(now()).toISOString(),
        result: capabilityKey === "fixture.items.list"
          ? { item_ids: ["fixture-item-1", "fixture-item-2"] }
          : { draft_id: next("draft"), title: boundedString(input.title || "Untitled", 120) },
      };
      receipts.set(receiptHandle, created);
      return executionProjection(created);
    },
    async receipt({ tenantId, userId, connectionHandle, receiptHandle }) {
      const stored = owned(receipts, receiptHandle, tenantId, userId, "receipt");
      if (stored.connectionHandle !== connectionHandle) throw brokerError("not_found", "receipt not found");
      return receiptProjection(stored);
    },
  });
}

function authProjection(value = {}) {
  const connection = value.connection || {};
  const action = value.reauth_action || value.authorization || value;
  return compact({
    authorization_handle: action.authorization_handle || action.state_handle || handleFromAuthorizationUrl(action.url || action.authorization_url),
    connection_handle: connection.id || connection.connection_handle || value.connection_handle || "",
    authorization_url: action.url || action.authorization_url || "",
    expires_at: action.expires_at || "",
    requested_scopes: normalizeStrings(action.requested_scopes || []),
    status: connection.status || value.status || "pending_user_auth",
  });
}

function connectionProjection(value = {}) {
  const record = value.connection || value;
  return compact({
    connection_handle: record.connection_handle || record.id || "",
    service_id: record.service_id || record.provider || "",
    account_label: record.account_label || record.label || record.account_subject?.display || "",
    scopes: normalizeStrings(record.scopes || record.scopes_granted || []),
    status: record.status || "unknown",
    expires_at: record.expires_at || "",
    health: record.health || healthFromStatus(record.status),
    needs_user_action: Boolean(record.needs_user_action),
  });
}

function capabilityProjection(values) {
  if (!Array.isArray(values)) throw brokerError("invalid_adapter_output", "capability result must be an array");
  return {
    capabilities: values.map((value) => compact({
      capability_key: boundedId(value.capability_key, "capability_key"),
      risk_class: boundedString(value.risk_class || "read", 40),
      required_scopes: normalizeStrings(value.required_scopes || []),
      availability: boundedString(value.availability || "ready", 40),
    })),
  };
}

function executionProjection(value = {}) {
  return compact({
    execution_id: value.execution_id || value.executionId || "",
    receipt_handle: value.receipt_handle || value.receiptHandle || "",
    capability_key: value.capability_key || value.capabilityKey || "",
    status: value.status || "unknown",
    completed_at: value.completed_at || value.completedAt || "",
    result: clone(value.result || {}),
  });
}

function receiptProjection(value = {}) {
  return executionProjection(value);
}

function publicEnvelope(operation, adapterKind, result, timestamp) {
  return Object.freeze({
    version: 1,
    operation,
    adapter_kind: adapterKind,
    observed_at: new Date(timestamp).toISOString(),
    ...clone(result || {}),
  });
}

function assertNoSecrets(value, path = "result", seen = new Set()) {
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    if (SECRET_VALUE.test(value)) throw brokerError("secret_output", `${path} contains credential-shaped material`);
    return;
  }
  if (typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) throw brokerError("secret_output", `${path}.${key} is not client/model-visible`);
    assertNoSecrets(child, `${path}.${key}`, seen);
  }
}

function healthFromStatus(status) {
  if (status === "connected") return "healthy";
  if (status === "revoked" || status === "disabled") return "unavailable";
  return "action_required";
}

function handleFromAuthorizationUrl(value) {
  try {
    const url = new URL(String(value || ""), "https://gateway.invalid");
    return url.searchParams.get("state") || url.searchParams.get("token") || "";
  } catch {
    return "";
  }
}

function opaqueHandle(value, field) {
  const handle = boundedString(value, 200);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{2,199}$/.test(handle)) throw brokerError("invalid_request", `${field} is invalid`);
  return handle;
}

function boundedId(value, field) {
  const id = boundedString(value, 128);
  if (!IDENTIFIER.test(id)) throw brokerError("invalid_request", `${field} is invalid`);
  return id;
}

function boundedString(value, limit) {
  const string = String(value || "").trim();
  if (string.length > limit) throw brokerError("invalid_request", `value exceeds ${limit} characters`);
  return string;
}

function normalizeStrings(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => boundedString(value, 120)).filter(Boolean))].sort();
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== "" && child !== undefined));
}

function createHandle(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString("hex")}`;
}

function brokerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

module.exports = {
  REQUIRED_METHODS,
  listAdapterDescriptors,
  validateConnectorAdapter,
  createConnectorBroker,
  createBuiltinConnectorAdapter,
  createFixtureConnectorAdapter,
  assertNoSecrets,
};
