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
  // Languages are pinned from config and NEVER auto-detected (see chirp-stt.ts).
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
