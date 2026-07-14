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

  if (url.username || url.password) {
    return {
      ok: false,
      severity: "error",
      code: "credentials",
      message: "Save only the gateway origin; credentials do not belong in the URL.",
    };
  }

  const endpointPath = url.pathname.replace(/\/+$/, "") || "/";
  if (endpointPath !== "/") {
    return {
      ok: false,
      severity: "error",
      code: "endpoint_path",
      message: "Save only the gateway origin, not an endpoint path.",
    };
  }
  if (url.search || url.hash) {
    return {
      ok: false,
      severity: "error",
      code: "query_or_fragment",
      message: "Save only the gateway origin, without a query or fragment.",
    };
  }
  if (raw !== url.origin) {
    return {
      ok: false,
      severity: "error",
      code: "non_canonical_origin",
      message: "Save exactly the canonical gateway origin, without empty query or fragment delimiters.",
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
  if (!url) return "";
  if (!gatewayUrlDiagnostic(url).ok) return "";
  if (isKnownStaleGatewayUrl(url)) return DEFAULT_GATEWAY_URL;
  return url;
}

function effectiveGatewayUrl(storedValue, bakedValue, userOwnsUrl = false) {
  const stored = normalizeGatewayUrl(storedValue);
  const baked = normalizeDefaultGatewayUrl(bakedValue);
  // A user-owned blank is an explicit disconnect. It must not fall through to
  // a packaged URL (or its token) merely because the stored string is empty.
  if (userOwnsUrl) return stored && gatewayUrlDiagnostic(stored).ok ? stored : "";
  if (!userOwnsUrl && isKnownStaleGatewayUrl(stored)) return baked;
  if (!stored || !gatewayUrlDiagnostic(stored).ok) return baked;
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
    // Missing local config is normal. The hosted URL remains an Options-page
    // suggestion, not an implicitly configured destination.
  }
  bakedCache = { gatewayUrl: "", gatewayToken: "" };
  return bakedCache;
}

async function seedGatewayConfig() {
  // Retained as a compatibility surface for older callers. Fresh installs do
  // not persist an implicit hosted gateway; explicit Options save owns that
  // consent boundary. A generated agee.config.json remains readable for
  // explicit turns without copying it into chrome.storage.
  await getBakedConfig();
  return {};
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
    gatewayToken: gatewayUrl
      ? String(
          userOwnsUrl
            ? (hasStoredToken ? stored.ageeGatewayToken || "" : "")
            : (usingStoredUrl && hasStoredToken ? stored.ageeGatewayToken || "" : baked.gatewayToken || "")
        )
      : "",
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
