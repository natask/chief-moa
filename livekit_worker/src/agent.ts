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

import { fileURLToPath } from "node:url";
import {
  cli,
  defineAgent,
  ServerOptions,
  voice,
  type JobContext,
  type JobProcess,
  type VAD,
} from "@livekit/agents";
import { VAD as SileroVAD } from "@livekit/agents-plugin-silero";
import { loadConfig } from "./config.js";
import { ChirpSTT } from "./plugins/chirp-stt.js";
import { GatewayLLM, LiveKitTurnState } from "./plugins/gateway-llm.js";
import { GatewayTTS } from "./plugins/gateway-tts.js";

const AGENT_INSTRUCTIONS =
  "You are A.G., a voice assistant. Reasoning, memory, tools, and the reply " +
  "voice are all owned by the Moa gateway; this session only carries audio.";

export default defineAgent({
  // Load the Silero VAD once per worker process (endpointing turn detection).
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await SileroVAD.load();
  },

  entry: async (ctx: JobContext) => {
    const config = loadConfig();
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

    const session = new voice.AgentSession({
      vad,
      stt: new ChirpSTT(config.chirp),
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
          void recordTurn(config.gateway, state, assistantText).catch((error) => {
            console.error(`livekit turn-record failed: ${describe(error)}`);
          });
        }
      },
    );

    const agent = new voice.Agent({ instructions: AGENT_INSTRUCTIONS });
    await session.start({ agent, room: ctx.room });
  },
});

async function recordTurn(gateway: { url: string; token: string }, state: LiveKitTurnState, assistantText: string): Promise<void> {
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

function parseParticipantMetadata(metadata: string | undefined): ParticipantMetadata {
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
function roomSessionId(roomName: string | undefined): string {
  const name = roomName || "";
  const match = /^moa-(.+)-[^-]+$/.exec(name);
  return match?.[1] || name || "default";
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// `node dist/agent.js start` (or dev) boots the worker; the agents framework
// imports this module's default export inside each job process.
cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
