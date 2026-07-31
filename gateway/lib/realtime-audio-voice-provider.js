"use strict";

const { WebSocket } = require("ws");

const CLIENT_FORMAT = Object.freeze({ encoding: "pcm16", sample_rate: 16000, channels: 1 });
const PROVIDER_RATE = 24000;

class RealtimeAudioVoiceProvider {
  constructor(options, spec) {
    this.env = options?.env || process.env;
    this.spec = spec;
    this.provider = spec.id;
    this.apiKey = this.env[spec.apiKeyName] || "";
    this.endpoint = this.env[spec.endpointEnv] || spec.endpoint;
    this.model = this.env[spec.modelEnv] || spec.model;
    this.voice = this.env[spec.voiceEnv] || spec.voice;
    this.transcriptionModel = this.env[spec.transcriptionModelEnv] || spec.transcriptionModel;
    this.timeoutMs = boundedNumber(this.env.VOICE_PROVIDER_TIMEOUT_MS, 60_000, 5_000, 120_000);
    this.defaultPrompt = options?.systemPrompt || this.env.SYSTEM_PROMPT
      || "You are in a voice conversation. Answer directly and briefly.";
  }

  configured() {
    return Boolean(this.apiKey);
  }

  status() {
    return {
      provider: this.provider,
      stt_provider: this.provider,
      reasoning_provider: this.provider,
      llm_provider: this.provider,
      tts_provider: this.provider,
      configured: this.configured(),
      model: this.model,
      endpoint: this.endpoint,
      auth: this.apiKey ? `${this.spec.apiKeyName.toLowerCase()}_env` : "missing_api_key",
      pipeline: "native_audio",
      input_audio_format: CLIENT_FORMAT,
      assistant_audio_format: CLIENT_FORMAT,
      runtime_mode: "native_live",
    };
  }

  createLiveTurnSession(turn, hooks) {
    if (!this.configured()) throw new Error(`${this.provider} requires ${this.spec.apiKeyName}`);
    let socket = null;
    let ready = false;
    let closed = false;
    let settled = false;
    let transcript = "";
    let assistantText = "";
    let audioStarted = false;
    let audioDone = false;
    let chain = Promise.resolve();
    const queuedAudio = [];
    let resolveReady;
    let rejectReady;
    const readyPromise = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    readyPromise.catch(() => {});
    let resolveDone;
    let rejectDone;
    const done = new Promise((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    const timeout = setTimeout(() => rejectOnce(new Error(`${this.provider} timed out after ${this.timeoutMs}ms`)), this.timeoutMs);
    timeout.unref();

    const result = () => ({
      provider: this.provider,
      model: this.model,
      transcript: transcript.trim() || String(turn.syntheticText || "").trim(),
      transcript_source: transcript.trim() ? "stt" : (turn.syntheticText ? "text" : "synthetic"),
      assistant_text: assistantText.trim(),
      audio_format: CLIENT_FORMAT,
    });
    const cleanup = () => {
      clearTimeout(timeout);
      closed = true;
      try { socket?.close(1000, "turn complete"); } catch {}
    };
    const resolveOnce = async () => {
      if (settled) return;
      settled = true;
      if (audioStarted && !audioDone) {
        audioDone = true;
        await hooks.onAssistantAudioDone();
      }
      cleanup();
      resolveDone(result());
    };
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectReady(error);
      rejectDone(error);
    };
    const enqueue = (task) => {
      chain = chain.then(task).catch(rejectOnce);
    };
    const send = (event) => {
      if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error(`${this.provider} websocket is not open`);
      socket.send(JSON.stringify(event));
    };
    const flushAudio = () => {
      for (const chunk of queuedAudio.splice(0)) send(audioAppend(resamplePcm16(chunk, 16000, PROVIDER_RATE)));
    };

    socket = new WebSocket(`${this.endpoint}?model=${encodeURIComponent(this.model)}`, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        ...(this.spec.openAiBetaHeader ? { "OpenAI-Beta": "realtime=v1" } : {}),
      },
      maxPayload: 32 * 1024 * 1024,
    });
    socket.on("open", () => send(sessionUpdate(this.spec.shape, this.model, this.voice, this.transcriptionModel, turn, this.defaultPrompt)));
    socket.on("message", (raw) => enqueue(async () => {
      const event = parseEvent(raw);
      if (event.type === "error") throw new Error(event.error?.message || event.message || `${this.provider} error`);
      if (event.type === "session.updated") {
        ready = true;
        flushAudio();
        resolveReady();
        const syntheticText = String(turn.syntheticText || "").trim();
        if (syntheticText) {
          send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: syntheticText }] } });
          send({ type: "response.create" });
        }
        return;
      }
      if (event.type === "conversation.item.input_audio_transcription.delta") {
        transcript += String(event.delta || "");
        await hooks.onTranscriptPartial(transcript);
      } else if (event.type === "conversation.item.input_audio_transcription.updated") {
        transcript = String(event.transcript || event.text || transcript);
        await hooks.onTranscriptPartial(transcript);
      } else if (event.type === "conversation.item.input_audio_transcription.completed") {
        transcript = String(event.transcript || transcript);
        await hooks.onTranscriptFinal(transcript);
      } else if (event.type === "response.output_audio_transcript.delta" || event.type === "response.audio_transcript.delta") {
        assistantText += String(event.delta || "");
        await hooks.onAssistantText(assistantText);
      } else if (event.type === "response.output_audio.delta" || event.type === "response.audio.delta") {
        if (!audioStarted) {
          audioStarted = true;
          await hooks.onAssistantAudioStart(CLIENT_FORMAT);
        }
        const upstream = Buffer.from(String(event.delta || ""), "base64");
        await hooks.sendAudio(resamplePcm16(upstream, PROVIDER_RATE, 16000));
      } else if (event.type === "response.done") {
        const message = event.response?.status_details?.error?.message;
        if (message) throw new Error(message);
        await resolveOnce();
      }
    }));
    socket.on("error", rejectOnce);
    socket.on("unexpected-response", (_request, response) => rejectOnce(new Error(`${this.provider} websocket upgrade failed with HTTP ${response.statusCode}`)));
    socket.on("close", (code, reason) => {
      if (!settled) rejectOnce(new Error(`${this.provider} websocket closed before response.done: ${code} ${String(reason || "")}`));
    });

    return {
      done,
      sendAudio: (chunk) => {
        if (closed || settled) return;
        const value = Buffer.from(chunk);
        enqueue(async () => {
          if (ready) send(audioAppend(resamplePcm16(value, 16000, PROVIDER_RATE)));
          else queuedAudio.push(value);
        });
      },
      sendText: (text) => readyPromise.then(() => enqueue(async () => {
        send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: String(text || "") }] } });
        send({ type: "response.create" });
      })).catch(rejectOnce),
      commit: () => readyPromise.then(() => enqueue(async () => {
        flushAudio();
        send({ type: "input_audio_buffer.commit" });
        send({ type: "response.create" });
      })).catch(rejectOnce),
      cancel: () => rejectOnce(new Error("turn canceled")),
    };
  }
}

function realtimeProviderDefinitions(providerRegistryEntry) {
  return {
    "openai-realtime": providerRegistryEntry({
      id: "openai-realtime",
      label: "OpenAI Realtime",
      capabilities: nativeCapabilities(),
      configured: (env) => Boolean(env.OPENAI_API_KEY),
      create: (options) => new RealtimeAudioVoiceProvider(options, {
        id: "openai-realtime", apiKeyName: "OPENAI_API_KEY",
        endpointEnv: "OPENAI_REALTIME_ENDPOINT", endpoint: "wss://api.openai.com/v1/realtime",
        modelEnv: "OPENAI_REALTIME_MODEL", model: "gpt-realtime-2.1",
        voiceEnv: "OPENAI_REALTIME_VOICE", voice: "marin",
        transcriptionModelEnv: "OPENAI_REALTIME_TRANSCRIPTION_MODEL", transcriptionModel: "gpt-realtime-whisper",
        shape: "openai", openAiBetaHeader: true,
      }),
    }),
    "xai-voice": providerRegistryEntry({
      id: "xai-voice",
      label: "xAI Grok Voice",
      capabilities: nativeCapabilities(),
      configured: (env) => Boolean(env.XAI_API_KEY),
      create: (options) => new RealtimeAudioVoiceProvider(options, {
        id: "xai-voice", apiKeyName: "XAI_API_KEY",
        endpointEnv: "XAI_REALTIME_ENDPOINT", endpoint: "wss://api.x.ai/v1/realtime",
        modelEnv: "XAI_REALTIME_MODEL", model: "grok-voice-latest",
        voiceEnv: "XAI_REALTIME_VOICE", voice: "eve",
        transcriptionModelEnv: "XAI_REALTIME_TRANSCRIPTION_MODEL", transcriptionModel: "grok-transcribe",
        shape: "xai",
      }),
    }),
  };
}

function nativeCapabilities() {
  return {
    duplex_audio: true, barge_in: true, server_vad: true,
    partial_transcripts: true, assistant_audio: true,
    voice_output: true, language_hints: true,
  };
}

function sessionUpdate(shape, model, voice, transcriptionModel, turn, fallbackPrompt) {
  const profile = turn?.effectiveProfile || {};
  const prompt = String(profile.system_prompt || fallbackPrompt).trim();
  const inputLanguages = String(profile.input_languages || profile.input_language_primary || "").trim();
  const outputLanguage = String(profile.language || profile.language_output || "").trim();
  const instructions = [
    prompt,
    inputLanguages ? `The user may speak: ${inputLanguages}.` : "",
    outputLanguage ? `Speak the reply in: ${outputLanguage}.` : "",
    "This is voice mode. Answer directly and keep spoken replies concise unless the user asks for detail.",
  ].filter(Boolean).join("\n\n");
  const input = {
    format: { type: "audio/pcm", rate: PROVIDER_RATE },
    transcription: { model: transcriptionModel },
    turn_detection: null,
  };
  const output = { format: { type: "audio/pcm", rate: PROVIDER_RATE }, voice: String(profile.voice || voice) };
  return { type: "session.update", session: shape === "xai" ? {
    instructions,
    voice: output.voice,
    turn_detection: null,
    tools: [],
    audio: { input, output },
  } : {
    type: "realtime",
    model,
    instructions,
    output_modalities: ["audio"],
    tools: [],
    audio: { input, output },
  } };
}

function audioAppend(chunk) {
  return { type: "input_audio_buffer.append", audio: Buffer.from(chunk).toString("base64") };
}

function parseEvent(raw) {
  try { return JSON.parse(String(raw)); } catch (error) { throw new Error(`realtime provider returned invalid JSON: ${error.message}`); }
}

function resamplePcm16(input, sourceRate, targetRate) {
  const source = Buffer.from(input);
  const count = Math.floor(source.length / 2);
  if (count === 0 || sourceRate === targetRate) return source;
  const targetCount = Math.max(1, Math.round(count * targetRate / sourceRate));
  const output = Buffer.alloc(targetCount * 2);
  for (let index = 0; index < targetCount; index += 1) {
    const position = index * (count - 1) / Math.max(1, targetCount - 1);
    const lower = Math.floor(position);
    const upper = Math.min(count - 1, lower + 1);
    const value = Math.round(source.readInt16LE(lower * 2) * (1 - position + lower)
      + source.readInt16LE(upper * 2) * (position - lower));
    output.writeInt16LE(Math.max(-32768, Math.min(32767, value)), index * 2);
  }
  return output;
}

function boundedNumber(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

module.exports = { RealtimeAudioVoiceProvider, realtimeProviderDefinitions };
