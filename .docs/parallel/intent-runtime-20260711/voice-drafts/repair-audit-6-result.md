# Voice Draft Store Repair — Audit 6 Result

## Disposition

`PASS — READY FOR FRESH INDEPENDENT AUDIT`

Every blocker in `final-audit-5.md` and `repair-audit-6.md` has a focused
implementation and an exported-API/restart regression. No commit, merge,
gateway integration, deployment, or live-data operation was performed.

## Implemented Repairs

### Exact logical and physical schemas

- Stored v2 drafts are reconstructed from exact known fields rather than
  spreading arbitrary persisted metadata (`gateway/lib/voice-drafts.js:1402`).
  Exact checks cover the top-level draft, create/capture authority, audio,
  segment/append request, append journal and boundaries, transition entry /
  request / receipt / actor, claim, sent request/receipt, send-ready receipt,
  park/discard/recovery receipts, cleanup marker, tombstone, and expired replay
  record (`gateway/lib/voice-drafts.js:3828`).
- Startup uses a no-mutation first phase (`gateway/lib/voice-drafts.js:790`): it
  validates every metadata record, append journal, exact create authority, and
  physical shape before removing any recognized crash temp. Duplicate create
  idempotency authority fails before an unrelated record is changed.
- Draft directories use state-specific file allowlists
  (`gateway/lib/voice-drafts.js:4071`). Clean terminal and expired records may
  contain only `meta.json` plus a valid, bounded, exact operation lock while it
  is actually in use. Unknown files, directories, symlinks, oversized/forged
  locks, misplaced journals, and content resurrection fail visibly.
- Cleanup validates the current exact metadata and physical directory before
  deleting content, then rereads exact authority before finalizing
  (`gateway/lib/voice-drafts.js:1172`). Unknown metadata or files injected after
  the cleanup marker are preserved; the store does not overwrite them or claim
  a content-free terminal result.

### Durable compacted replay authority

- Full content-free sent/discarded records remain bounded by
  `maxTerminalDrafts`. Older full records are atomically replaced in the same
  `meta.json` with a minimal, exact `voice_draft_expired_replay` outcome
  (`gateway/lib/voice-drafts.js:1725,1797`). It contains no transcript, segment,
  audio path, audio counters, or content file.
- The expired outcome preserves the canonical create request, terminal request
  and receipt, bounded action-key hashes, original draft ID/state, and expiry
  time. Exact create retries return deterministic 410
  `voice_draft_replay_expired`; mutations by the compacted draft ID return the
  same inspectable outcome. They never allocate or execute a new draft.
- Valid absent mutations now return 404 before attempting a filesystem lock.
  Status reports full and expired replay counts plus their distinct semantics
  (`gateway/lib/voice-drafts.js:713-720`).
- Duplicate create keys are rejected both during restart preflight and during a
  create call against an already-open store; directory ordering cannot select
  an arbitrary winner.

### Digest-safe audio consumption

- `readAudio()` binds its handle to the original store/draft directory and PCM
  inode. `readBuffer()` and `createReadStream()` both materialize the same
  bounded immutable snapshot, validate its size and SHA-256, and revalidate the
  path/directory/inode before returning (`gateway/lib/voice-drafts.js:541-581,
  4274`).
- `createReadStream()` now returns a stream over the already-verified snapshot;
  it cannot emit a byte before verification completes. Same-size content
  changes, inode replacement, directory replacement, and cleanup during
  snapshot construction fail synchronously. A stream returned before a later
  cleanup remains a valid immutable snapshot, preserving the documented
  snapshot lifetime.

### Exact replay and sent timestamp authority

- Transition-history hashes must be unique, request revisions must increase,
  and receipt state chains must be coherent
  (`gateway/lib/voice-drafts.js:2524-2567`). Mark-sent history requests use the
  complete exact sent-request schema instead of a partial validator.
- Sent request, terminal history, public receipt, claim, claim request, and
  final draft revision are cross-bound exactly
  (`gateway/lib/voice-drafts.js:3718-3751`). A forged revision or turn cannot
  become the replay winner after restart.
- Explicit `sent_at` must already be a canonical string timestamp. Numbers,
  objects, arrays, booleans, null, malformed strings, and parseable but
  noncanonical strings fail before state/content mutation
  (`gateway/lib/voice-drafts.js:2874-2887`).

## Adversarial Regression Evidence

The focused suite now has 47 tests. New audit-6 groups prove:

- unknown fields at draft, create, capture lease, audio, segment, append
  request, transition entry/request/receipt/actor, claim, sent, send-ready,
  tombstone, park, recovery, discard, cleanup, journal, and expired-marker
  levels fail without rewrite;
- schema corruption preserves recognized crash-temp evidence, and duplicate
  create authority is detected before another record's temp is removed;
- unexpected regular files, symlinks, directories, forged/oversized lock
  scaffolding, post-marker files, and post-marker metadata corruption fail
  before a false cleanup result while evidence remains;
- `maxDrafts: 1, maxTerminalDrafts: 1` compacts the actual oldest record, and
  its create/action retries return the same expired outcome before and after
  restart with no new draft ID and no 500;
- expired markers contain no transcript or `audio.pcm` and enforce their own
  exact schema;
- same-size PCM mutation, inode replacement, draft-directory replacement, and
  cleanup races make both audio consumption methods fail before unverified
  output, while a verified snapshot survives later cleanup;
- duplicate/reordered history, non-monotonic revisions, sent/history/claim /
  receipt/revision disagreements, and forged turn authority fail across
  restart without rewriting metadata; and
- malformed `sent_at` values leave the complete store tree unchanged.

The original real-child lease, stale-owner, journal crash, cleanup retry,
privacy, quotas, strict numeric inputs, create/sent idempotency, authority,
symlink, and lower-configured-limit regressions remain green.

## Verification

Final isolated gate:

```text
node --check gateway/lib/voice-drafts.js
node --check gateway/test/voice-drafts.test.js
node --check gateway/scripts/smoke-voice-drafts.js
node --test gateway/test/voice-drafts.test.js
  47 tests, 47 pass, 0 fail
node gateway/scripts/smoke-voice-drafts.js
  smoke-voice-drafts: ok
git diff --check
git diff --no-index --check /dev/null <every untracked slice file>
```

All syntax, focused, deterministic smoke, tracked whitespace, and per-untracked
whitespace checks passed. The implementation imports only Node built-ins
(`crypto`, `fs`, `path`, `stream`, and `util`) and contains no provider, model,
tool, network, STT, LLM, or TTS dependency.

The full gateway gate is intentionally left to the integrated tree as required
by the repair contract. This old-base slice worktree has no installed gateway
runtime dependencies; the prior audit attempt failed on missing `pg`, `ws`,
`@executor-js/sdk`, and `livekit-server-sdk`, while the voice-draft tests inside
that run passed.

## Exact Residual Debt / Integration Gates

1. **Durable expired-index growth.** Each compacted decision becomes one
   content-free, `maxMetadataBytes`-bounded replay outcome. The file fallback
   intentionally does not erase those decisions, so its record count and
   lookup/startup work grow linearly. High-volume integration should move this
   authority to the canonical transaction/event database with its own
   retention/partition/backup policy; deleting a marker would reintroduce the
   duplicate-execution bug.
2. **Compatibility staging.** `voice_draft_expired_replay` is a new persisted
   record kind. Older code fails closed on it but cannot read it. Gateway rollout
   therefore requires new-code-first compatibility, backup/restore evidence,
   and rollback planning before any active store writes an expired marker.
3. **Synchronous bounded snapshots/hashing.** The immutable audio snapshot is
   capped by `maxDraftBytes`, but allocation and hashing are synchronous. Move
   them to a worker or equivalent verified streaming subsystem before
   high-volume request-path use.
4. **Tenant authorization.** The file store remains tenant-neutral. Gateway
   routes must derive tenant/session/branch/release authority from authenticated
   server context and never expose caller-selected cross-tenant IDs.
5. **Portable filesystem race ceiling.** Exact pre/post boundary and inode
   checks close static and ordinary substitution attacks. Hostile same-UID races
   still require native directory-FD (`openat`/`renameat`/`unlinkat`) primitives
   for a stronger guarantee than portable Node provides.
6. **Module size.** Schema, filesystem, replay, lock, and state-machine logic
   remain in one large module. Decomposition is advisable after the contract is
   independently accepted, with this adversarial suite retained unchanged.

Do not commit, merge, integrate, or deploy until a fresh independent auditor
returns `PASS` and the integrated gateway gate is green.
