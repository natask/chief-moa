// Moa LiveKit agents worker (flag-gated spike, Option A).
//
// A standalone agents-js worker that joins gateway-minted rooms and drives:
//   Chirp 3 STT  ->  gateway reasoning (/v1/internal/voice/reason)
//                ->  gateway TTS       (/v1/internal/voice/synthesize)
// and records each completed turn through /v1/internal/voice/turn-record. The
// gateway stays the single owner of reasoning, TTS, turn records, threads, and
// the tool loop, so a LiveKit turn is byte-identical to a WS turn.
//
// lk.agent.state is published by AgentSession automatically (thinking/speaking),
// which is one of the two features this spike measures; the other, the client's
// pre-connect audio buffer, lives in the browser client. Turn detection defaults
// to VAD endpointing (am-ET has no turn-detector model, so VAD is the fallback);
// PTT via turnDetection:'manual' + commitUserTurn()/clearUserTurn() is available.

import {
  defineAgent,
  voice,
  type JobContext,
  type JobProcess,
  type VAD,
} from "@livekit/agents";
import { VAD as SileroVAD } from "@livekit/agents-plugin-silero";
import { loadConfig, resolveSessionChirpConfig } from "./config.js";
import { ChirpSTT } from "./plugins/chirp-stt.js";
import { GatewayLLM, LiveKitTurnState } from "./plugins/gateway-llm.js";
import { GatewayTTS } from "./plugins/gateway-tts.js";

const AGENT_INSTRUCTIONS =
  "You are A.G., a voice assistant. Reasoning, memory, tools, and the reply " +
  "voice are all owned by the Moa gateway; this session only carries audio.";

export const workerDefinition = {
  // Load the Silero VAD once per worker process (endpointing turn detection).
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await SileroVAD.load();
  },

  entry: async (ctx: JobContext) => initializeJob(ctx),
};

export interface JobDependencies {
  loadConfig: typeof loadConfig;
  resolveSessionChirpConfig: typeof resolveSessionChirpConfig;
  createSession: (options: ConstructorParameters<typeof voice.AgentSession>[0]) => voice.AgentSession;
  createAgent: (instructions: string) => voice.Agent;
  recordTurn: typeof recordTurn;
  logError: (message: string) => void;
}

const jobDependencies: JobDependencies = {
  loadConfig,
  resolveSessionChirpConfig,
  createSession: (options) => new voice.AgentSession(options),
  createAgent: (instructions) => new voice.Agent({ instructions }),
  recordTurn,
  logError: (message) => console.error(message),
};

export async function initializeJob(ctx: JobContext, deps: JobDependencies = jobDependencies): Promise<void> {
    const config = deps.loadConfig();
    const vad = ctx.proc.userData.vad as VAD;

    await ctx.connect();
    const participant = await ctx.waitForParticipant();

    // The gateway minted the token with session/branch/device metadata, so the
    // worker files LiveKit turns on the same thread as every other surface.
    const state = new LiveKitTurnState();
    const meta = parseParticipantMetadata(participant.metadata);
    state.sessionId = meta.session_id || roomSessionId(ctx.room.name);
    state.branchId = meta.branch_id || "default";
    state.deviceId = meta.device_id || participant.identity || "";

    // Pin Chirp recognition languages from the gateway's durable profile for
    // this session; falls back to MOA_LIVEKIT_LANGS on any fetch problem.
    // One fetch, here, before the ChirpSTT plugin is constructed -- never
    // re-fetched or auto-detected for the rest of the session.
    const chirpConfig = await deps.resolveSessionChirpConfig(config);

    const session = deps.createSession({
      vad,
      stt: new ChirpSTT(chirpConfig),
      llm: new GatewayLLM(config.gateway, state),
      tts: new GatewayTTS(config.gateway, state),
      // Default VAD endpointing; 'manual' + commitUserTurn()/clearUserTurn() is
      // the push-to-talk path and stays available for later.
      turnDetection: "vad",
    });

    // Record each completed turn through the same gateway path the WS pipeline
    // uses, so LiveKit turns are stored identically.
    session.on(
      voice.AgentSessionEventTypes.ConversationItemAdded,
      (ev: voice.ConversationItemAddedEvent) => {
        const item = ev.item;
        if (item && "role" in item && item.role === "assistant" && "textContent" in item) {
          const assistantText = (item as { textContent?: string }).textContent || "";
          void deps.recordTurn(config.gateway, state, assistantText).catch((error) => {
            deps.logError(`livekit turn-record failed: ${describe(error)}`);
          });
        }
      },
    );

    const agent = deps.createAgent(AGENT_INSTRUCTIONS);
    await session.start({ agent, room: ctx.room });
}

export const workerAgent = defineAgent(workerDefinition);

export async function recordTurn(gateway: { url: string; token: string }, state: LiveKitTurnState, assistantText: string): Promise<void> {
  const reply = state.lastReply;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (gateway.token) {
    headers.Authorization = `Bearer ${gateway.token}`;
  }
  await fetch(`${gateway.url}/v1/internal/voice/turn-record`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      session_id: state.sessionId,
      branch_id: state.branchId,
      turn_id: state.turnId,
      device_id: state.deviceId,
      source: "voice-livekit",
      transcript: state.lastUserTranscript,
      transcript_source: "stt",
      assistant_text: assistantText,
      provider: "livekit",
      reply_language: reply?.language || "",
      tts_spoke: Boolean(assistantText),
      modality: "speech",
      status: "completed",
    }),
  });
}

interface ParticipantMetadata {
  session_id?: string;
  branch_id?: string;
  device_id?: string;
  surface?: string;
}

export function parseParticipantMetadata(metadata: string | undefined): ParticipantMetadata {
  if (!metadata) {
    return {};
  }
  try {
    return JSON.parse(metadata) as ParticipantMetadata;
  } catch {
    return {};
  }
}

// Fallback when a participant carries no metadata: derive a session id from the
// room name (rooms are minted as moa-{session}-{branch}).
export function roomSessionId(roomName: string | undefined): string {
  const name = roomName || "";
  const match = /^moa-(.+)-[^-]+$/.exec(name);
  return match?.[1] || name || "default";
}

export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default workerAgent;
