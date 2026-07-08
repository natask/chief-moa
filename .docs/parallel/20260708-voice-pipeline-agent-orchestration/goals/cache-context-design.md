# Goal: cache-context-design

Branch: read-only
Worktree: current checkout or assigned read-only workspace

## Goal

Turn the user's cache-friendly agent-launcher idea into a precise system design:
stable system prompt, volatile per-turn context wrapped with the user message,
surface-specific skill/tool info after the user message, and summarized prior
assistant output where appropriate.

## Target Files

Read only:

- `gateway/lib/context-decision.js`
- `gateway/lib/thread-store.js`
- `gateway/lib/surface-skills.js`
- `gateway/lib/voice-router.js`
- `gateway/lib/browser-agent-loop.js`
- `gateway/agent-launcher-profiles.json`
- `reference/openspec/changes/per-surface-agent-skills/*`
- `reference/openspec/changes/message-broker-session-router/*`

## Acceptance Criteria

- Report whether current code puts volatile context in system prompts or in
  per-turn messages.
- Propose concrete message-shaping rules that preserve prompt cacheability.
- Identify which routes should carry surface skills and timestamp/context blocks
  as per-turn context.
- Include implementation tickets and verification commands.

## Do Not Touch

No file edits.

