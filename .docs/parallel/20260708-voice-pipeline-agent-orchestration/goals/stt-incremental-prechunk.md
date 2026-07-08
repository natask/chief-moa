# Goal: stt-incremental-prechunk

Branch: read-only
Worktree: current checkout or assigned read-only workspace

## Goal

Design the first practical implementation slice for low-latency audio-in:
transcribe long user speech incrementally during capture, keep rolling partial
text, and on commit transcribe only the tail before sending the full transcript
to reasoning.

## Target Files

Read only:

- `gateway/lib/voice-providers.js`
- `gateway/lib/voice-session-server.js`
- `android_app/app/src/main/java/ai/moa/assistant/*Voice*`
- `browser_extension/extension/offscreen.js`
- `browser_extension/extension/background.js`
- `reference/openspec/changes/provider-agnostic-voice-agent-runtime/*`

## Acceptance Criteria

- Explain whether the current Chirp path is streaming or whole-turn.
- Propose a staged design for chunk cadence, overlap, transcript stitching,
  language constraints, no-speech handling, and final-tail reconciliation.
- Identify client/server ownership and exact implementation files.
- Include verification commands and a fixture strategy.

## Do Not Touch

No file edits.

