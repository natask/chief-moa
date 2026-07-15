# Browser repair audit 11 result

## Disposition

`PASS` — all three `final-audit-10.md` blockers are repaired and ready for a
fresh independent final audit.

The repair stayed inside `browser_extension/**` and this browser lane's durable
notes. It did not touch the gateway, Android, active tree, live browser, or
active data, and it did not commit, package, reload, merge, preview, or deploy.

## 1. Provisional microphone ownership and cleanup are exact and bounded

- `browser_extension/extension/offscreen.js:8-15` defines separate bounded
  worklet-admission, PCM-drain, AudioContext-close, ownership-status, and
  cleanup registries.
- `browser_extension/extension/offscreen.js:153-209` halts tracks and ports
  before bounded drain/context close, retains indeterminate cleanup in
  `pendingCaptureCleanups`, and distinguishes `cleanupPending` from a completed
  resource teardown with an audio-delivery failure.
- `browser_extension/extension/offscreen.js:260-329` marks pending starts
  cancelled, synchronously halts every provisional resource already acquired,
  waits for the bounded start completion, retries addressable cleanup, and
  never returns exact success while cleanup is pending.
- `browser_extension/extension/offscreen.js:331-538` creates the resource
  owner before acquisition, attaches the stream and AudioContext immediately,
  checks cancellation after every await, bounds local worklet admission, and
  prevents a cancelled/superseded generation from publishing later. A newer
  generation also halts any provisional resources its older pending starts
  already own.
- `browser_extension/extension/offscreen.js:551-618` exposes a bounded,
  metadata-only status envelope for active, pending, cleaning, and retired
  ownership. Stop returns `ok:false` for `cleanupPending`; one later exact retry
  can consume the bounded retired receipt idempotently.
- `browser_extension/extension/background.js:2418-2452` rejects both
  indeterminate cleanup and completed PCM-delivery failure at the first strict
  SEND/control boundary. A status proof can compensate only for a plain
  not-found race, never for lost audio or pending cleanup.

The complete shipped-offscreen regression at
`browser_extension/scripts/test-offscreen-voice-capture.mjs:181-232` proves:

- `getUserMedia()` resolves while worklet admission never settles;
- stop immediately halts the provisional track;
- bounded admission retires the context and creates no worklet port;
- the cancelled start cannot publish later;
- exact stop succeeds only after status has no active/pending/cleaning owner;
- a non-settling AudioContext close returns
  `ok:false, cleanupPending:true`, retains retryable status, and succeeds
  idempotently only after the late close actually settles.

The existing exact PCM rejection, two/three concurrent-start, stop-before-
drain, 64-send backpressure, mismatch, and zero-resource-after-final-stop cases
remain green.

## 2. Cleanup retry authority survives failure and worker restart

- `browser_extension/extension/background.js:2216-2259` validates one bounded
  `ageeVoiceCaptureCleanupTombstone` containing only canonical local session ID,
  a 240-character reason, creation time, and bounded attempt count. A retry
  updates that one record rather than appending product history.
- `browser_extension/extension/background.js:2261-2337` validates complete
  offscreen ownership status and refuses incomplete, oversized, or malformed
  proof.
- `browser_extension/extension/background.js:2339-2382` reconciles on worker
  start and before every new capture. It retires active/pending/cleaning owners
  not backed by current in-memory authority, queries status again, and clears
  the tombstone only after the second query proves no orphan remains.
- `browser_extension/extension/background.js:2654-2739` publishes one shared
  disposal promise, persists cleanup authority before unregistering the
  ephemeral session, closes the socket, and attempts strict offscreen cleanup.
  Failure resets only the in-flight promise and retains the session in
  `disposingVoiceSessions`, so exact retry by local ID remains possible.
  Success clears both in-memory and persisted cleanup authority.
- `browser_extension/extension/background.js:1077` starts reconciliation when
  the MV3 worker starts. `startOffscreenVoiceCapture` also reserves ownership
  synchronously before awaiting that gate, preserving the pre-document
  cancellation invariant.

`browser_extension/scripts/test-voice-worker-reconciliation.mjs` executes the
shipped helpers and disposer rather than copies. It proves:

- two runtime-channel stop rejections remain visible, retryable by exact ID,
  and update one tombstone from attempt 1 to 2;
- a third exact retry retires the capture and clears both authorities;
- a simulated fresh worker queries complete status, retires one active and one
  provisional orphan, queries again, and only then clears the tombstone;
- incomplete status fails closed and cannot clear cleanup authority.

`browser_extension/scripts/test-offscreen-voice-capture.mjs:134-152` also
preserves the ordinary restart safety net: an already-active capture stops its
track on the first PCM rejection from a restarted worker with no matching
session and emits the visible offscreen error used by reconciliation.

## 3. Chrome 116 is now an explicit, executable compatibility contract

- `browser_extension/extension/manifest.json:4-5` advances the patch release
  to `0.1.31` and declares `minimum_chrome_version: "116"`.
- `browser_extension/extension/background.js:73,176-200` requires offscreen
  document creation, `runtime.getContexts`, and worker WebSocket support before
  consulting gateway capability. A client missing that floor returns
  `supported:false, client_supported:false`; gateway health cannot compensate.
- Capability cache records are client-bound and carry the minimum version.
- `browser_extension/scripts/test-voice-worker-reconciliation.mjs:42-100`
  executes both sides: a missing required runtime API fails closed without a
  gateway health call, while the Chrome-116 API surface plus gateway capability
  admits drafts.
- Static verification pins the manifest/version/client gate. The real Chrome
  smoke reads the loaded manifest and, inside the actual extension worker,
  asserts Chrome major >=116 plus live offscreen, `getContexts`, and WebSocket
  APIs before continuing.

Raising the manifest floor deliberately prevents this update from being
delivered to older Chrome installations; it is no longer an implicit or
untested compatibility claim.

## Preserved prior invariants

The full gate still proves malformed returned authority gets exactly one
awaited local close and no control, all pre-admission exits share the one
unregister/socket/drain/settle path, pre-document cancellation emits no late
start, draft auto-SEND is structurally disabled, SEND has exactly eight frozen
keys, authority/numeric/revision/wrong-turn input fails closed, pre-ID release
drains before commit, setup/control deadlines and ACK/no-ACK are bounded,
capability generation and admitted gestures remain latched, programmatic
dependencies load in order, draft mode never enters LiveKit, and exact PCM
backpressure remains fail-closed.

## Verification evidence

`cd browser_extension && npm run verify` passed:

```text
voice-draft-protocol ok
voice-capture-gesture ok
voice-session-lifecycle ok
offscreen-voice-capture ok
voice-worker-reconciliation ok
tests 7; pass 7; fail 0
extension verification passed
```

`cd browser_extension && npm run smoke` passed against the real unpacked
extension in Chrome for Testing 143 with the new loaded-worker Chrome-floor
probe:

```text
extension smoke passed (REAL extension, headless Chrome for Testing): service worker loaded id=pcijjnjihfnnokelkaeecdifbhmhppon, text shortcut=⌘,, voice shortcut=page-level listener, 5 elements observed via background->content, 149 visible text chars observed, compact overlay checked (540x58), cross-tab owner moved 1558714612->1558714613 with old tab revoked, type+click executed, demo result "Searched Docs: browser agent", no window shown, no focus taken.
```

Tracked and per-untracked-file whitespace checks passed after this result was
written.

## Residuals

- Canonical draft pointers remain the only persisted product state. WebSocket,
  content UI, and timer state remain intentionally ephemeral; after an
  unexpected worker loss the pointer can resume from the gateway-owned draft.
- A `getUserMedia()` request that never resolves owns no returned stream to
  stop. Its stop response remains visibly indeterminate and its tombstone blocks
  a false exact receipt/new capture until the browser settles the request or
  destroys the offscreen document. Once a stream exists, this repair owns and
  retires it within the fixed worklet/context bounds.
- A stale tombstone may remain if `chrome.storage.local.remove` itself fails
  after exact cleanup. It is one bounded metadata record; the next worker/start
  reconciliation queries offscreen status and clears it after proof. It cannot
  execute a command or become canonical conversation history.

No implementation blocker remains in this repair lane. A different fresh
auditor should rerun the complete trust/resource ring before integration.
