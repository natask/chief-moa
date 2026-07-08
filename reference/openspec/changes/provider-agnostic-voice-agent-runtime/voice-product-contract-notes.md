# Voice Product Contract Notes

Source: worker task on 2026-07-08 to persist the user's product direction as
OpenSpec/workflow artifacts.

## Raw Direction

The voice product should feel like a reliable always-available assistant, not a
demo bound to one realtime provider. A successful turn is not just "the model
answered"; it is diagnosable, replayable, interruptible, and recoverable across
phone and browser surfaces.

## Success Criteria

- Diagnosable voice failures: every failed or degraded turn identifies the
  failing phase when possible: capture, transport, STT, reasoning, TTS,
  playback, storage, context assembly, or comparison.
- Self-hostable logs: the gateway stores enough normalized events, turn records,
  provider events, and artifact refs in the self-hosted data store to debug a
  failure without depending on a provider console.
- Long-response audio reliability: long replies stream as ordered audio
  segments, record segment counts and TTS errors, and degrade to visible text
  instead of hanging or silently ending.
- Below-perceived-wait first audio: every streamed voice turn records
  `first_audio_ms` from turn commit or final STT to first assistant PCM, and QA
  gates the value against a configured launch profile budget.
- Continuous partial STT: speaking surfaces show provider-normalized partial
  transcripts continuously before the final transcript, with final transcript
  replacement and storage remaining canonical.
- Interrupt context preservation: if the user interrupts, cancels, or drops a
  turn mid-response, the gateway stores the partial user/assistant content and
  includes it in the next turn's Moa-owned context pack.
- Configurable profiles and modes: voice behavior is selected by versioned
  profile state and named mode overlays, not hidden environment-only behavior.
- Voice demonstration: a repeatable phone/browser demo proves partial STT,
  first audio, long response playback, interruption, mode/profile switching,
  and failure diagnosis.
- Voice-first gestures: Android orb and browser mark can run a flag-gated
  voice-first control contract while preserving drag/resize and default
  gesture compatibility.
- Browser shortcuts: keyboard shortcuts must mirror the browser mark contract
  for text intent and voice capture/commit.
- Cache-friendly per-turn context: each turn assembles a bounded context pack
  from stable ids, profile version, summaries, and artifact refs with a cache
  key suitable for retries, routing, and provider restarts.

## Boundary Reminder

Gateway owns provider credentials, routing, logs, turn records, replay evidence,
profile state, context packs, and agent-run storage. Android owns phone UI,
voice capture/playback controls, permissions, approvals, local actions, and
receipts. The browser extension owns browser-local UI, shortcuts, microphone
capture, playback, page context, and local page actions. Model output remains a
proposal until a local client validates and executes it.
