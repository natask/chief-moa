const STORAGE_KEY = "moa_release_device_credential_v1";
const TOKEN_PATTERN = /^moa_dev_v1\.[A-Za-z0-9_-]{43}$/;
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const IDEMPOTENCY_PATTERN = /^device-register-[0-9a-f-]{36}$/;
const RELEASE_PATH_PATTERN =
  /^\/v1\/release-control\/apps\/[a-z0-9][a-z0-9._-]{0,127}\/(?:view|assignments|fallback|install-receipts|feedback)(?:\?[^#]*)?$/;

function createDeviceCredentialRuntime({
  storage,
  fetchImpl = globalThis.fetch,
  cryptoImpl = globalThis.crypto,
} = {}) {
  if (!storage || typeof storage.get !== "function" || typeof storage.set !== "function") {
    throw new Error("device credential storage is required");
  }
  if (typeof fetchImpl !== "function") throw new Error("fetch is required");
  if (!cryptoImpl || typeof cryptoImpl.getRandomValues !== "function"
      || typeof cryptoImpl.randomUUID !== "function") {
    throw new Error("secure browser crypto is required");
  }

  async function request(input = {}) {
    const binding = normalizeBinding(input, fetchImpl);
    releaseControlUrl(binding.gatewayOrigin, input.path);
    let credential = await ensureRegistered(binding, false);
    let response = await releaseFetch(binding, credential, input);
    if (response.status === 401) {
      credential = await ensureRegistered(binding, true);
      response = await releaseFetch(binding, credential, input);
    }
    return response;
  }

  async function ensureRegistered(binding, force) {
    let credential = normalizeStored(await storage.get(STORAGE_KEY), binding);
    if (!credential) {
      const bytes = new Uint8Array(32);
      cryptoImpl.getRandomValues(bytes);
      credential = {
        schema_version: 1,
        gateway_origin: binding.gatewayOrigin,
        device_id: binding.deviceId,
        surface_id: binding.surfaceId,
        token: `moa_dev_v1.${base64url(bytes)}`,
        idempotency_key: `device-register-${cryptoImpl.randomUUID()}`,
        registered: false,
      };
      await storage.set(STORAGE_KEY, credential);
    }
    if (!credential.registered || force) {
      if (!binding.gatewayToken) {
        throw new Error("Gateway bearer token is required to register this browser.");
      }
      const response = await fetchImpl(`${binding.gatewayOrigin}/v1/device-credentials/registrations`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: `Bearer ${binding.gatewayToken}`,
        },
        body: JSON.stringify({
          device_id: binding.deviceId,
          surface_id: binding.surfaceId,
          idempotency_key: credential.idempotency_key,
          credential_token: credential.token,
        }),
      });
      const payload = await boundedJson(response);
      const receipt = payload?.registration_receipt;
      if (!response.ok || payload?.schema_version !== 1 || !receipt
          || receipt.device_id !== binding.deviceId
          || receipt.surface_id !== binding.surfaceId
          || receipt.status !== "active") {
        throw new Error(`Device registration failed (${response.status}).`);
      }
      credential = { ...credential, registered: true };
      await storage.set(STORAGE_KEY, credential);
    }
    return credential;
  }

  return Object.freeze({ request });
}

async function releaseFetch(binding, credential, input) {
  const releaseUrl = releaseControlUrl(binding.gatewayOrigin, input.path);
  return binding.fetchImpl(releaseUrl.href, {
    method: String(input.method || "GET").toUpperCase(),
    headers: {
      accept: "application/json",
      ...(input.body ? { "content-type": "application/json" } : {}),
      authorization: `Device ${credential.token}`,
      "x-moa-device-id": binding.deviceId,
      "x-moa-surface": binding.surfaceId,
    },
    body: input.body ? JSON.stringify(input.body) : undefined,
  });
}

function normalizeBinding(input, fetchImpl) {
  const configuredUrl = new URL(String(input.gatewayUrl || ""));
  if (configuredUrl.username || configuredUrl.password) {
    throw new Error("gateway URL must not contain credentials");
  }
  const gatewayOrigin = configuredUrl.origin;
  requireSafeGatewayOrigin(gatewayOrigin);
  const deviceId = id(input.deviceId, "device_id");
  const surfaceId = id(input.surfaceId, "surface_id");
  if (surfaceId !== "browser_extension") throw new Error("unsupported device credential surface");
  return {
    gatewayOrigin,
    gatewayToken: String(input.gatewayToken || "").trim(),
    deviceId,
    surfaceId,
    fetchImpl,
  };
}

function normalizeStored(value, binding) {
  const record = value?.[STORAGE_KEY] || value;
  if (!record || record.schema_version !== 1
      || record.gateway_origin !== binding.gatewayOrigin
      || record.device_id !== binding.deviceId
      || record.surface_id !== binding.surfaceId) return null;
  if (JSON.stringify(record).length > 1024) {
    throw new Error("Stored browser device credential is invalid.");
  }
  if (!TOKEN_PATTERN.test(String(record.token || ""))
      || !IDEMPOTENCY_PATTERN.test(String(record.idempotency_key || ""))) {
    throw new Error("Stored browser device credential is invalid.");
  }
  return {
    schema_version: 1,
    gateway_origin: binding.gatewayOrigin,
    device_id: binding.deviceId,
    surface_id: binding.surfaceId,
    token: String(record.token),
    idempotency_key: String(record.idempotency_key),
    registered: record.registered === true,
  };
}

async function boundedJson(response) {
  const text = await response.text();
  if (text.length > 64 * 1024) throw new Error("Device registration response is too large.");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Device registration returned invalid JSON.");
  }
}

function base64url(bytes) {
  let binary = "";
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function id(value, label) {
  const result = String(value || "").trim().toLowerCase();
  if (!ID_PATTERN.test(result)) throw new Error(`${label} is invalid`);
  return result;
}

function requireSafeGatewayOrigin(origin) {
  const url = new URL(origin);
  const loopback = url.hostname === "localhost"
    || url.hostname === "127.0.0.1"
    || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("device credentials require HTTPS except on an explicit loopback gateway");
  }
}

function releaseControlUrl(gatewayOrigin, path) {
  const rawPath = String(path || "");
  if (!RELEASE_PATH_PATTERN.test(rawPath)) {
    throw new Error("device credentials are restricted to release-control routes");
  }
  const url = new URL(rawPath, gatewayOrigin);
  if (url.origin !== gatewayOrigin) {
    throw new Error("device credentials cannot be sent cross-origin");
  }
  return url;
}

export { STORAGE_KEY, createDeviceCredentialRuntime };
