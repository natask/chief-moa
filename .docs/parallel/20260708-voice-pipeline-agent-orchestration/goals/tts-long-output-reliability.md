# Goal: tts-long-output-reliability

Branch: read-only
Worktree: current checkout or assigned read-only workspace

## Goal

Audit long assistant text -> TTS behavior. Find current caps, truncation,
chunking, error handling, and whether long outputs can break voice delivery.

## Target Files

Read only:

- `gateway/lib/voice-providers.js`
- `gateway/lib/voice-chunker.js`
- `gateway/lib/voice-session-server.js`
- `gateway/scripts/smoke-cascaded-voice.js`
- `gateway/scripts/test-voice-chunker.js`
- `reference/openspec/changes/streaming-cascaded-voice/*`

## Acceptance Criteria

- Report exact constants/env knobs for text/audio caps.
- Identify current behavior for overlong output and TTS provider failure.
- Propose concrete tests for long story generation, multi-chunk emission,
  partial audio plus text-only degradation, and client-safe `turn_done`.
- Do not implement; produce tickets.

## Do Not Touch

No file edits.

