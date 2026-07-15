# Voice reliability timeline MVP

## Goal

Build a pure, bounded Chief Moa data-model layer that joins the gateway's
existing voice-diagnosis evidence with browser or phone observations of audio
receipt and playout. Prove that endpoint evidence can turn the current
server-only "PCM emitted; client playback unknown" result into a narrower,
honest diagnosis.

This slice does not add a route, persist records, alter the live gateway, or
claim that a human heard audio.

## Owned files

- `gateway/lib/voice-reliability-timeline.js`
- `gateway/test/voice-reliability-timeline.test.js`
- `.docs/parallel/intent-runtime-20260711/voice-reliability-mvp/**`

## Branch and worktree

- Branch: `agent/voice-reliability-mvp-20260711`
- Worktree: `/Users/natnaelkahssay/projs/chief-moa-worktrees/voice-reliability-mvp-20260711`

## Acceptance criteria

1. The model accepts only bounded metadata records for a documented, closed set
   of event types and provenance sources.
2. Endpoint input cannot assert server-owned tenant or release authority.
3. Raw audio, transcripts, prompts, model content, tokens, credentials, and
   similarly sensitive payloads are rejected recursively.
4. Existing Chief Moa diagnosis output can be projected into the timeline
   without changing or replacing its canonical source.
5. Endpoint evidence is joined only to the same session and turn.
6. Ordering and duration use monotonic time; cross-clock comparisons remain
   explicitly uncertain unless calibration evidence is supplied.
7. A gateway write without endpoint evidence remains transport/playback
   unknown; endpoint receipt without observed playout attributes the gap to the
   playback boundary; observed playout records only endpoint observation, never
   human perception.
8. Adversarial tests cover malformed authority, oversize input, forbidden
   content, cross-turn injection, authority escalation, clock uncertainty, and
   deterministic bounds.

## Verification

```sh
cd gateway
node --test test/voice-reliability-timeline.test.js
npm run check
git diff --check
```

## Do not touch

- `gateway/server.js` or any route / WebSocket handler
- browser-extension or Android sources
- canonical voice-session, conversation, intent, or draft storage
- the active application tree or live gateway

## Live-app constraints

This slice is pure and has no deployment surface. Later integration must start
in a new isolated worktree and pass the repository's preview, rollback,
compatibility, backup/restore, no-interruption, and smoke gates before any live
promotion.
