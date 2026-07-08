# Goal: interrupt-context-memory

Branch: read-only
Worktree: current checkout or assigned read-only workspace

## Goal

Determine how interrupted assistant output is stored and fed into future context
today, then specify how "what the assistant already said" should remain in the
conversation window after the user interrupts and steers.

## Target Files

Read only:

- `gateway/lib/voice-session-server.js`
- `gateway/lib/thread-store.js`
- `gateway/lib/voice-router.js`
- `gateway/lib/context-decision.js`
- `gateway/scripts/smoke-live-interrupt-handoff.js`
- `reference/openspec/changes/provider-agnostic-voice-agent-runtime/*`
- `reference/openspec/changes/context-thread-management/*`

## Acceptance Criteria

- Report what is currently persisted for interrupted turns.
- Identify whether assistant audio/text partials are included in next context.
- Propose a canonical turn summary shape for interrupted output.
- Include tests/smokes needed.

## Do Not Touch

No file edits.

