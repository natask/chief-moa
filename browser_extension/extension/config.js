const DEFAULT_GATEWAY_URL = "https://api.agee.app";
const LOCAL_GATEWAY_URL = "http://10.147.17.6:8787";
const LEGACY_MAIN_GATEWAY_URL = "http://10.147.17.10:8787";
const STALE_DEFAULT_GATEWAY_URLS = new Set([
  LEGACY_MAIN_GATEWAY_URL,
  "http://10.147.17.10:8788",
  LOCAL_GATEWAY_URL,
]);
const STALE_GATEWAY_HOST_MESSAGES = new Map([
  [
    "10.147.17.10",
    "This points at the old main-machine ZeroTier gateway. Use the VPS URL unless you are intentionally testing local dev.",
  ],
  [
    "10.147.17.6",
    "This points at the local Mac gateway. Use the VPS URL for mobile/browser onboarding.",
  ],
]);
const SAVED_ENDPOINT_PATHS = new Set([
  "/health",
  "/v1/chat",
  "/v1/voice/turns",
  "/v1/voice/sessions",
  "/v1/voice/session-ticket",
]);

let bakedCache = null;

function normalizeGatewayUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function gatewayUrlDiagnostic(value) {
  const raw = normalizeGatewayUrl(value);
  if (!raw) {
    return { ok: false, severity: "error", code: "missing_config", message: "Enter a gateway URL first." };
  }
  if (!/^https?:\/\//i.test(raw)) {
    return {
      ok: false,
      severity: "error",
      code: "missing_scheme",
      message: `Enter the full gateway URL, for example ${DEFAULT_GATEWAY_URL}.`,
    };
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    return {
      ok: false,
      severity: "error",
      code: "invalid_url",
      message: `Enter a valid gateway URL, for example ${DEFAULT_GATEWAY_URL}.`,
    };
  }

  const endpointPath = url.pathname.replace(/\/+$/, "") || "/";
  if (endpointPath !== "/" && (SAVED_ENDPOINT_PATHS.has(endpointPath) || endpointPath.startsWith("/v1/"))) {
    return {
      ok: false,
      severity: "error",
      code: "endpoint_path",
      message: "Save only the gateway origin, not an endpoint path.",
    };
  }

  const staleMessage = STALE_GATEWAY_HOST_MESSAGES.get(url.hostname);
  if (staleMessage) {
    return { ok: true, severity: "warning", code: "stale_or_local_url", message: staleMessage };
  }

  return { ok: true, severity: "ok", code: "ok", message: "" };
}

function isKnownStaleGatewayUrl(value) {
  const url = normalizeGatewayUrl(value);
  if (!url) return false;
  if (STALE_DEFAULT_GATEWAY_URLS.has(url)) return true;
  return gatewayUrlDiagnostic(url).code === "stale_or_local_url";
}

function normalizeDefaultGatewayUrl(value) {
  const url = normalizeGatewayUrl(value);
  if (!url || isKnownStaleGatewayUrl(url)) return DEFAULT_GATEWAY_URL;
  return url;
}

function effectiveGatewayUrl(storedValue, bakedValue, userOwnsUrl = false) {
  const stored = normalizeGatewayUrl(storedValue);
  if (!stored) return bakedValue;
  if (!userOwnsUrl && isKnownStaleGatewayUrl(stored)) return bakedValue;
  return stored;
}

async function getBakedConfig() {
  if (bakedCache) return bakedCache;
  try {
    const resp = await fetch(chrome.runtime.getURL("agee.config.json"));
    if (resp.ok) {
      const cfg = await resp.json();
      const rawGatewayUrl = normalizeGatewayUrl(cfg.gatewayUrl);
      const staleBakedGateway = isKnownStaleGatewayUrl(rawGatewayUrl);
      bakedCache = {
        gatewayUrl: normalizeDefaultGatewayUrl(rawGatewayUrl),
        gatewayToken: staleBakedGateway ? "" : String(cfg.gatewayToken || ""),
      };
      return bakedCache;
    }
  } catch {
    // Missing local config is normal on a fresh checkout. The gateway URL still
    // defaults to the hosted endpoint; the token can be added later.
  }
  bakedCache = { gatewayUrl: DEFAULT_GATEWAY_URL, gatewayToken: "" };
  return bakedCache;
}

async function seedGatewayConfig() {
  const baked = await getBakedConfig();
  const cur = await chrome.storage.local.get([
    "ageeGatewayUrl",
    "ageeGatewayToken",
    "ageeGatewayUserSet",
  ]);
  const curUrl = normalizeGatewayUrl(cur.ageeGatewayUrl);
  const patch = {};
  // Adopt the baked gateway config unless the user picked the URL by hand.
  // The stored value is otherwise just a previously-seeded default, so a new
  // baked URL (from `npm run configure`, e.g. pointing at a local gateway)
  // must win instead of the extension clinging to the old seeded URL.
  const userOwnsUrl = cur.ageeGatewayUserSet === true;
  const shouldAdoptBaked =
    !curUrl ||
    (!userOwnsUrl && (isKnownStaleGatewayUrl(curUrl) || curUrl !== baked.gatewayUrl));
  if (shouldAdoptBaked) {
    patch.ageeGatewayUrl = baked.gatewayUrl;
    // Carry the matching token so auth tracks the gateway we just adopted;
    // a stale token from the old gateway would 401 against the new one.
    patch.ageeGatewayToken = baked.gatewayToken || "";
  } else if (!cur.ageeGatewayToken && baked.gatewayToken) {
    patch.ageeGatewayToken = baked.gatewayToken;
  }
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
  return patch;
}

async function getEffectiveGatewayConfig() {
  const stored = await chrome.storage.local.get([
    "ageeGatewayUrl",
    "ageeGatewayToken",
    "ageeGatewayUserSet",
  ]);
  const baked = await getBakedConfig();
  const hasStoredToken = Object.prototype.hasOwnProperty.call(stored, "ageeGatewayToken");
  const userOwnsUrl = stored.ageeGatewayUserSet === true;
  const storedUrl = normalizeGatewayUrl(stored.ageeGatewayUrl);
  const gatewayUrl = effectiveGatewayUrl(storedUrl, baked.gatewayUrl, userOwnsUrl);
  const usingStoredUrl = Boolean(storedUrl) && gatewayUrl === storedUrl;
  return {
    gatewayUrl,
    gatewayToken: String(usingStoredUrl && hasStoredToken ? stored.ageeGatewayToken || "" : baked.gatewayToken || ""),
  };
}

export {
  DEFAULT_GATEWAY_URL,
  LEGACY_MAIN_GATEWAY_URL,
  LOCAL_GATEWAY_URL,
  STALE_DEFAULT_GATEWAY_URLS,
  effectiveGatewayUrl,
  gatewayUrlDiagnostic,
  getEffectiveGatewayConfig,
  isKnownStaleGatewayUrl,
  normalizeDefaultGatewayUrl,
  normalizeGatewayUrl,
  seedGatewayConfig,
};
