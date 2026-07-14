"use strict";

const assert = require("node:assert/strict");
const {
  createBuiltinConnectorAdapter,
  createConnectorBroker,
  createFixtureConnectorAdapter,
  listAdapterDescriptors,
} = require("../lib/connector-broker");

async function main() {
  let clock = Date.parse("2026-07-13T12:00:00.000Z");
  const broker = createConnectorBroker({
    adapters: [createFixtureConnectorAdapter({ now: () => clock })],
    now: () => clock,
  });
  const actor = { adapterKind: "fixture", tenantId: "tenant_fixture", userId: "user_fixture" };

  const descriptors = listAdapterDescriptors();
  assert.deepEqual(descriptors.map((entry) => entry.kind), ["builtin", "nango", "composio"]);
  assert.equal(descriptors.find((entry) => entry.kind === "builtin").credential_custody, "moa_gateway");
  assert.equal(descriptors.find((entry) => entry.kind === "composio").optional, true);

  // The built-in bridge consumes the public shape of the existing Moa account
  // store while dropping its credential-reference metadata at the broker edge.
  const existingConnection = {
    id: "acctconn_existing_001",
    provider: "github",
    label: "Existing GitHub",
    status: "connected",
    scopes_granted: ["repo"],
    credential_ref_kind: "encrypted_server_secret",
  };
  const accountConnections = {
    create() {
      return {
        connection: { ...existingConnection, status: "pending_user_auth" },
        reauth_action: {
          url: "https://gateway.invalid/v1/account-connections/oauth/start?state=state_existing_001",
          expires_at: "2026-07-13T12:05:00.000Z",
        },
      };
    },
    requestReauth() { return this.create(); },
    async completeOauthCallback({ state }) {
      assert.equal(state, "state_existing_001");
      return { connection: existingConnection };
    },
    async requestRefresh() { return { connection: existingConnection }; },
    async disconnect() { return { ...existingConnection, status: "revoked" }; },
    get() { return existingConnection; },
  };
  const builtinBroker = createConnectorBroker({
    adapters: [createBuiltinConnectorAdapter({
      accountConnections,
      capabilities: () => [{ capability_key: "issue.create", risk_class: "external_side_effect", required_scopes: ["repo"] }],
      executor: () => ({ execution_id: "exec_builtin_001", receipt_handle: "rcpt_builtin_001", status: "succeeded" }),
      receiptReader: () => ({ execution_id: "exec_builtin_001", receipt_handle: "rcpt_builtin_001", status: "succeeded" }),
    })],
    now: () => clock,
  });
  const builtinActor = { adapterKind: "builtin", tenantId: "tenant_fixture", userId: "user_fixture" };
  const builtinAuthorization = await builtinBroker.authorize({
    ...builtinActor,
    request: { provider: "github", credential_kind: "oauth2_authorization_code" },
  });
  assert.equal(builtinAuthorization.authorization_handle, "state_existing_001");
  assert.equal(JSON.stringify(builtinAuthorization).includes("credential_ref"), false);
  const builtinConnection = await builtinBroker.callback({
    ...builtinActor,
    authorizationHandle: builtinAuthorization.authorization_handle,
    callback: { code: "opaque-provider-code" },
  });
  assert.equal(builtinConnection.connection_handle, existingConnection.id);
  assert.equal(JSON.stringify(builtinConnection).includes("credential_ref"), false);

  const authorization = await broker.authorize({
    ...actor,
    request: { service_id: "fixture", scopes: ["fixture.write", "fixture.read"] },
  });
  assert.match(authorization.authorization_handle, /^authz_fixture_/);
  assert.deepEqual(authorization.requested_scopes, ["fixture.read", "fixture.write"]);

  await assert.rejects(
    broker.callback({
      ...actor,
      tenantId: "tenant_other",
      authorizationHandle: authorization.authorization_handle,
      callback: { code: "fixture-approved" },
    }),
    (error) => error.code === "not_found",
  );

  const connected = await broker.callback({
    ...actor,
    authorizationHandle: authorization.authorization_handle,
    callback: { code: "fixture-approved", account_label: "Primary fixture" },
  });
  assert.match(connected.connection_handle, /^conn_fixture_/);
  assert.equal(connected.status, "connected");
  assert.equal(JSON.stringify(connected).includes("fixture-secret"), false);
  assert.equal(JSON.stringify(connected).includes("credential_ref"), false);

  await assert.rejects(
    broker.callback({
      ...actor,
      authorizationHandle: authorization.authorization_handle,
      callback: { code: "fixture-approved" },
    }),
    (error) => error.code === "callback_replayed",
  );

  const capabilityResult = await broker.listCapabilities({
    ...actor,
    connectionHandle: connected.connection_handle,
  });
  assert.deepEqual(capabilityResult.capabilities.map((entry) => entry.capability_key), [
    "fixture.items.list",
    "fixture.drafts.create",
  ]);
  assert.equal(capabilityResult.capabilities.every((entry) => entry.availability === "ready"), true);

  const executed = await broker.execute({
    ...actor,
    connectionHandle: connected.connection_handle,
    capabilityKey: "fixture.drafts.create",
    executionId: "exec_fixture_request",
    idempotencyKey: "same-request",
    input: { title: "Durable connector broker" },
  });
  assert.equal(executed.status, "succeeded");
  assert.match(executed.receipt_handle, /^rcpt_fixture_/);
  assert.equal(executed.result.title, "Durable connector broker");

  const duplicate = await broker.execute({
    ...actor,
    connectionHandle: connected.connection_handle,
    capabilityKey: "fixture.drafts.create",
    executionId: "exec_fixture_retry",
    idempotencyKey: "same-request",
    input: { title: "Must not create another draft" },
  });
  assert.equal(duplicate.receipt_handle, executed.receipt_handle);
  assert.deepEqual(duplicate.result, executed.result);

  const receipt = await broker.receipt({
    ...actor,
    connectionHandle: connected.connection_handle,
    receiptHandle: executed.receipt_handle,
  });
  assert.equal(receipt.execution_id, "exec_fixture_request");
  assert.deepEqual(receipt.result, executed.result);

  clock += 1000;
  const refreshed = await broker.refresh({ ...actor, connectionHandle: connected.connection_handle });
  assert.equal(refreshed.health, "healthy");
  assert.equal(JSON.stringify(refreshed).includes("fixture-secret"), false);

  const revoked = await broker.revoke({ ...actor, connectionHandle: connected.connection_handle });
  assert.equal(revoked.status, "revoked");
  const health = await broker.health({ ...actor, connectionHandle: connected.connection_handle });
  assert.equal(health.health, "revoked");

  await assert.rejects(
    broker.execute({
      ...actor,
      connectionHandle: connected.connection_handle,
      capabilityKey: "fixture.items.list",
      input: {},
    }),
    (error) => error.code === "connection_unavailable",
  );

  process.stdout.write("connector broker smoke: ok\n");
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
