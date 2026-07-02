const DEFAULT_GATEWAY_URL = "http://10.147.17.10:8787";
const LOCAL_GATEWAY_URL = "http://10.147.17.6:8787";
const STALE_DEFAULT_GATEWAY_URLS = new Set(["http://10.147.17.10:8788"]);

let bakedCache = null;

function normalizeGatewayUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function normalizeDefaultGatewayUrl(value) {
  const url = normalizeGatewayUrl(value);
  if (!url || STALE_DEFAULT_GATEWAY_URLS.has(url)) return DEFAULT_GATEWAY_URL;
  return url;
}

function effectiveGatewayUrl(storedValue, bakedValue) {
  const stored = normalizeGatewayUrl(storedValue);
  if (!stored || STALE_DEFAULT_GATEWAY_URLS.has(stored)) return bakedValue;
  return stored;
}

async function getBakedConfig() {
  if (bakedCache) return bakedCache;
  try {
    const resp = await fetch(chrome.runtime.getURL("agee.config.json"));
    if (resp.ok) {
      const cfg = await resp.json();
      bakedCache = {
        gatewayUrl: normalizeDefaultGatewayUrl(cfg.gatewayUrl),
        gatewayToken: String(cfg.gatewayToken || ""),
      };
      return bakedCache;
    }
  } catch {
    // Missing local config is normal on a fresh checkout. The gateway URL still
    // defaults to the main-machine endpoint; the token can be added later.
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
    STALE_DEFAULT_GATEWAY_URLS.has(curUrl) ||
    (!userOwnsUrl && curUrl !== baked.gatewayUrl);
  if (shouldAdoptBaked) {
    patch.ageeGatewayUrl = baked.gatewayUrl;
    // Carry the matching token so auth tracks the gateway we just adopted;
    // a stale token from the old gateway would 401 against the new one.
    if (baked.gatewayToken) patch.ageeGatewayToken = baked.gatewayToken;
  } else if (!cur.ageeGatewayToken && baked.gatewayToken) {
    patch.ageeGatewayToken = baked.gatewayToken;
  }
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
  return patch;
}

async function getEffectiveGatewayConfig() {
  const stored = await chrome.storage.local.get(["ageeGatewayUrl", "ageeGatewayToken"]);
  const baked = await getBakedConfig();
  const hasStoredToken = Object.prototype.hasOwnProperty.call(stored, "ageeGatewayToken");
  return {
    gatewayUrl: effectiveGatewayUrl(stored.ageeGatewayUrl, baked.gatewayUrl),
    gatewayToken: String(hasStoredToken ? stored.ageeGatewayToken || "" : baked.gatewayToken || ""),
  };
}

export {
  DEFAULT_GATEWAY_URL,
  LOCAL_GATEWAY_URL,
  getEffectiveGatewayConfig,
  normalizeGatewayUrl,
  seedGatewayConfig,
};
