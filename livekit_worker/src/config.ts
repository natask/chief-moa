// Runtime configuration for the Moa LiveKit agents worker (spike).
//
// All values come from env so the worker holds no secrets in source. LiveKit
// connection creds (LIVEKIT_URL/API_KEY/API_SECRET) are read by the agents
// framework itself; the values below are the Moa-specific wiring.

export interface GatewayConfig {
  /** Base URL of the Moa gateway, e.g. https://api.agee.app */
  url: string;
  /** Bearer token for the gateway's /v1/internal/voice/* hooks. */
  token: string;
}

export interface ChirpConfig {
  projectId: string;
  location: string;
  model: string;
  /** Recognition is pinned to EXACTLY these codes; never auto-detected. */
  languageCodes: string[];
  /** Optional static OAuth access token (skips the ADC/service-account exchange). */
  accessToken: string;
  /** Path to a service-account or authorized_user credentials JSON (ADC). */
  credentialsFile: string;
}

export interface WorkerConfig {
  gateway: GatewayConfig;
  chirp: ChirpConfig;
}

function envString(name: string, fallback = ""): string {
  return String(process.env[name] || "").trim() || fallback;
}

export function loadConfig(): WorkerConfig {
  const url = envString("MOA_GATEWAY_URL") || envString("GATEWAY_URL");
  if (!url) {
    throw new Error("MOA_GATEWAY_URL (or GATEWAY_URL) is required");
  }
  const token = envString("MOA_GATEWAY_TOKEN");
  // Boot-time fallback only. The session-start fetch in resolveSessionChirpConfig
  // below overrides this from the gateway's durable profile when reachable.
  // Languages are always pinned, NEVER auto-detected (see chirp-stt.ts).
  const languageCodes = (envString("MOA_LIVEKIT_LANGS", "en-US"))
    .split(",")
    .map((code) => code.trim())
    .filter(Boolean)
    .slice(0, 2);
  return {
    gateway: { url: url.replace(/\/+$/, ""), token },
    chirp: {
      projectId: envString("GCP_PROJECT_ID") || envString("GOOGLE_CLOUD_PROJECT"),
      location: envString("CHIRP_LOCATION") || envString("GOOGLE_CLOUD_LOCATION", "us"),
      model: envString("CHIRP_MODEL", "chirp_3"),
      languageCodes: languageCodes.length ? languageCodes : ["en-US"],
      accessToken: envString("CHIRP_ACCESS_TOKEN") || envString("GCP_ACCESS_TOKEN"),
      credentialsFile: envString("GOOGLE_APPLICATION_CREDENTIALS") || envString("CHIRP_SERVICE_ACCOUNT_KEY_FILE"),
    },
  };
}

// --- Session-start profile language pinning ---------------------------------
//
// Chirp recognition languages are pinned ONCE per session, at session start,
// from the gateway's durable agent profile (GET /v1/agent/profile) when it is
// reachable. MOA_LIVEKIT_LANGS (loadConfig's languageCodes above) is the
// fallback when the fetch fails, times out, returns a non-2xx status, or the
// profile carries no usable language fields. There is no mid-session
// re-fetch and no auto-detection: whatever this resolves to is what every
// recognize request in the session uses.

const PROFILE_FETCH_TIMEOUT_MS = 3000;
const MAX_SESSION_LANGUAGE_CODES = 2;

interface AgentProfileResponse {
  profile?: {
    input_languages?: string;
    input_language_primary?: string;
  };
}

// Mirrors gateway/lib/voice-providers.js `sttLanguageCodes()`: dedupe the
// configured set, move the primary code to the front when it is present in
// that set, cap at two codes.
export function normalizeSessionLanguageCodes(rawList: string, primary: string): string[] {
  const codes = Array.from(
    new Set(
      String(rawList || "")
        .split(/[,\s]+/)
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  );
  if (!codes.length) {
    return [];
  }
  const primaryLower = String(primary || "").trim().toLowerCase();
  if (primaryLower && codes.length > 1) {
    const index = codes.findIndex((code) => code.toLowerCase() === primaryLower);
    if (index > 0) {
      const [lead] = codes.splice(index, 1);
      codes.unshift(lead as string);
    }
  }
  return codes.slice(0, MAX_SESSION_LANGUAGE_CODES);
}

// One fetch, at session start. Never throws: any failure (network error,
// timeout, non-2xx, empty fields) resolves to `fallback` so a gateway hiccup
// degrades to MOA_LIVEKIT_LANGS instead of failing the session.
export async function fetchSessionLanguageCodes(
  gateway: GatewayConfig,
  fallback: string[],
): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROFILE_FETCH_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {};
    if (gateway.token) {
      headers.Authorization = `Bearer ${gateway.token}`;
    }
    const response = await fetch(`${gateway.url}/v1/agent/profile`, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    if (!response.ok) {
      return fallback;
    }
    const json = (await response.json()) as AgentProfileResponse;
    const profile = json.profile || {};
    const codes = normalizeSessionLanguageCodes(
      String(profile.input_languages || profile.input_language_primary || ""),
      String(profile.input_language_primary || ""),
    );
    return codes.length ? codes : fallback;
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

// Resolves the session's pinned Chirp config: `languageCodes` come from the
// gateway profile when reachable, else the boot-time MOA_LIVEKIT_LANGS
// fallback `loadConfig()` already computed. Call once, at session start
// (livekit_worker/src/agent.ts entry), before constructing the ChirpSTT
// plugin; recognition is pinned for the rest of the session from the result.
export async function resolveSessionChirpConfig(config: WorkerConfig): Promise<ChirpConfig> {
  const languageCodes = await fetchSessionLanguageCodes(config.gateway, config.chirp.languageCodes);
  return { ...config.chirp, languageCodes };
}
