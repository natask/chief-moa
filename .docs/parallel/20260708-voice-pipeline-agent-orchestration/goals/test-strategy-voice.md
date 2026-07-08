# Goal: test-strategy-voice

Branch: read-only
Worktree: current checkout or assigned read-only workspace

## Goal

Create a concrete verification matrix for the voice pipeline work: deterministic
fixtures, synthetic long-text provider, TTS failure injection, latency metrics,
barge-in, browser and Android playback, and live smoke after promotion.

## Target Files

Read only:

- `gateway/package.json`
- `gateway/scripts/smoke-*.js`
- `gateway/scripts/eval-voice-roundtrip.js`
- `browser_extension/package.json`
- `browser_extension/scripts/smoke-voice.mjs`
- `android_app/app/src/test/java/ai/moa/assistant/*`
- `reference/openspec/changes/streaming-cascaded-voice/tasks.md`

## Acceptance Criteria

- List the exact commands that should gate each surface.
- Identify missing deterministic tests that must be added before deployment.
- Separate cheap default checks from live/provider-cost checks.
- Include what evidence should be recorded for agents to debug failures.

## Do Not Touch

No file edits.

