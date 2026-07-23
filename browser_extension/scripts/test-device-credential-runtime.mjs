import assert from "node:assert/strict";
import test from "node:test";
import {
  STORAGE_KEY,
  createDeviceCredentialRuntime,
} from "../extension/device-credential-runtime.js";

function jsonResponse(status, payload) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async text() { return JSON.stringify(payload); },
  };
}

function harness(responses = []) {
  const values = {};
  const calls = [];
  let uuidCounter = 0;
  const runtime = createDeviceCredentialRuntime({
    storage: {
      async get(key) { return { [key]: values[key] }; },
      async set(key, value) { values[key] = structuredClone(value); },
    },
    cryptoImpl: {
      getRandomValues(bytes) {
        bytes.fill(7);
        return bytes;
      },
      randomUUID() {
        uuidCounter += 1;
        return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, "0")}`;
      },
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return responses.shift() || jsonResponse(200, { schema_version: 1 });
    },
  });
  return { runtime, values, calls };
}

const input = {
  gatewayUrl: "https://api.agee.app/v1/chat",
  gatewayToken: "account-secret",
  deviceId: "browser_1",
  surfaceId: "browser_extension",
  path: "/v1/release-control/apps/chief-moa/view",
};

const receipt = {
  schema_version: 1,
  registration_receipt: {
    credential_id: "devc_test",
    device_id: "browser_1",
    surface_id: "browser_extension",
    status: "active",
    created_at: "2026-07-23T00:00:00.000Z",
  },
};

test("persists a client-generated credential before registration and uses Device auth", async () => {
  const { runtime, values, calls } = harness([
    jsonResponse(201, receipt),
    jsonResponse(200, { schema_version: 1 }),
  ]);
  const response = await runtime.request(input);
  assert.equal(response.status, 200);
  assert.equal(calls.length, 2);

  const registration = JSON.parse(calls[0].options.body);
  assert.equal(calls[0].options.headers.authorization, "Bearer account-secret");
  assert.match(registration.credential_token, /^moa_dev_v1\.[A-Za-z0-9_-]{43}$/);
  assert.equal(values[STORAGE_KEY].token, registration.credential_token);
  assert.equal(values[STORAGE_KEY].registered, true);

  assert.equal(calls[1].options.headers.authorization, `Device ${registration.credential_token}`);
  assert.equal(calls[1].options.headers["x-moa-device-id"], "browser_1");
  assert.equal(calls[1].options.headers["x-moa-surface"], "browser_extension");
});

test("one release 401 performs an exact idempotent registration retry and retries once", async () => {
  const { runtime, calls } = harness([
    jsonResponse(201, receipt),
    jsonResponse(401, { error: "unauthorized" }),
    jsonResponse(200, receipt),
    jsonResponse(401, { error: "unauthorized" }),
  ]);
  const response = await runtime.request(input);
  assert.equal(response.status, 401);
  assert.equal(calls.length, 4);
  const firstRegistration = JSON.parse(calls[0].options.body);
  const retryRegistration = JSON.parse(calls[2].options.body);
  assert.equal(retryRegistration.credential_token, firstRegistration.credential_token);
  assert.equal(retryRegistration.idempotency_key, firstRegistration.idempotency_key);
  assert.equal(calls.filter((call) => call.options.headers.authorization === "Bearer account-secret").length, 2);
});

test("fails closed without bootstrap bearer and rejects a mismatched receipt", async () => {
  await assert.rejects(
    harness().runtime.request({ ...input, gatewayToken: "" }),
    /bearer token is required/i,
  );
  await assert.rejects(
    harness([jsonResponse(201, {
      ...receipt,
      registration_receipt: { ...receipt.registration_receipt, device_id: "other" },
    })]).runtime.request(input),
    /registration failed/i,
  );
});

test("registers once and reuses the bounded stored credential", async () => {
  const { runtime, values, calls } = harness([
    jsonResponse(201, receipt),
    jsonResponse(200, { schema_version: 1 }),
    jsonResponse(200, { schema_version: 1 }),
  ]);
  values[STORAGE_KEY] = undefined;
  await runtime.request(input);
  await runtime.request(input);

  assert.equal(calls.length, 3);
  assert.equal(calls.filter((call) =>
    call.url.endsWith("/v1/device-credentials/registrations")).length, 1);
  assert.equal(calls.filter((call) =>
    call.options.headers.authorization.startsWith("Device ")).length, 2);
});

test("never sends a device credential over unsafe transport or outside release control", async () => {
  for (const gatewayUrl of [
    "http://api.agee.app",
    "ftp://localhost",
    "https://user:secret@api.agee.app",
  ]) {
    const unsafe = harness();
    await assert.rejects(
      unsafe.runtime.request({ ...input, gatewayUrl }),
      /https|credentials/i,
    );
    assert.equal(unsafe.calls.length, 0);
  }

  for (const path of [
    "/v1/voice/turns",
    "//attacker.example/v1/release-control/apps/chief-moa/view",
    "/v1/release-control/apps/chief-moa/view#leak",
  ]) {
    const wrongRoute = harness();
    await assert.rejects(
      wrongRoute.runtime.request({ ...input, path }),
      /release-control/i,
    );
    assert.equal(wrongRoute.calls.length, 0);
  }
});

test("rejects an oversized stored credential before network use", async () => {
  const seeded = harness();
  seeded.values[STORAGE_KEY] = {
    schema_version: 1,
    gateway_origin: "https://api.agee.app",
    device_id: "browser_1",
    surface_id: "browser_extension",
    token: `moa_dev_v1.${"A".repeat(43)}`,
    idempotency_key: "device-register-00000000-0000-4000-8000-000000000001",
    registered: true,
    unexpected: "x".repeat(1024),
  };
  await assert.rejects(seeded.runtime.request(input), /stored browser device credential is invalid/i);
  assert.equal(seeded.calls.length, 0);
});

test("allows explicit loopback HTTP development gateways", async () => {
  for (const gatewayUrl of ["http://localhost:8787", "http://127.0.0.1:8787", "http://[::1]:8787"]) {
    const local = harness([
      jsonResponse(201, receipt),
      jsonResponse(200, { schema_version: 1 }),
    ]);
    const response = await local.runtime.request({ ...input, gatewayUrl });
    assert.equal(response.status, 200);
    assert.equal(local.calls.length, 2);
  }
});
