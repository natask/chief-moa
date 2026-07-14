# Native-Audio Transcript Sidecar Trial

## Product intent

Use one live microphone capture for two concurrent, gateway-owned consumers:

1. A registry-selected `native_live` implementer receives PCM continuously and
   owns native audio reasoning, tool calls, and spoken audio output.
2. Chirp 3 receives the same PCM continuously and owns the visible partial and
   final user transcript.

The transcript is an observability and durable-history lane. It is not inserted
between the user and the duplex provider, and that provider does not wait for it before
understanding the utterance or deciding whether to propose an action.

```text
phone/browser PCM16
  -> Moa gateway voice session
       -> native_live implementer  -> spoken response + tool proposals
       -> Chirp 3 streaming STT   -> partial/final display transcript
```

## Current native-audio candidates (checked 2026-07-14)

- Gemini Developer API: `gemini-3.1-flash-live-preview`, Google's current
  low-latency audio-to-audio Live model. It supports audio input/output and
  synchronous function calling.
- Gemini Developer API compatibility candidate:
  `gemini-2.5-flash-native-audio-preview-12-2025` while the endpoint remains
  available. The 3.1 model documentation names this as the migration source.
- Vertex AI native-audio alias used by this repository:
  `gemini-live-2.5-flash-native-audio`.
- OpenAI: `gpt-realtime` and the lower-cost `gpt-realtime-mini`, both exposing
  real-time text/audio input and output.
- Amazon Bedrock: Nova 2 Sonic, a bidirectional streaming speech-to-speech
  model with tool use and automatic switching among its supported languages.
- xAI: `grok-voice-latest`, a WebSocket speech-to-speech agent model with
  function/tool calls.
- Self-hosted/open weights: `Qwen3-Omni-30B-A3B-Instruct`, whose Thinker–Talker
  architecture accepts live audio and emits text plus streaming speech. Its
  documented speech-language set does not include Amharic and practical
  low-latency hosting requires substantial GPU resources.

Native audio does not imply Amharic support. Nova 2 Sonic, xAI's documented
voice-language list, and Qwen3-Omni's documented speech input set do not list
Amharic. Every new duplex implementer therefore needs the same stored-audio
Amharic/English/code-switch evaluation before it can become the active profile.

Ordinary Gemini audio-understanding models accept audio and generate text but
are not the real-time duplex path. Gemini TTS models generate audio but do not
consume the live microphone as a conversational audio-to-audio model.

## Interaction signals

Audio is evidence; client controls are authoritative turn signals:

- press/hold or voice-mode arm -> `session_start`;
- release or explicit Send -> `commit_turn`;
- cancel -> `cancel_turn`;
- starting a new turn while the assistant is responding -> interruption and
  barge-in;
- touch, remote-pointer/finger, keyboard, accessibility, and browser controls
  remain client-originated structured events, never phrases inferred from STT.

Model function calls remain proposals. The gateway validates and forwards a
bounded proposal; Android or the browser owns approval and local execution.

## Trial policy

- The feature is off by default and enabled with
  `VOICE_TRANSCRIPT_SIDECAR=chirp` only on a provider implementing the duplex
  live-audio interface.
- The sidecar uses the effective profile input languages and the existing
  Chirp 3 streaming recognizer configuration.
- Chirp partials are the only displayed partials while the sidecar is active;
  the duplex provider's input transcription is retained as a comparison candidate so
  competing partial streams do not flicker in the UI.
- A successful Chirp final becomes the canonical/display transcript. The duplex
  provider input transcript is retained on the turn as the native model's
  comparison candidate.
- If the sidecar is unavailable or fails, the duplex provider's input
  transcript remains the fallback. The speech-to-speech response must not fail
  because transcription failed.
- Cancel, replacement, socket close, or manual interruption aborts both
  provider streams and records the partial turn through the existing incomplete
  turn path.

## Composition interfaces

The provider registry selects small capabilities rather than a model brand:

- duplex audio: open a live turn, consume audio frames, emit audio/tool events,
  commit, and cancel;
- streaming transcription: consume the same audio frames, emit provisional
  transcript events, finalize, and abort;
- reasoning/tool proposal: emit bounded calls through gateway hooks;
- speech synthesis: optional independent text-to-audio capability.

A provider may implement several capabilities (a native audio model normally
implements duplex audio, reasoning, and speech output), and the runtime may
compose it with separate implementations such as Chirp transcription. The
`TranscriptSidecarVoiceProvider` wrapper depends only on those method contracts,
not on Gemini, OpenAI, Amazon, xAI, or Qwen classes.

## Lane split and acceptance checks

### Gateway

Fan out each PCM chunk to the selected duplex provider and the Chirp sidecar;
finalize the sidecar without delaying native-audio reasoning; expose both
selected implementers in health/status metadata.

Acceptance: an in-process fake-provider test observes the same frame in both
consumers, Chirp partial/final events reach the client, and sidecar failure
falls back to the duplex provider's transcription without failing the turn.

### Browser voice

No protocol change. Existing `session_start`, binary PCM, `commit_turn`, and
`cancel_turn` events consume normalized transcript events.

Acceptance: existing browser voice verification remains green; live browser QA
is required before any promotion.

### Android voice/action/accessibility

No protocol or execution-authority change. Gesture/touch controls remain local
signals and action proposals remain approval-gated.

Acceptance: the Android build remains green; phone QA is required before any
promotion.

### Workflow/docs

Record the provider model/version, transcript source, both transcript
candidates, audio artifact reference, interruption outcome, and action proposal
receipt in the voice evidence record.

### Verification/deploy

Run the focused gateway test and `gateway npm run check`. This is a deployable
gateway change, but the active pipeline must not be switched or promoted until
an isolated preview has real duplex-audio plus Chirp credentials, a rollback ref,
voice-turn drain evidence, and live browser/phone smoke results.
