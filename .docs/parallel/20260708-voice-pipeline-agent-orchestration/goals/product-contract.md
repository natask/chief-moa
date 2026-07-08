# Goal: product-contract

Branch: `agent/voice-product-contract`
Worktree: `/Users/natnaelkahssay/projs/chief-moa-worktrees/voice-product-contract`

## Goal

Persist the user's product direction as concrete OpenSpec/workflow artifacts so
future agents can implement the voice pipeline work without relying on this chat.

## Target Files

- `reference/openspec/changes/streaming-cascaded-voice/tasks.md`
- `reference/openspec/changes/provider-agnostic-voice-agent-runtime/proposal.md`
- `reference/openspec/changes/provider-agnostic-voice-agent-runtime/design.md`
- `reference/openspec/changes/provider-agnostic-voice-agent-runtime/tasks.md`
- new notes under `reference/openspec/changes/provider-agnostic-voice-agent-runtime/`
  if needed
- `.docs/parallel/20260708-voice-pipeline-agent-orchestration/*`

## Acceptance Criteria

- Capture the user's raw success criteria in concise but concrete language:
  diagnosable voice failures, self-hostable logs, long-response audio
  reliability, below-perceivable first-audio latency, continuous partial STT,
  interrupt context preservation, configurable profiles/modes, voice
  demonstration, voice-first gestures, browser shortcuts, and cache-friendly
  per-turn context.
- Convert those criteria into staged tasks rather than a single vague epic.
- Keep architecture boundaries intact: Android/browser own local UI and actions;
  gateway owns provider credentials, routing, profile storage, and event logs.

## Verification

Inspect changed OpenSpec structure. Run this only if available:

```sh
openspec validate provider-agnostic-voice-agent-runtime --strict
openspec validate streaming-cascaded-voice --strict
```

## Do Not Touch

- Gateway source code.
- Android app source code.
- Browser extension source code.
- `.env` files.

