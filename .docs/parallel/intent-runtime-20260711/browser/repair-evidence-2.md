# Browser Draft Controls Repair Evidence 2

## Candidate disposition

`READY FOR INDEPENDENT AUDIT`. Every blocker in `repair-audit-2.md` has a
corresponding implementation repair and behavioral check. This is not a merge
or release approval; the main orchestrator owns the independent audit and
integration decision.

## Repaired trust boundaries

- Background and content now share one strict draft protocol validator.
  Revisions and expiry values must be JSON safe integers; numeric strings and
  fractional values are rejected.
- `voice_draft_ready` requires exact top-level session, branch, and turn,
  matching nested authority, state `capturing`, exact create/resume action, and
  a strictly newer revision for resume. Invalid readiness closes the socket
  without releasing queued PCM or controls.
- Draft `session_start` emits only `context_action` values `continue`, `new`,
  `fork`, or `incognito`. Create and resume default to `continue`; resume sends
  an integer revision.
- Control ACKs require exact top-level and nested authority, action/state, turn,
  and a strictly newer integer revision. Terminal pointer clearing requires a
  newer authoritative `turn_done` with state exactly `sent` or `discarded`.
- Capability records carry a URL-bound 30-second expiry. Content fails closed
  at pointer-down after expiry and latches immutable feature/capability
  admission for the full hold or tap chord.
- Offscreen capture preserves PCM delivery failure through teardown, bounds
  in-flight sends at 64, times out drain after 2 seconds, halts hardware on
  failure/backpressure, surfaces `offscreenVoiceError`, and returns a truthful
  stop result for missing or mismatched capture authority.

## Behavioral evidence

- `node scripts/test-voice-draft-protocol.mjs`: passed. It covers valid create
  and resume, missing/wrong top-level authority, nested mismatch, wrong state,
  action aliases, stale/same/string/fractional revisions, strict ACKs, exact
  `sent|discarded` terminal states, context values, and expiry boundaries.
- `node scripts/test-voice-capture-gesture.mjs`: passed. It covers immutable
  feature/capability admission plus deterministic tap, direction, unsupported,
  and pointer-cancel behavior.
- `node scripts/test-offscreen-voice-capture.mjs`: passed. It proves stop waits
  for admitted PCM, rejected delivery stops and reports, the 64-send bound is
  fail-closed, and wrong-session/inactive stops return failure.
- `npm run verify`: passed with all three focused tests, all 7 voice-sampler
  lifecycle tests, syntax checks, and `extension verification passed`.
- `npm run smoke`: passed against the real extension in headless Chrome for
  Testing. The smoke includes an actual background invalid-ready rejection
  with PCM/control withheld, canonical create, numeric-string ACK rejection,
  canonical ACK advance, canonical commit, and canonical integer resume with
  `context_action:"continue"` and a newer ready revision.
- `git diff --check`: passed.
- `package.json` and `extension/manifest.json`: parsed successfully as JSON.

The long gesture smoke intentionally refreshes capability between independent
scenarios because its runtime exceeds the real 30-second TTL. Production TTL
or fail-closed admission was not weakened.

## Release state

No commit, package, browser reload, merge, or deployment was performed in this
repair lane.
