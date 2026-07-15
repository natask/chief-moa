# Browser draft controls final audit 14

## Disposition

`BLOCK`.

The repair-13 document cleanup and 64-owner admission changes reproduce against
the shipped functions, and the complete focused, static, and real-Chrome gates
are green. A fresh trust/exactness pass found two uncovered release blockers:
the resume branch check derives its alleged expectation from the stored pointer
it is supposed to verify, and a duplicate SEND can recover from a known PCM
delivery failure and commit incomplete audio.

## Blocker 1: the resume branch comparison is tautological

For a `continue` resume, `startVoiceSessionProxyLocked()` initializes
`branchForSession` from the untrusted/stale stored pointer before consulting any
independent branch authority (`browser_extension/extension/background.js:2860`).
It then assigns `voiceDraftExpectedBranchId` from that same value at `:2895-2899`
and compares the stored branch back to it at `:2902-2911`. The comparison at
`:2909` therefore cannot detect a branch mismatch: for a resume it is
`storedBranch !== storedBranch`.

The repair regression does not exercise this case. It tests only `new`, `fork`,
and `incognito`, which are rejected by the earlier context-action check before
setup (`browser_extension/scripts/test-voice-session-lifecycle.mjs:552-572`).
The verifier checks for the presence of the comparison and a test label, not an
independent `continue` mismatch
(`browser_extension/scripts/verify-extension.mjs:609-626`).

I executed the shipped setup helpers and complete shipped setup function with
the same branch representation used by that regression: `cueId:"branch-2"`,
`contextAction:"continue"`, and a parked pointer on `branch-1`. The result was:

```json
{
  "requested_branch_expectation": "branch-2",
  "stored_branch": "branch-1",
  "created_local_sessions": ["probe-local-session"],
  "capture_starts": [],
  "websocket_count": 1,
  "result_branch": "branch-1",
  "session_start_branch": "branch-1",
  "live_session_count": 1
}
```

Thus the mismatched parked resume constructs a WebSocket and emits
`session_start` with the old branch. The absence of microphone allocation is
only because resumed capture waits for ready; it does not make the branch gate
valid.

Repair requires an independently obtained exact expected branch (for example,
a trustworthy ticket/branch lookup or an explicitly carried active-branch
authority) before WebSocket construction. Do not derive both operands from the
parked pointer. If that authority does not exist at this boundary, repair the
cross-surface contract instead of retaining a vacuous comparison. Add an
executable `continue` regression with stored branch 1 and expected branch 2
that proves zero media allocation, zero surviving/local session authority,
zero WebSocket construction, and zero `session_start`.

## Blocker 2: retry after known PCM loss can SEND incomplete audio

Offscreen capture correctly makes the first stop fail after a rejected PCM
delivery. `reportCaptureDeliveryFailure()` records the error and halts hardware
at `browser_extension/extension/offscreen.js:224-235`; exact cleanup retains the
delivery error at `:165-215`; and the stop listener returns
`ok:false, cleanupComplete:true` at `:617-630`.

Background rejects that first strict boundary at
`browser_extension/extension/background.js:2437-2445`. The failure is not
sticky, however. On a duplicate control, offscreen truthfully reports that no
capture is active; background queries complete empty status and upgrades that
not-found response to success at `:2446-2455`. No session field preserves the
known audio-delivery failure. `stopVoiceSessionCaptureAtBoundary()` then clears
capture state (`:3521-3534`) and the duplicate `commit_turn` proceeds to the
wire at `:3592-3599`.

I executed the shipped offscreen boundary and shipped background lifecycle
functions with one rejected PCM delivery followed by the same exact SEND:

```json
{
  "first": { "error": "synthetic PCM delivery loss" },
  "second": {
    "response": {
      "ok": true,
      "voiceSessionId": "voice-loss-retry",
      "queued": false
    }
  },
  "offscreen_stop_calls": 2,
  "status_proof_calls": 1,
  "wire_SEND_count": 1
}
```

The emitted message was the canonical eight-key draft SEND, but its audio was
known to be incomplete. Empty ownership status proves resource retirement; it
cannot repair lost PCM. The focused offscreen regression checks only the first
failure (`browser_extension/scripts/test-offscreen-voice-capture.mjs:125-136`),
so the green gate misses this duplicate boundary.

Repair requires delivery failure to remain sticky for the draft/session across
all SEND retries. A complete no-owner status may prove hardware cleanup and
allow close/discard/reconciliation, but it must never prove audio completeness.
Add a full-offscreen plus shipped-background regression in which rejected PCM
causes every initial and duplicate `commit_turn` to emit zero SEND while exact
resource disposal and later unrelated captures still work.

## Confirmed repair-13 behavior

- Executing the shipped `closeTabVoiceSessions`, `closeVoiceSession`, and shared
  disposer with before-ready and after-ready sessions stopped both exact
  offscreen IDs with `strict:true`, closed each socket once, sent zero socket
  messages, and removed both registrations. A later stale `doc-old` signal
  closed zero sessions and left the `doc-new` replacement and another tab
  untouched.
- The additive content `pagehide` signal is sender-document-bound, while
  background `tabs.onUpdated(status:"loading")` remains the authoritative
  top-level navigation signal
  (`browser_extension/extension/content.js:4251-4258`,
  `browser_extension/extension/background.js:3710-3719,4926-4932,5135-5142`).
- Maliciously forwarded parked pointers with `new`, `fork`, or `incognito` are
  rejected before local session registration, capture, or WebSocket creation;
  the normal content path removes the old pointer and creates a fresh draft.
  Blocker 1 is the distinct `continue` plus independent-branch-mismatch case.
- The complete shipped offscreen runtime admits exactly 64 pending acquisition
  owners. Limit 65 returns a visible capacity error before another
  `getUserMedia`, status reports all 64 with `complete:true`, reverse settlement
  leaves only the newest owner, exact cleanup retires it, and a fresh post-cap
  capture succeeds
  (`browser_extension/extension/offscreen.js:77-86,343-389,569-588`;
  `browser_extension/scripts/test-offscreen-voice-capture.mjs:292-343`).

## Prior invariant ring

- Provisional stream/context ownership, bounded worklet admission and context
  close, cleanup retry/tombstone authority, worker-start reconciliation,
  incomplete-status rejection, and first-PCM restart self-stop remain green.
- Exact protocol grammar, numeric-zero rejection, conflicting aliases,
  integer revisions, top-level/nested ready/ACK/terminal authority, wrong-turn
  direct IDs, pre-ID release ordering, control/setup deadlines, and canonical
  eight-key SEND remain green. Blocker 2 is specifically the missing sticky
  failure across a duplicate SEND.
- Draft auto-SEND remains structurally disabled; pointer cancellation remains
  discard/no-execute; draft mode bypasses LiveKit; admitted gesture/capability
  state remains latched; programmatic dependency order remains correct.
- Manifest version `0.1.31` declares Chrome floor `116`, and the client gate
  requires offscreen creation, `runtime.getContexts`, and worker WebSocket
  support before gateway capability can enable drafts.
- Legacy flag-off behavior and the real extension smoke remain green. No
  provider credential or raw audio was added to status/tombstone metadata.

## Verification and audit probes

- `cd browser_extension && npm run verify`: passed. All five focused voice
  suites, seven sampler lifecycle tests, and static verification passed.
- `cd browser_extension && npm run smoke`: passed against the real unpacked
  extension in headless Chrome for Testing 143; no window was shown and no
  focus was taken.
- `node --check` passed for background, content, offscreen, protocol, and
  gesture source.
- Tracked and per-untracked-file whitespace checks passed after this note was
  written.
- The navigation, branch-mismatch, and retry-after-loss probes executed shipped
  functions in memory and created no persistent probe files.

This audit changed only this note. It did not edit production/test behavior,
commit, merge, package, reload, preview, or deploy anything.
