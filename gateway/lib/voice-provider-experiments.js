"use strict";

const PROVIDER_EXPERIMENTS = Object.freeze({
  vertex: Object.freeze({
    id: "vertex",
    mode: "native_audio",
    transport: "websocket",
    endpoint: "Vertex LlmBidiService/BidiGenerateContent",
    credentialNames: ["VERTEX_EXPRESS_API_KEY", "VERTEX_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS"],
    projectNames: ["VERTEX_PROJECT", "GOOGLE_CLOUD_PROJECT"],
    inputLanguageControl: "transcript sidecar or provider recognition; native audio is prompt-guided",
    outputLanguageControl: "prompt-guided for native audio; explicit languageCode exists only on non-native Live speech",
    runner: "node scripts/eval-vertex-live-audio.mjs <pcm-file-or-replay-manifest>",
  }),
  openai: Object.freeze({
    id: "openai",
    mode: "native_audio",
    transport: "websocket",
    endpoint: "wss://api.openai.com/v1/realtime",
    credentialNames: ["OPENAI_API_KEY"],
    inputLanguageControl: "Realtime transcription configuration plus explicit session instructions",
    outputLanguageControl: "session instructions; evaluate rather than assume a hard language lock",
    runner: "node scripts/eval-realtime-audio-provider.mjs openai <pcm-directory-or-replay-manifest>",
  }),
  xai: Object.freeze({
    id: "xai",
    mode: "native_audio",
    transport: "websocket",
    endpoint: "wss://api.x.ai/v1/realtime",
    credentialNames: ["XAI_API_KEY"],
    inputLanguageControl: "provider transcription plus explicit session instructions",
    outputLanguageControl: "session instructions; evaluate rather than assume a hard language lock",
    runner: "node scripts/eval-realtime-audio-provider.mjs xai <pcm-directory-or-replay-manifest>",
  }),
  anthropic: Object.freeze({
    id: "anthropic",
    mode: "streaming_text_reasoner",
    transport: "https_sse",
    endpoint: "https://api.anthropic.com/v1/messages",
    credentialNames: ["ANTHROPIC_API_KEY"],
    inputLanguageControl: "owned by the selected STT provider before Claude receives text",
    outputLanguageControl: "explicit system instruction on streamed text before controlled TTS",
    runner: "node scripts/eval-anthropic-voice-reasoner.mjs <replay-manifest>",
    limitation: "No first-party Anthropic duplex audio Live API is publicly documented; use Claude only as the middle reasoning leg.",
  }),
});

function providerExperimentStatus(env = process.env) {
  return Object.values(PROVIDER_EXPERIMENTS).map((entry) => {
    const credentials = entry.credentialNames.filter((name) => Boolean(String(env[name] || "").trim()));
    const projects = (entry.projectNames || []).filter((name) => Boolean(String(env[name] || "").trim()));
    const needsProject = entry.id === "vertex" && !credentials.some((name) => name.includes("API_KEY"));
    return {
      id: entry.id,
      mode: entry.mode,
      transport: entry.transport,
      endpoint: entry.endpoint,
      configured: credentials.length > 0 && (!needsProject || projects.length > 0),
      configured_credential_names: credentials,
      configured_project_names: projects,
      input_language_control: entry.inputLanguageControl,
      output_language_control: entry.outputLanguageControl,
      runner: entry.runner,
      ...(entry.limitation ? { limitation: entry.limitation } : {}),
    };
  });
}

function currentConnectionTopology() {
  return Object.freeze({
    client_to_gateway: {
      transport: "authenticated WebSocket over TLS",
      endpoint: "wss://api.agee.app/v1/voice/sessions",
      input: "PCM16 mono 16 kHz binary frames plus JSON turn controls",
      output: "JSON transcript/control events plus PCM16 binary audio frames",
      lifetime: "one client voice-session socket until client teardown or network failure",
    },
    cascaded_gateway_to_providers: {
      stt: "Chirp streaming gRPC during recording; batch REST only as fallback",
      reasoning: "one HTTPS request with SSE text deltas after commit",
      tts: "one HTTPS synthesis request per text phrase; returned audio is complete per phrase, not provider audio deltas",
    },
    native_audio_gateway_to_provider: {
      transport: "provider WebSocket opened at session_start",
      lifetime: "one admitted voice turn today; closed at completion, cancellation, or failure",
    },
  });
}

function speechToSpeechContract() {
  return Object.freeze({
    client_protocol: "one gateway voice WebSocket and one event/audio-frame schema for every backend",
    turn_input: {
      audio: "PCM16 mono 16 kHz frames",
      prompt: "caller-controlled voice system instruction",
      input_languages: "ordered BCP-47 hints",
      output_language: "explicit BCP-47 target or same-as-user",
      voice: "backend voice id or gateway alias",
    },
    streamed_output: ["transcript_partial", "transcript_final", "assistant_text", "assistant_audio_start", "PCM audio frames", "assistant_audio_done", "turn_done"],
    implementations: ["cascaded", "vertex-live", "openai-realtime", "xai-voice", "claude-reasoning"],
    invariant: "the phone protocol does not change when the gateway selects a different implementation",
  });
}

module.exports = { PROVIDER_EXPERIMENTS, currentConnectionTopology, providerExperimentStatus, speechToSpeechContract };
