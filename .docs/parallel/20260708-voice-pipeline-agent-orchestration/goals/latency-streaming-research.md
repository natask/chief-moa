# Goal: latency-streaming-research

Branch: read-only
Worktree: current checkout or assigned read-only workspace

## Goal

Audit the current cascaded voice implementation and existing OpenSpec to identify
the shortest safe path toward imperceptible turn response latency. Be concrete:
name the exact source files, current blockers, and the next implementation
tickets.

## Target Files

Read only:

- `gateway/lib/voice-providers.js`
- `gateway/lib/voice-session-server.js`
- `gateway/lib/voice-chunker.js`
- `gateway/lib/voice-stages.js`
- `gateway/scripts/smoke-cascaded-voice.js`
- `reference/openspec/changes/streaming-cascaded-voice/*`

## Acceptance Criteria

- Report whether streaming LLM/TTS is already implemented or only specified.
- Identify why long text can still break audio in the current code path.
- Explain what is realistic about the user's sub-100 ms first-audio target,
  separating audio capture/endpointer latency, STT latency, reasoning latency,
  and TTS latency.
- Produce a prioritized ticket list with verification commands.

## Verification

Read-only; no command required beyond source inspection. If useful, run:

```sh
cd gateway && node scripts/test-voice-chunker.js
```

## Do Not Touch

No file edits.

