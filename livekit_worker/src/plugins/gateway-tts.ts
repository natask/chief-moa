// Gateway-backed TTS plugin for the Moa LiveKit worker.
//
// Streams reply text to the gateway's POST /v1/internal/voice/synthesize hook,
// which runs the active provider's synthesizeSpeech (Chirp 3 Cloud TTS or
// Gemini TTS) and returns raw PCM16@16k mono. The gateway stays the single owner
// of the TTS leg, so a LiveKit reply sounds identical to a WS reply. When the
// turn's reason reply carried an expressive tts_text / tts_style / language
// (shared via LiveKitTurnState), this plugin forwards those so the spoken audio
// keeps the gateway's expressive direction.

import { AudioFrame } from "@livekit/rtc-node";
import { tts, DEFAULT_API_CONNECT_OPTIONS, type APIConnectOptions } from "@livekit/agents";
import { randomUUID } from "node:crypto";
import type { GatewayConfig } from "../config.js";
import type { LiveKitTurnState } from "./gateway-llm.js";

const SAMPLE_RATE = 16000;
const CHANNELS = 1;
const FRAME_SAMPLES = 1600; // 100 ms frames at 16 kHz.

export class GatewayTTS extends tts.TTS {
  label = "moa.GatewayTTS";
  #config: GatewayConfig;
  #session: LiveKitTurnState;

  constructor(config: GatewayConfig, session: LiveKitTurnState) {
    super(SAMPLE_RATE, CHANNELS, { streaming: true });
    this.#config = config;
    this.#session = session;
  }

  override get provider(): string {
    return "moa-gateway";
  }

  get config(): GatewayConfig {
    return this.#config;
  }

  get session(): LiveKitTurnState {
    return this.#session;
  }

  synthesize(text: string, connOptions?: APIConnectOptions): tts.ChunkedStream {
    return new GatewayChunkedStream(text, this, connOptions || DEFAULT_API_CONNECT_OPTIONS);
  }

  stream(): tts.SynthesizeStream {
    return new GatewaySynthesizeStream(this);
  }
}

class GatewayChunkedStream extends tts.ChunkedStream {
  label = "moa.GatewayChunkedStream";
  #tts: GatewayTTS;

  constructor(text: string, ttsImpl: GatewayTTS, connOptions: APIConnectOptions) {
    super(text, ttsImpl, connOptions);
    this.#tts = ttsImpl;
  }

  protected async run(): Promise<void> {
    const pcm = await synthesizeViaGateway(this.#tts.config, this.#tts.session, this.inputText);
    const requestId = newId();
    const segmentId = newId();
    for (const frame of framePcm(pcm)) {
      this.queue.put({ requestId, segmentId, frame, final: false });
    }
  }
}

class GatewaySynthesizeStream extends tts.SynthesizeStream {
  label = "moa.GatewaySynthesizeStream";
  #tts: GatewayTTS;

  constructor(ttsImpl: GatewayTTS) {
    super(ttsImpl);
    this.#tts = ttsImpl;
  }

  protected async run(): Promise<void> {
    let pending = "";
    const emit = async () => {
      const text = pending.trim();
      pending = "";
      if (!text) {
        return;
      }
      const pcm = await synthesizeViaGateway(this.#tts.config, this.#tts.session, text);
      const requestId = newId();
      const segmentId = newId();
      for (const frame of framePcm(pcm)) {
        this.queue.put({ requestId, segmentId, frame, final: false });
      }
      // A segment boundary is marked with END_OF_STREAM so the pipeline flushes.
      this.queue.put(tts.SynthesizeStream.END_OF_STREAM);
    };
    for await (const chunk of this.input) {
      if (typeof chunk === "symbol") {
        // FLUSH_SENTINEL: synthesize the accumulated segment.
        await emit();
        continue;
      }
      pending += chunk;
    }
    await emit();
  }
}

// POST reply text to the gateway synthesize hook and return raw PCM16@16k mono.
// Prefers the shared reason reply's expressive tts_text / tts_style / language.
export async function synthesizeViaGateway(config: GatewayConfig, session: LiveKitTurnState, text: string): Promise<Buffer> {
  const reply = session.lastReply;
  const body: Record<string, unknown> = { text };
  if (reply && sameCore(reply.speak, text)) {
    if (reply.ttsText) body.tts_text = reply.ttsText;
    if (reply.ttsStyle) body.tts_style = reply.ttsStyle;
    if (reply.language) body.language = reply.language;
  }
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.token) {
    headers.Authorization = `Bearer ${config.token}`;
  }
  const response = await fetch(`${config.url}/v1/internal/voice/synthesize`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`gateway synthesize failed (${response.status}): ${errorText.slice(0, 300)}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

export function sameCore(a: string, b: string): boolean {
  return String(a || "").trim() === String(b || "").trim();
}

// Slice raw PCM16 mono into fixed-size AudioFrames, decoding LINEAR16 LE.
export function* framePcm(pcm: Buffer): Generator<AudioFrame> {
  const totalSamples = Math.floor(pcm.byteLength / 2);
  for (let start = 0; start < totalSamples; start += FRAME_SAMPLES) {
    const count = Math.min(FRAME_SAMPLES, totalSamples - start);
    const data = new Int16Array(count);
    for (let i = 0; i < count; i += 1) {
      data[i] = pcm.readInt16LE((start + i) * 2);
    }
    yield new AudioFrame(data, SAMPLE_RATE, CHANNELS, count);
  }
}

function newId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 16);
}
