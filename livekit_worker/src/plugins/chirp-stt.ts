// Custom Chirp 3 STT plugin for the Moa LiveKit worker.
//
// The Node @livekit/agents Google plugin has Gemini LLM + beta Gemini TTS but NO
// Google Cloud Speech (Chirp) STT, so this plugin implements Speech-to-Text v2
// against {location}-speech.googleapis.com with the same request shape the
// gateway's lib/voice-providers.js uses: explicit LINEAR16 decoding and
// `languageCodes` pinned from config (primary + at most one alternate). The
// config passed in is resolved once per session by
// config.ts#resolveSessionChirpConfig -- from the gateway's durable profile
// when reachable, else MOA_LIVEKIT_LANGS -- and never changes after that.
// Language is NEVER auto-detected.
//
// API-surface delta (documented in README): @livekit/agents' STT base gives a
// streaming SpeechStream, but Speech-to-Text v2 true bidi streamingRecognize is
// gRPC-only. This plugin buffers each VAD-segmented utterance (the framework
// flushes the stream at end-of-speech) and calls the batch `:recognize` REST
// endpoint — the gateway's proven request shape — then emits one FINAL_TRANSCRIPT
// per segment. Swapping in bidi streamingRecognize is the follow-up.

import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AudioFrame } from "@livekit/rtc-node";
import { stt, type AudioBuffer, type LanguageCode } from "@livekit/agents";
import type { ChirpConfig } from "../config.js";

interface CachedToken {
  value: string;
  expiresAt: number;
}

export class ChirpSTT extends stt.STT {
  label = "moa.ChirpSTT";
  #config: ChirpConfig;
  #token: CachedToken = { value: "", expiresAt: 0 };

  constructor(config: ChirpConfig) {
    super({ streaming: true, interimResults: false });
    this.#config = config;
  }

  override get model(): string {
    return this.#config.model;
  }

  override get provider(): string {
    return "google-chirp";
  }

  get config(): ChirpConfig {
    return this.#config;
  }

  // Non-streaming single-shot recognize (used by STT.recognize()).
  protected async _recognize(frame: AudioBuffer): Promise<stt.SpeechEvent> {
    const frames = Array.isArray(frame) ? frame : [frame];
    return this.recognizeFrames(frames as AudioFrame[]);
  }

  stream(): stt.SpeechStream {
    return new ChirpSpeechStream(this);
  }

  // Shared recognize path: concat PCM16, pin languages, call Speech v2 batch
  // recognize, and return a FINAL_TRANSCRIPT event.
  async recognizeFrames(frames: AudioFrame[]): Promise<stt.SpeechEvent> {
    if (frames.length === 0) {
      return { type: stt.SpeechEventType.FINAL_TRANSCRIPT, alternatives: [emptyAlternative(this.#config.languageCodes[0])] };
    }
    const sampleRate = frames[0]!.sampleRate;
    const channels = frames[0]!.channels;
    const pcm = concatPcm16(frames);
    const token = await this.accessToken();
    const endpoint = recognizeEndpoint(this.#config.projectId, this.#config.location);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
    if (this.#config.projectId) {
      headers["x-goog-user-project"] = this.#config.projectId;
    }
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        config: {
          // explicitDecodingConfig fixes the ENCODING so pairing decoding with
          // languageCodes does not demote them to hints (which would re-enable
          // auto-detection). Mirrors lib/voice-providers.js exactly.
          explicitDecodingConfig: {
            encoding: "LINEAR16",
            sampleRateHertz: sampleRate,
            audioChannelCount: channels,
          },
          languageCodes: this.#config.languageCodes,
          model: this.#config.model,
          features: { enableAutomaticPunctuation: true },
        },
        content: pcm.toString("base64"),
      }),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`chirp STT failed (${response.status}): ${text.slice(0, 300)}`);
    }
    const json = (await response.json()) as ChirpRecognizeResponse;
    const { text, language } = extractTranscript(json, this.#config.languageCodes[0] || "en-US");
    return {
      type: stt.SpeechEventType.FINAL_TRANSCRIPT,
      alternatives: [{ language: asLanguageCode(language), text, startTime: 0, endTime: 0, confidence: 1 }],
    };
  }

  // Google access token: static override, else service-account JWT exchange, else
  // authorized_user refresh — the same three shapes the gateway supports via ADC.
  private async accessToken(): Promise<string> {
    if (this.#config.accessToken) {
      return this.#config.accessToken;
    }
    const now = Date.now();
    if (this.#token.value && this.#token.expiresAt > now + 60_000) {
      return this.#token.value;
    }
    if (!this.#config.credentialsFile) {
      throw new Error("chirp STT needs CHIRP_ACCESS_TOKEN or GOOGLE_APPLICATION_CREDENTIALS");
    }
    const raw = readFileSync(this.#config.credentialsFile, "utf8");
    const cred = JSON.parse(raw) as GoogleCredential;
    const token = cred.type === "authorized_user"
      ? await authorizedUserToken(cred)
      : await serviceAccountToken(cred);
    this.#token = token;
    return token.value;
  }
}

class ChirpSpeechStream extends stt.SpeechStream {
  label = "moa.ChirpSpeechStream";
  #stt: ChirpSTT;

  constructor(sttImpl: ChirpSTT) {
    super(sttImpl);
    this.#stt = sttImpl;
  }

  protected async run(): Promise<void> {
    let buffer: AudioFrame[] = [];
    const flush = async () => {
      if (buffer.length === 0) {
        return;
      }
      const frames = buffer;
      buffer = [];
      this.queue.put({ type: stt.SpeechEventType.START_OF_SPEECH });
      const event = await this.#stt.recognizeFrames(frames);
      this.queue.put(event);
      this.queue.put({ type: stt.SpeechEventType.END_OF_SPEECH });
    };
    for await (const data of this.input) {
      if (typeof data === "symbol") {
        // FLUSH_SENTINEL: the framework ended this utterance (VAD end-of-speech).
        await flush();
        continue;
      }
      buffer.push(data);
    }
    await flush();
  }
}

// --- Speech v2 helpers -----------------------------------------------------

function recognizeEndpoint(projectId: string, location: string): string {
  const host = location === "global" ? "speech.googleapis.com" : `${location}-speech.googleapis.com`;
  return `https://${host}/v2/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(location)}/recognizers/_:recognize`;
}

interface ChirpRecognizeResponse {
  results?: Array<{
    alternatives?: Array<{ transcript?: string; confidence?: number }>;
    languageCode?: string;
  }>;
}

function extractTranscript(json: ChirpRecognizeResponse, fallbackLanguage: string): { text: string; language: string } {
  const parts: string[] = [];
  let language = fallbackLanguage;
  for (const result of json.results || []) {
    const alt = result.alternatives?.[0];
    if (alt?.transcript) {
      parts.push(alt.transcript);
    }
    if (result.languageCode) {
      language = result.languageCode;
    }
  }
  return { text: parts.join(" ").trim(), language };
}

function emptyAlternative(language = "en-US"): stt.SpeechData {
  return { language: asLanguageCode(language), text: "", startTime: 0, endTime: 0, confidence: 0 };
}

// The framework brands language codes nominally; recognition results are plain
// strings, so cast at the boundary.
function asLanguageCode(code: string): LanguageCode {
  return code as unknown as LanguageCode;
}

function concatPcm16(frames: AudioFrame[]): Buffer {
  let samples = 0;
  for (const frame of frames) {
    samples += frame.data.length;
  }
  const out = Buffer.alloc(samples * 2);
  let offset = 0;
  for (const frame of frames) {
    for (let i = 0; i < frame.data.length; i += 1) {
      out.writeInt16LE(frame.data[i]!, offset);
      offset += 2;
    }
  }
  return out;
}

// --- Google OAuth (ADC) exchange -------------------------------------------

interface GoogleCredential {
  type?: string;
  client_email?: string;
  private_key?: string;
  token_uri?: string;
  client_id?: string;
  client_secret?: string;
  refresh_token?: string;
}

async function serviceAccountToken(cred: GoogleCredential): Promise<CachedToken> {
  if (!cred.client_email || !cred.private_key) {
    throw new Error("service_account credential is missing client_email/private_key");
  }
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64Url(JSON.stringify({
    iss: cred.client_email,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: cred.token_uri || "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  const signature = base64Url(signer.sign(cred.private_key));
  const assertion = `${header}.${claims}.${signature}`;
  const response = await fetch(cred.token_uri || "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }).toString(),
  });
  return parseTokenResponse(response);
}

async function authorizedUserToken(cred: GoogleCredential): Promise<CachedToken> {
  if (!cred.client_id || !cred.client_secret || !cred.refresh_token) {
    throw new Error("authorized_user credential is missing client_id/client_secret/refresh_token");
  }
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: cred.client_id,
      client_secret: cred.client_secret,
      refresh_token: cred.refresh_token,
    }).toString(),
  });
  return parseTokenResponse(response);
}

async function parseTokenResponse(response: Response): Promise<CachedToken> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`google token exchange failed (${response.status}): ${text.slice(0, 200)}`);
  }
  const json = JSON.parse(text) as { access_token?: string; expires_in?: number };
  if (!json.access_token) {
    throw new Error("google token exchange returned no access_token");
  }
  return {
    value: json.access_token,
    expiresAt: Date.now() + (json.expires_in ? json.expires_in * 1000 : 3600_000),
  };
}

function base64Url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
