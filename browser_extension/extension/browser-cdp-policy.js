const CDP_PROFILES = Object.freeze({
  semantic: Object.freeze({ domains: new Set(["Page", "DOM", "Accessibility"]), maxCommands: 12, maxOutputChars: 16_000 }),
  automation: Object.freeze({ domains: new Set(["Page", "DOM", "Runtime", "Input", "Accessibility", "Emulation"]), maxCommands: 40, maxOutputChars: 64_000 }),
  debug: Object.freeze({ domains: new Set(["Page", "DOM", "Runtime", "Input", "Accessibility", "Emulation", "Debugger", "Log", "Console", "Performance", "Network", "CSS", "Overlay"]), maxCommands: 80, maxOutputChars: 128_000 }),
});

const DENIED_METHODS = new Set([
  "Network.getAllCookies", "Network.getCookies", "Network.setCookie", "Network.setCookies",
  "Network.deleteCookies", "Network.getCertificate", "Network.getResponseBody", "Network.getRequestPostData",
  "Page.getAppManifest", "Page.getInstallabilityErrors",
]);
const DENIED_DOMAINS = new Set(["Browser", "Target", "Storage", "DOMStorage", "WebAuthn", "Autofill"]);
const SECRET_EXPRESSION = /(?:document\s*\.\s*cookie|localStorage|sessionStorage|indexedDB|cookieStore|password|credential|authorization|chrome\s*\.\s*(?:cookies|passwords))/i;
const SECRET_HOST = /(?:^|\.)(?:accounts\.google\.com|passwords\.google\.com|chrome\.google\.com|1password\.com|lastpass\.com|bitwarden\.com)$/i;
const MAX_PARAMS_CHARS = 32_000;

function normalizeCdpProfile(value) {
  const profile = String(value || "semantic").toLowerCase();
  return Object.hasOwn(CDP_PROFILES, profile) ? profile : "";
}

function classifyCdpMethod(method) {
  const value = String(method || "");
  const separator = value.indexOf(".");
  return separator > 0 ? { domain: value.slice(0, separator), command: value.slice(separator + 1) } : { domain: "", command: "" };
}

function secretHost(url) {
  try { return SECRET_HOST.test(new URL(String(url || "")).hostname); } catch { return true; }
}

function authorizeCdpCommand({ method, params = {}, profile, tabUrl = "", commandIndex = 0 } = {}) {
  const normalizedProfile = normalizeCdpProfile(profile);
  if (!normalizedProfile) return { ok: false, code: "invalid_authority_profile", error: "unknown CDP authority profile" };
  const policy = CDP_PROFILES[normalizedProfile];
  const classified = classifyCdpMethod(method);
  if (!classified.domain || commandIndex >= policy.maxCommands) return { ok: false, code: "command_budget_exceeded", error: "CDP command budget exceeded" };
  if (DENIED_DOMAINS.has(classified.domain) || DENIED_METHODS.has(String(method))) return { ok: false, code: "secret_method_denied", error: "credential, cookie, storage, or browser-wide CDP method denied" };
  if (!policy.domains.has(classified.domain)) return { ok: false, code: "profile_method_denied", error: `CDP method is not granted by ${normalizedProfile} profile` };
  let paramsChars = 0;
  try { paramsChars = JSON.stringify(params).length; } catch { return { ok: false, code: "invalid_params", error: "CDP params must be JSON serializable" }; }
  if (paramsChars > MAX_PARAMS_CHARS) return { ok: false, code: "params_budget_exceeded", error: "CDP command params exceed budget" };
  if (secretHost(tabUrl)) return { ok: false, code: "secret_origin_denied", error: "CDP execution is denied on credential-sensitive origins" };
  if (String(method) === "Page.navigate" && params?.url && secretHost(params.url)) return { ok: false, code: "secret_origin_denied", error: "CDP navigation to credential-sensitive origins is denied" };
  if (String(method) === "Runtime.evaluate" && SECRET_EXPRESSION.test(String(params?.expression || ""))) {
    return { ok: false, code: "secret_expression_denied", error: "Runtime.evaluate may not read credentials, cookies, or browser storage" };
  }
  return { ok: true, profile: normalizedProfile, domain: classified.domain, maxOutputChars: policy.maxOutputChars };
}

function compactCdpOutput(result, maxOutputChars) {
  if (!result || typeof result !== "object") return { value: null, output_chars: 0, truncated: false };
  if (result.data) return { value: { data_bytes: String(result.data).length }, output_chars: 0, truncated: false };
  const value = result.result?.value != null ? result.result.value : result;
  let serialized;
  try { serialized = typeof value === "string" ? value : JSON.stringify(value); } catch { serialized = "[unserializable CDP result]"; }
  const truncated = serialized.length > maxOutputChars;
  return { value: truncated ? serialized.slice(0, maxOutputChars) : value, output_chars: Math.min(serialized.length, maxOutputChars), truncated };
}

export { CDP_PROFILES, authorizeCdpCommand, classifyCdpMethod, compactCdpOutput, normalizeCdpProfile };
