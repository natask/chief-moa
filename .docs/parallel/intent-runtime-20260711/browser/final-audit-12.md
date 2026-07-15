# Browser draft controls final audit 12

## Disposition

`BLOCK`.

The `final-audit-10.md` provisional-resource, cleanup-retry, worker-restart,
and Chrome-floor repairs reproduce against the shipped files. The complete
focused suite, static verifier, and real Chrome smoke are green. A fresh
authority/lifecycle/resource pass found three release blockers outside those
regressions: a same-tab navigation can strand an admitted draft microphone,
a resumed draft can be sent to a newly switched branch before the client
rejects the mismatch, and pending microphone starts have no hard admission
bound even though their status projection truncates at 64.

## Blocker 1: same-tab navigation can strand a draft microphone indefinitely

Fresh draft capture starts before gateway readiness at
`browser_extension/extension/background.js:2824-2845`. After the WebSocket
opens, `completeVoiceSessionSetup()` clears the only setup deadline at
`:2627-2634,3016-3024`. Draft mode also structurally disables silence and
maximum-duration auto-commit at `:2792`.

The only tab-lifecycle cleanup calls `closeTabVoiceSessions()` from
`chrome.tabs.onRemoved` at `:5094-5103`. There is no `pagehide`,
`beforeunload`, `unload`, content-port disconnect, document identity, or
top-level `tabs.onUpdated` navigation cleanup in the shipped content/background
files. A same-tab navigation destroys the old content-script state without
removing the tab, so that handler never runs. The replacement content script
also cannot recover the session: it accepts a `voiceSessionEvent` only when its
new, empty `liveVoiceBySessionId` contains the old ID
(`browser_extension/extension/content.js:4220-4224`).

The resulting background session remains registered with an open socket and an
extension-owned microphone, has no draft auto-SEND (correct), but also has no
remaining terminal deadline. A page-controlled redirect during a confirmed
hold can therefore leave the microphone live until some unrelated tab close,
worker termination, or later ownership change. Page content is untrusted and
must not be able to strand capture this way.

Repair requires a background-owned document/navigation lifecycle authority
(for example, bind a session to the initiating document and close/discard it on
top-level replacement or a verified content-port disconnect), with a best-effort
content `pagehide` signal only as a supplement. The teardown must use the exact
shared offscreen disposer and must never emit `commit_turn`. Test both
navigation-before-ready and navigation-after-ready, and prove that a stale
event from the replaced document cannot close a newer session in the same tab.

## Blocker 2: resume can emit cross-branch `session_start` before failing closed

A stored resume pointer initially supplies `branchForSession` at
`browser_extension/extension/background.js:2855-2856`, but an armed
`new`/`fork`/`incognito` action replaces it with a newly switched branch at
`:2863-2888`. The pre-socket resume gate at `:2898-2904` checks the stored
session against the ticket session but never checks the stored branch against
`voiceDraftExpectedBranchId`.

Consequently the WebSocket sends the old draft ID/revision with the new branch
in `session_start` at `:2976-3002`. Content eventually compares its stored
branch with the returned start branch at
`browser_extension/extension/content.js:2845-2879`, but that happens only after
the background has already emitted `session_start`; it is too late to prevent a
cross-authority resume request from reaching the gateway.

I executed the shipped setup function with a stored pointer on `branch-1`,
`context_action:"new"`, and a successful branch switch to `branch-2`. The
actual wire result was:

```json
{
  "returned_branch": "branch-2",
  "stored_branch": "branch-1",
  "sent_branch": "branch-2",
  "sent_draft_branch": "branch-2",
  "sent_draft_id": "draft-cross-branch",
  "session_start_sent": true
}
```

This violates the exact same-session/branch resume authority and the local
fail-closed boundary. Before socket creation, a resume must either require
`continue` plus the exact stored branch or explicitly reject a context action
that would move the stored draft. A fresh new/fork/incognito turn must create a
new draft rather than attach old draft authority to the new root.

## Blocker 3: pending capture acquisition is unbounded and defeats complete reconciliation

`browser_extension/extension/offscreen.js:14-15` uses unbounded Maps for
pending starts and cleanups. Every `startCapture()` increments a generation,
supersedes older requests, and inserts another pending entry at `:331-371`, but
an older unresolved `getUserMedia()` at `:382-389` cannot be removed or aborted.
There is no admission limit before another acquisition begins.

The 64-record constant bounds only the status response, not ownership. Once the
Maps exceed it, `captureOwnershipStatus()` returns `complete:false` and slices
the records at `:551-568`. Background rejects every such status as incomplete
at `browser_extension/extension/background.js:2274-2286,2317-2325`; and every
new capture waits for this reconciliation at `:2384-2389`.

I executed the complete shipped offscreen file with 65 concurrent starts whose
`getUserMedia()` calls did not settle. It admitted all 65 browser acquisition
operations and produced:

```json
{
  "acquisitions": 65,
  "status_complete": false,
  "reported_pending": 64
}
```

Superseding only marks the old operations; it does not bound or retire a
non-settling acquisition. The status cap therefore turns a resource overflow
into a reconciliation state that cannot enumerate or clean all owners.
Enforce a hard pending-start/cleanup admission bound before calling
`getUserMedia`, make excess starts fail visibly without allocating another
operation, and keep status complete for every admitted owner. Test the exact
limit, limit+1, adversarial resolution order, cleanup retry, and a fresh start
after the bounded backlog retires.

## Confirmed `final-audit-10` repairs and prior invariants

- A stream and AudioContext become provisional generation-owned resources as
  soon as acquired. Stop during a non-settling worklet admission halts the
  track immediately, the bounded admission cannot publish later, and exact
  success waits for no active/pending/cleaning owner.
- A non-settling AudioContext close stops hardware immediately, returns
  `ok:false, cleanupPending:true`, remains status-visible and retryable, and a
  late close permits one exact idempotent retry.
- Runtime-channel stop rejection retains exact in-memory retry-by-ID authority
  and one bounded metadata-only tombstone. Worker-start reconciliation queries
  complete status before and after retiring active/provisional orphan owners;
  incomplete proof cannot clear authority.
- An ordinary active capture self-stops on the first rejected PCM delivery
  after a worker restart.
- Manifest `minimum_chrome_version` is exactly `116`; the capability gate
  requires offscreen creation, `runtime.getContexts`, and worker WebSocket
  support before gateway capability can enable drafts. Real Chrome 143 proved
  those APIs in the loaded worker.
- Numeric zero, whitespace, malformed/partial aliases, stale/string/fractional
  revisions, wrong-turn direct IDs, malformed ready/ACK/terminal authority,
  and mismatched capture stops fail closed in the focused suites.
- Draft auto-SEND remains structurally disabled; draft SEND has exactly eight
  canonical keys; pre-ID release stops/drains before queuing SEND; pointer
  cancellation selects discard and no commit; draft mode never enters LiveKit.
- No provider credential or raw audio is added to the cleanup tombstone/status
  records. Content still holds no gateway/provider credential and performs no
  direct provider call.

## Verification and audit probes

- `cd browser_extension && npm run verify`: passed. All five focused voice
  suites passed, the seven sampler lifecycle tests passed, and static extension
  verification completed.
- `cd browser_extension && npm run smoke`: passed against the real unpacked
  extension in headless Chrome for Testing 143; no window was shown and no
  focus was taken.
- Tracked and per-untracked-file whitespace checks: passed.
- Shipped-function probes for the cross-branch resume and 65-start acquisition
  cases produced the JSON above. The temporary probe additions were removed,
  and the two affected focused suites passed again afterward.

This audit changed only this note. It did not edit production/test behavior,
commit, package, reload, merge, preview, or deploy anything.
