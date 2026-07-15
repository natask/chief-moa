# Browser repair-audit-5 result

## Disposition

`PASS`.

All three final-audit blockers are repaired within `browser_extension/**`, with
the prior voice-draft ordering, gesture, capability-generation, dependency,
offscreen-bound, and no-LiveKit invariants still green.

## Repairs

1. `extension/voice-draft-protocol.js:176-189` now recognizes create-mode
   absence by field role: draft/session/branch identifiers must each be truly
   absent (`undefined`, `null`, or empty string), while only revision may use
   numeric zero as its create sentinel. Numeric zero in any identifier position
   therefore reaches strict normalization and fails closed.
2. `extension/background.js:3040-3060` now canonicalizes and compares
   `message.turn_id` before returning a direct session for every lifecycle
   command. A wrong-turn direct-ID commit, cancel, or discard returns no session,
   before capture stop, state mutation, pending-control creation, media teardown,
   queueing, or socket output.
3. `extension/background.js:2995-3010,3100-3114` now arms the existing bounded
   draft-control deadline as soon as a control is queued, including before
   gateway ready/authority. Missing ACK closes and removes the session. A
   validated terminal discard ACK also closes/removes the session, so the timer
   cannot be cleared into an unattached-session leak.

## Shipped-function regressions

- `scripts/test-voice-draft-protocol.mjs:170-191` executes the exported protocol
  validator and rejects numeric zero independently for draft, session, branch,
  and turn authority while preserving the canonical empty create tuple.
- `scripts/test-voice-session-lifecycle.mjs` extracts and executes the current
  shipped `findVoiceSessionForControl`, `sendVoiceSessionControl`, capture
  boundary, timeout, ACK-finalization, and close functions.
- Wrong-turn direct-ID `commit_turn`, `cancel_turn`, and `discard_turn` are each
  rejected with unchanged committed, capture, pending-control, and queued-media
  state, plus zero stop/clear/queue/send/timer calls.
- A correct-turn pre-ready discard returns queued/awaiting-ACK, owns a 10-second
  timer, and closes/removes the session when the simulated deadline fires with
  no ACK. A validated discard ACK also closes/removes its session.
- `package.json` includes this lifecycle regression in `npm run verify`, and
  `scripts/verify-extension.mjs` requires the test artifact.

## Verification evidence

- `npm run test:voice-draft-protocol`: passed (`voice-draft-protocol ok`).
- `npm run test:voice-session-lifecycle`: passed
  (`voice-session-lifecycle ok`).
- `npm run verify`: passed all four focused voice suites, all seven sampler
  lifecycle tests, and static extension verification.
- `npm run smoke`: passed against the real extension in headless Chrome for
  Testing; the harness reported `no window shown, no focus taken`.
- Tracked `git diff --check` and per-untracked-file whitespace checks: passed.

This repair did not touch gateway, Android, or the active tree and did not
commit, package, reload, merge, preview, or deploy anything.
