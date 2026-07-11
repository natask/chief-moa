const VERSIONS = new Set([1, 2]);
const KINDS = new Set(["open_url", "open_app", "dial", "browser_task", "page_tweak", "file_export"]);
const APPROVALS = new Set(["confirm", "none", "sensitive"]);
const MODES = new Set(["text", "voice"]);
const SECRET_KEY = /(token|api.?key|private.?key|client.?secret|provider.?secret|authorization|password)$/i;
const SECRET_VALUE = /(bearer\s+\S+|github_pat_|ghp_|sk-[a-z0-9]|[?&]code=)/i;

export function validateAggieProposal(input, expectedSurface) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid envelope");
  scan(input, 0);
  if (!VERSIONS.has(input.version) || input.type !== "action.proposed") throw new Error("unsupported protocol semantics");
  if (!sameSurface(input.surface, expectedSurface)) throw new Error("surface scope mismatch");
  if (!KINDS.has(input.payload?.kind) || !APPROVALS.has(input.payload?.approval_class)) throw new Error("unknown action semantics");
  if (!input.payload.preconditions || Object.keys(input.payload.preconditions).length === 0) throw new Error("missing preconditions");
  return Object.freeze(structuredClone(input));
}

export async function proposalDigest(input) {
  const canonical = stableJson({
    version: input.version, message_id: input.message_id, session_id: input.session_id,
    surface: input.surface, timestamp: input.timestamp, payload: input.payload,
  });
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sameSurface(actual, expected) {
  if (!actual || !expected || actual.id !== expected.id || actual.kind !== "browser" ||
      actual.kind !== expected.kind || !MODES.has(actual.mode) || actual.mode !== expected.mode) return false;
  return Object.hasOwn(actual, "device_id") === Object.hasOwn(expected, "device_id") && actual.device_id === expected.device_id;
}

function scan(value, depth) {
  if (depth > 12) throw new Error("too deep");
  if (typeof value === "number" && (!Number.isFinite(value) || !Number.isSafeInteger(value) && Number.isInteger(value) || Object.is(value, -0))) throw new Error("unsafe number");
  if (typeof value === "string" && SECRET_VALUE.test(value)) throw new Error("credential-shaped value");
  if (Array.isArray(value)) { if (value.length > 64) throw new Error("too wide"); value.forEach((item) => scan(item, depth + 1)); }
  else if (value && typeof value === "object") {
    const entries = Object.entries(value); if (entries.length > 64) throw new Error("too wide");
    for (const [key, item] of entries) { if (SECRET_KEY.test(key.replace(/[^a-z0-9]/gi, ""))) throw new Error("credential authority"); scan(item, depth + 1); }
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
