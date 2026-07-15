# Browser repair audit 9 result

## Disposition

`PASS` — the three `final-audit-8.md` blockers are repaired and ready for a
fresh independent auditor ring.

The repair stayed inside `browser_extension/**` and this browser lane's durable
notes. It did not touch the gateway, Android, active tree, live browser, or
active data; and it did not commit, package, reload, merge, preview, or deploy.

## 1. Rejected returned authority closes the canonical local session once

- `browser_extension/extension/content.js:2480-2499` owns one idempotent
  `returnedSessionDisposalPromise`, canonicalizes only the background-local
  `voiceSessionId`, sends one `voiceSessionClose`, and requires an affirmative
  disposal response.
- `browser_extension/extension/content.js:2823-2879` preserves that local ID
  before validating gateway-facing draft authority. Draft attachment is now
  acknowledged; either validation or attachment failure awaits the exact local
  close before the outer error path retires content state. Malformed gateway
  session/branch/turn fields never reach SEND or discard.
- `browser_extension/scripts/test-voice-session-lifecycle.mjs:825-920`
  executes the shipped content functions with a canonical local ID and
  whitespace-malformed returned session authority. While the mocked close is
  held, start remains unsettled and the state remains owned. After release, it
  proves exactly one close for the local ID, no control message, and no live
  state.

## 2. Every requested pre-admission exit shares one awaited disposer

- `browser_extension/extension/background.js:2424-2490` publishes one
  `disposalPromise` before socket close, unregisters the active authority first,
  clears timers/media/control state, awaits the exact offscreen stop/drain, and
  only then aborts setup and settles callers. The temporary
  `disposingVoiceSessions` entry makes explicit concurrent closes idempotent.
- `browser_extension/extension/background.js:2591-2669` routes
  config/branch/ticket/URL/record-race failures through that disposer.
  `browser_extension/extension/background.js:2676-2812` routes constructor,
  pre-open send, socket error, and socket close failures through the same
  primitive; late callbacks observe `settled`/`disposing` and cannot repeat it.
- `browser_extension/extension/background.js:3342-3349` and
  `browser_extension/extension/background.js:4664-4671` make explicit close
  return and await that same disposal promise before responding.
- `browser_extension/extension/background.js:2176-2226` adds a synchronous
  capture-start reservation. A close arriving while the offscreen document is
  still being created cancels the reservation before any late start message can
  escape.
- `browser_extension/scripts/test-voice-session-lifecycle.mjs:112-170`
  executes the shipped start/stop reservation functions and proves disposal
  before document creation emits neither a start nor an unowned stop, then
  rejects the late start as cancelled and releases the reservation.
- `browser_extension/scripts/test-voice-session-lifecycle.mjs:696-811`
  executes shipped setup/disposal functions for config, branch, ticket, missing
  ticket URL, socket-constructor, pre-open error, pre-open close, and explicit
  close. Each unregisters first, remains unsettled while drain is held, drains
  exactly once, settles once afterward, and ignores late socket callbacks. The
  existing timeout-first/open-first cases remain green.

## 3. Complete offscreen capture ownership is generation-safe

- `browser_extension/extension/offscreen.js:9-12,69-72` establishes a monotonic
  generation, serialized ownership-transition chain, pending-start registry,
  and bounded retired-session receipts.
- `browser_extension/extension/offscreen.js:102-123,166-201` stops hardware
  before draining audio, closes the AudioContext, cancels exact pending starts,
  and returns the retired session plus positive generation.
- `browser_extension/extension/offscreen.js:203-372` lets acquisition happen
  concurrently but admits only the newest uncancelled generation. Every stale,
  cancelled, superseded, or failed acquisition stops all tracks and closes its
  context/worklet resources before that start response settles.
- `browser_extension/scripts/test-offscreen-voice-capture.mjs:85,154-209`
  evaluates the complete shipped `offscreen.js`. Two- and three-start deferred
  acquisitions resolved in adversarial orders leave exactly one live owner;
  superseded responses cannot claim active ownership; the final exact stop
  reports its session/generation and leaves zero live tracks, contexts, or
  worklet ports.
- `browser_extension/scripts/verify-extension.mjs:548-579` binds the static
  verifier to these cleanup primitives and executable race assertions so the
  gates cannot silently fall back to the prior behavior.

## Verification evidence

`cd browser_extension && npm run verify` passed after the final repair:

```text
voice-draft-protocol ok
voice-capture-gesture ok
voice-session-lifecycle ok
offscreen-voice-capture ok
tests 7; pass 7; fail 0
extension verification passed
```

This preserves the prior no-auto-SEND, exact eight-key SEND, strict authority,
wrong-turn, capture ordering/drain, ACK/no-ACK, capability generation, gesture
latching, programmatic dependency ordering, no-LiveKit, bounded backpressure,
and sampler lifecycle coverage.

`cd browser_extension && npm run smoke` passed against the real unpacked
extension in headless Chrome for Testing:

```text
extension smoke passed (REAL extension, headless Chrome for Testing): service worker loaded id=pcijjnjihfnnokelkaeecdifbhmhppon, text shortcut=⌘,, voice shortcut=page-level listener, 5 elements observed via background->content, 149 visible text chars observed, compact overlay checked (540x58), cross-tab owner moved 869995195->869995196 with old tab revoked, type+click executed, demo result "Searched Docs: browser agent", no window shown, no focus taken.
```

The final tracked and per-untracked-file whitespace checks also passed.

## Residual service-worker lifecycle debt

This repair does not make voice sessions durable across an unexpected Manifest
V3 service-worker termination. Session authority, disposer tombstones, capture
start reservations, and setup timers still live only in in-memory maps and are
lost if Chrome kills the worker. The manifest also declares no minimum Chrome
version, while reliable WebSocket-based worker lifetime support begins with
Chrome 116. The tested setup/control deadlines are 10 seconds and the real
Chrome smoke did not reproduce suspension, so this remains explicit recovery
and compatibility debt rather than a repair-9 blocker. A later change should
declare the supported Chrome floor and design persisted/reconciled recovery for
unexpected worker restarts.

## Handoff

No implementation commit or release artifact was created because this repair
lane explicitly forbids commit, package, reload, merge, and deployment. Root
should now assign a fresh independent final auditor before integration.
