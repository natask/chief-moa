# Speech-to-Speech Provider Replay Baseline — 2026-07-31

## Decision

Keep one phone-facing speech-to-speech protocol. Select the backend inside the
gateway. Compare cascaded Chirp/reasoning/TTS, Vertex Live, OpenAI Realtime, and
Grok Voice with the same retained user turns. Treat Claude as a streaming text
reasoner between controlled STT and TTS because Anthropic does not document a
first-party duplex audio API.

Each experiment turn must accept a caller-controlled prompt, ordered input
language hints, an explicit output language or same-as-user policy, and a voice
selection. Provider safety policies still apply, but the gateway must not replace
the caller's requested voice behavior with a provider-specific hard-coded prompt.

OpenAI Realtime and Grok Voice are now registered behind the gateway's existing
native-live session seam. Local fixture sockets prove that both buffer audio
across provider setup, receive the same prompt/language/voice controls, commit
the turn, and return transcript plus streamed client-format PCM without a phone
protocol change. Real provider comparison still requires their credentials.

## Current Transport

The phone and browser stream PCM16 frames to one authenticated gateway
WebSocket. Cascaded STT is streaming. Reasoning returns SSE text deltas. TTS is
currently one HTTPS synthesis response per phrase, so it overlaps phrases with
continued model generation but does not forward provider audio deltas. Native
audio providers use a gateway-to-provider WebSocket, currently one per admitted
turn. The VPS relay adds a network hop, but phrase-level TTS and provider
connection/setup are separate latency sources that must be measured rather than
attributed to the relay without data.

## Retained Corpus Inventory

Read-only inventory on 2026-07-31:

- Production GCS: 1,577 user PCM recordings, 612 assistant PCM recordings, 24
  sessions.
- Local 2026-07-25 VPS backup: 1,354 voice-turn records, 312 user PCM files, and
  113 assistant PCM files.
- After accepting only Android overlay or browser extension turns, excluding
  smoke/probe/e2e sessions, and requiring a transcript plus locally available
  input PCM: 248 replayable turns.
- The first deterministic 40-turn cohort contains 40 local recordings, 38 next
  user turns, and 17 original assistant-audio references.

The generated `moa-voice-replay/v1` manifest remains under ignored `scratch/`.
It records the original transcript, response text, provider, first-audio timing,
assistant-audio reference, and following user turn. Raw audio, transcripts, and
generated manifests must not be committed.

## Initial Vertex Live Trial

A bounded replay against `gemini-live-2.5-flash-native-audio` used an existing
recording rather than synthetic speech:

- Automatic activity detection, 12 seconds: input transcription succeeded, but
  no assistant audio arrived.
- Manual activity boundaries, 5 seconds: no assistant audio arrived before the
  60-second timeout.

This is a failed experiment, not evidence that Vertex is inherently slower or
unusable. It shows that the current bulk-replay turn boundary does not yet
produce a reliable native-audio response. Do not choose Vertex from this trial.

OpenAI and Grok paid replay runs remain blocked until their credential names are
configured in the invoking environment. Claude audio replay is inapplicable;
its bounded SSE runner compares Claude as the reasoning leg while STT and TTS
remain fixed. It defaults to the current low-latency `claude-haiku-4-5` model
and accepts `VOICE_EXPERIMENT_ANTHROPIC_MODEL` for model comparisons.

## Local Commands

Build a private corpus from an extracted backup data directory:

```sh
cd gateway
VOICE_REPLAY_MAX_SAMPLES=40 npm run eval:voice:corpus -- /path/to/data /path/to/private-corpus.json
```

Run a bounded provider replay with an arbitrary voice prompt:

```sh
VOICE_EXPERIMENT_PROMPT='Your prompt' \
VOICE_EXPERIMENT_INPUT_LANGUAGES='en-US,am-ET' \
VOICE_EXPERIMENT_OUTPUT_LANGUAGE='am-ET' \
VOICE_EXPERIMENT_OUTPUT_DIR=/path/to/private-output \
npm run eval:voice:provider -- openai /path/to/private-corpus.json
```

The provider runners never load a default secret file. They use the process
environment unless an explicit secret-file argument is supplied.

## Primary Provider References

- OpenAI Realtime: <https://developers.openai.com/api/docs/guides/realtime>
- Vertex Live API: <https://cloud.google.com/vertex-ai/generative-ai/docs/model-reference/multimodal-live>
- xAI Voice Agent API: <https://docs.x.ai/developers/rest-api-reference/inference/voice>
- Anthropic streaming Messages: <https://platform.claude.com/docs/en/build-with-claude/streaming>
- Anthropic current model IDs: <https://platform.claude.com/docs/en/about-claude/models/overview>
