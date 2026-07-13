# Voice Observability Repair Note

Date: 2026-07-10

Target commit: `3c1c553` (`feat(gateway): record voice stage diagnostics`)

## Auditor blockers repaired

- Added additive writer-side attribution for durable context, committed capture,
  and committed websocket transport on streaming voice turns.
- Added a bounded token-protected diagnosis read model:
  `GET /v1/voice/diagnosis?session_id=<id>&turn_id=<id>&limit=<n>`.
- Diagnosis output now attributes capture, transport, context, STT, reasoning,
  TTS, playback, and storage from stored turn JSON, voice-session sidecars,
  archived PCM files, and normalized provider events.
- Diagnosis event output uses an allowlist view and redacts secret-like strings
  from bounded summaries instead of returning raw transcript/tool payloads.
- Added coverage for reasoning fault, TTS fault, storage fault, and the
  anti-gaming case where the gateway must report `unknown` rather than invent a
  root cause.

## Data-safety notes

- The repair is additive. Existing turn JSON, provider ledgers, and archived PCM
  remain readable; no migration or data rewrite is required.
- No deploy was attempted. The diagnosis endpoint is read-only and derives its
  output from already-stored artifacts.

## Verification

- Passed: `cd gateway && node --test test/voice-diagnosis.test.js`
- Passed: `cd gateway && node --test test/syntax.test.js`
- Attempted: `cd gateway && npm run check`
  Result: blocked by the sandbox, not by the repair. The socket-based smoke
  suite and `test/voice-text-turn.test.js` fail at listener startup with
  `listen EPERM: operation not permitted 127.0.0.1`.
