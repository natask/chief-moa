# Browser repair audit 7 result

## Disposition

`PASS` — ready for a fresh independent final audit.

All three `final-audit-6.md` blockers are repaired inside the shipped browser
background authority boundary, and regressions execute the extracted production
functions rather than copies. No gateway, Android, active-tree, live-browser,
package, reload, merge, commit, preview, or deployment action was performed.

## 1. Draft auto-commit is structurally disabled

- `browser_extension/extension/background.js:2441` forces
  `autoCommitEnabled` off whenever `draftMode` is true, independent of an
  omitted, false, or true caller value.
- `browser_extension/extension/background.js:3316-3346` adds defense in depth:
  both the scheduler and direct legacy executor reject draft sessions and any
  session not explicitly enabled.
- `browser_extension/scripts/test-voice-session-lifecycle.mjs:1-32,211-235`
  reads and evaluates the shipped background bodies in a VM.
- `browser_extension/scripts/test-voice-session-lifecycle.mjs:421-450` starts
  real extracted draft setup with omitted, false, and true `autoCommit`, then
  proves audio arms no silence/max timer, emits no implicit SEND, and even a
  direct legacy executor invocation emits nothing.

## 2. Draft SEND has exactly eight frozen keys

- `browser_extension/extension/background.js:2827-2853` constructs a fresh
  draft-only object containing exactly `type`, `voice_draft_mode`,
  `voice_draft_id`, `expected_revision`, `idempotency_key`, `session_id`,
  `branch_id`, and `turn_id`. It does not spread or copy caller fields.
- `browser_extension/scripts/test-voice-session-lifecycle.mjs:452-482`
  executes that shipped builder with ordinary, legacy-`reason`, and unknown
  extra/alias inputs and compares `Object.keys` to the exact ordered key set.
- `browser_extension/scripts/smoke-extension.mjs:1202-1211,1266-1317` sends an
  adversarial reason/unknown-extra payload through the real extension and
  asserts the exact eight-key envelope for both initial and resumed commits.

## 3. Draft ticket/socket setup is bounded and race-safe

- `browser_extension/extension/background.js:2325-2396` owns the single
  10,000 ms setup deadline. Timeout marks the session closed, clears pending
  state, unregisters authority, closes the socket, awaits the offscreen
  stop/drain boundary, retires local capture state, and only then rejects the
  setup caller.
- `browser_extension/extension/background.js:2471-2535` arms the deadline
  before fresh capture and races configuration, branch switching, and ticket
  acquisition against it.
- `browser_extension/extension/background.js:2570-2741` races socket admission,
  atomically clears the deadline after the one valid `session_start`, and makes
  timeout-time socket close/error and repeated open callbacks harmless.
- `browser_extension/extension/background.js:3249-3264` also aborts pending
  setup on explicit session close.
- `browser_extension/scripts/test-voice-session-lifecycle.mjs:484-529` proves
  timeout-first ordering: the never-opening socket has one 10,000 ms deadline,
  authority is removed before drain, the caller cannot settle before drain,
  socket callbacks cannot bypass drain, and repeated timeout/late-open calls
  cannot resettle, repeat teardown, or send `session_start`.
- `browser_extension/scripts/test-voice-session-lifecycle.mjs:531-566` proves
  open-first ordering: one valid open clears the deadline, settles once, sends
  one `session_start`, and repeated timer/open callbacks have no effect.

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

This also preserves the prior authority, direct-ID, capture-drain, ACK/no-ACK,
capability-generation, gesture-latching, dependency-order, no-LiveKit,
offscreen-bound, and sampler lifecycle gates.

`cd browser_extension && npm run smoke` passed against the real unpacked
extension in headless Chrome for Testing:

```text
extension smoke passed (REAL extension, headless Chrome for Testing): service worker loaded id=pcijjnjihfnnokelkaeecdifbhmhppon, text shortcut=⌘,, voice shortcut=page-level listener, 5 elements observed via background->content, 149 visible text chars observed, compact overlay checked (540x58), cross-tab owner moved 455147932->455147933 with old tab revoked, type+click executed, demo result "Searched Docs: browser agent", no window shown, no focus taken.
```

`git diff --check -- browser_extension .docs/parallel/intent-runtime-20260711/browser`
and a per-file `git diff --no-index --check /dev/null <untracked-file>` pass
both succeeded again after this note was written.

## Scope and handoff

The repair touched only `browser_extension/**` and this browser lane's durable
notes. It deliberately did not commit, package, reload, merge, or deploy. Real
gateway protocol integration remains a later cross-lane QA responsibility; it
is not part of this isolated old-base browser worktree.
