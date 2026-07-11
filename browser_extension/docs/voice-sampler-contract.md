# Browser voice sampler implementation contract

## Objective and non-negotiables

Consume the gateway's `voice_sampler/v1` action in the browser extension and
play its samples sequentially. Each sample uses a new gateway voice session
with a session-only `profile_override.voice`; sampling must never write the
stored agent profile or use provider credentials in the extension.

## Ownership and lane

- Branch: `agent/browser-voice-sampler`
- Worktree: `chief-moa-worktrees/browser-voice-sampler`
- Owned paths: `browser_extension/**` only
- Runtime owner: the extension background worker; the content script only
  receives progress and terminal cues.

## Expected behavior and edge cases

- Accept only `type=voice_sampler`, `version=voice-sampler/v1` actions.
- Bound a plan to 16 entries, voice IDs to 64 safe characters, and sample text
  to 300 characters. Skip malformed entries; reject an empty plan.
- Open and finish exactly one text-only socket per sample before opening the
  next. Do not capture microphone audio.
- Send `profile_override: { voice, response_modality: "speech" }` only in that
  socket's `session_start`, then send one `text_turn` after `session_ready`.
- A user stop, tab close, socket error, or superseding sampler closes the active
  sample and prevents later samples from starting.
- Show bounded progress and an honest terminal error. Never claim that a voice
  played merely because a socket opened.

## Forbidden shortcuts

- No profile endpoint call or storage mutation.
- No parallel samples, client-side provider calls, `eval`, or unvalidated action
  fields.
- No extension reload or active deployment from this lane.

## Quality and resource targets

- One active sampler per tab and one active sample socket per sampler.
- O(n) validation with fixed caps; no retained audio buffers.
- Pure plan validation is directly tested. Static verification must prove the
  session-only override and sequential terminal-event transition.

## Acceptance commands

```sh
cd browser_extension
npm run verify
npm run smoke
node scripts/smoke-voice-sampler.mjs
```

## Audit blockers and escalation

Block if the gateway action lacks a stable version, the socket cannot accept a
session override/text turn, or cancellation cannot prevent the next sample.
Escalate any required gateway or Android change to the parent manager.
