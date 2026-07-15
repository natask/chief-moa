# S2 Voice Draft Domain Goal

## Goal

Build a resumable `voice_draft` domain distinct from canonical turns and
storage-only audio notes. The store must append ordered audio segments, pause
without execution, park durably, resume after process restart, mark send-ready,
and discard content while retaining a content-free tombstone/receipt.

## Owned paths

- New gateway voice-draft module.
- Focused tests and deterministic smoke for the module.

## Branch and worktree

- Branch: `agent/voice-drafts-20260711`
- Worktree:
  `/Users/natnaelkahssay/projs/chief-moa-worktrees/voice-drafts-20260711`

## Acceptance

- Legal states and transitions are explicit and idempotent.
- Audio segments are ordered, capped, atomically written, and survive restart.
- Pause/park/resume never call STT, LLM, TTS, tools, or voice providers.
- Discard deletes user audio/partial transcript and exposes only a bounded
  content-free receipt.
- A send-ready draft can provide a bounded audio stream/path for the existing
  voice-session pipeline; it does not duplicate provider orchestration.
- Source session, branch, surface, parent intent, and release correlation are
  preserved.

## Verification

`cd gateway && node --test test/voice-drafts.test.js && node scripts/smoke-voice-drafts.js`

## Do not touch

- `gateway/server.js`, `gateway/package.json`, `voice-session-server.js`,
  `audio-notes.js`, surface files, deployment files, or active data.
