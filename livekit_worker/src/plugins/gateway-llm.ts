// Gateway-backed LLM plugin for the Moa LiveKit worker.
//
// Instead of calling a model directly, this plugin POSTs the user's transcript
// to the gateway's POST /v1/internal/voice/reason hook, which runs the SAME
// runCascadedVoiceReasoning the cascaded WS pipeline uses (thread handling,
// tool loop, context decision, profile). The gateway stays the single owner of
// reasoning, so a LiveKit turn is byte-identical to a WS turn. The plugin maps
// the reply (speak / tts_text / tts_style / language) into the agents pipeline
// as a single assistant chunk.

import { llm, DEFAULT_API_CONNECT_OPTIONS, type APIConnectOptions } from "@livekit/agents";
import type { ChatContext, ChatChunk } from "@livekit/agents";
import type { GatewayConfig } from "../config.js";
import { randomUUID } from "node:crypto";

// The reason hook returns the reply plus its expressive-TTS split. `lastReply`
// is shared with the TTS plugin so the spoken audio can reuse the gateway's
// tts_text / tts_style / language for this turn.
export interface ReasonReply {
  speak: string;
  ttsText: string;
  ttsStyle: string;
  language: string;
  classification: string;
}

export class GatewayLLM extends llm.LLM {
  #config: GatewayConfig;
  #session: LiveKitTurnState;

  constructor(config: GatewayConfig, session: LiveKitTurnState) {
    super();
    this.#config = config;
    this.#session = session;
  }

  label(): string {
    return "moa.GatewayLLM";
  }

  override get provider(): string {
    return "moa-gateway";
  }

  chat({ chatCtx, connOptions }: {
    chatCtx: ChatContext;
    connOptions?: APIConnectOptions;
  }): llm.LLMStream {
    return new GatewayLLMStream(
      this,
      { chatCtx, connOptions: connOptions || DEFAULT_API_CONNECT_OPTIONS },
      this.#config,
      this.#session,
    );
  }
}

// Shared per-turn state so the TTS plugin can reuse the reason reply's expressive
// fields and the agent can record the turn.
export class LiveKitTurnState {
  sessionId = "";
  branchId = "default";
  deviceId = "";
  turnId = "";
  lastUserTranscript = "";
  lastReply: ReasonReply | null = null;
}

class GatewayLLMStream extends llm.LLMStream {
  #config: GatewayConfig;
  #session: LiveKitTurnState;

  constructor(
    llmImpl: GatewayLLM,
    opts: { chatCtx: ChatContext; connOptions: APIConnectOptions },
    config: GatewayConfig,
    session: LiveKitTurnState,
  ) {
    super(llmImpl, opts);
    this.#config = config;
    this.#session = session;
  }

  protected async run(): Promise<void> {
    const transcript = lastUserText(this.chatCtx);
    this.#session.lastUserTranscript = transcript;
    this.#session.turnId = `turn_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const reply = await this.callReason(transcript);
    this.#session.lastReply = reply;

    const chunk: ChatChunk = {
      id: this.#session.turnId,
      delta: { role: "assistant", content: reply.speak },
    };
    this.queue.put(chunk);
  }

  private async callReason(transcript: string): Promise<ReasonReply> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.#config.token) {
      headers.Authorization = `Bearer ${this.#config.token}`;
    }
    const response = await fetch(`${this.#config.url}/v1/internal/voice/reason`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        transcript,
        session_id: this.#session.sessionId,
        branch_id: this.#session.branchId,
        turn_id: this.#session.turnId,
        device_id: this.#session.deviceId,
        source: "voice-livekit",
      }),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`gateway reason failed (${response.status}): ${text.slice(0, 300)}`);
    }
    const json = (await response.json()) as {
      speak?: string;
      tts_text?: string;
      tts_style?: string;
      language?: string;
      classification?: string;
    };
    const speak = String(json.speak || "").trim();
    return {
      speak,
      ttsText: String(json.tts_text || speak).trim(),
      ttsStyle: String(json.tts_style || "").trim(),
      language: String(json.language || "").trim(),
      classification: String(json.classification || "chat"),
    };
  }
}

// Read the most recent user text from the chat context.
function lastUserText(chatCtx: ChatContext): string {
  const items = chatCtx.items;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item && "role" in item && item.role === "user" && "textContent" in item) {
      const text = (item as { textContent?: string }).textContent;
      if (text && text.trim()) {
        return text.trim();
      }
    }
  }
  return "";
}
