# Voice Draft Store Repair — Audit 4 Result

## Disposition

`GREEN FOR INDEPENDENT RE-AUDIT`

No commit, merge, integration, or deployment was performed. The implementation
remains an isolated, provider-free store slice and is not wired into the live
gateway or any active recording path.

## Repaired Blockers

1. **Bound draft paths.** Every metadata, journal, PCM, lock, recovery, and
   cleanup operation now validates the store and exact draft directory as
   non-symlink directories. Child opens capture the parent device/inode and
   canonical real path and revalidate that boundary after the open. Atomic
   writes and lazy audio accessors perform the same pre/post validation. A lazy
   handle is also bound to the directory identity that existed when the handle
   was created.
2. **Container and state authority.** Stored draft IDs must equal their exact
   directory IDs. Every v2 record requires its canonical create request and all
   creation authority must agree. Capture leases and park, recovery,
   send-ready, discard, claim, sent, cleanup, and tombstone records use strict
   schemas. State-specific invariants require the matching receipts, history,
   tombstone, cleanup marker, lease posture, and empty logical/physical content.
   Corruption is validated before recovery mutation.
3. **Persisted resource policy.** Metadata and journals are byte-bounded before
   JSON parsing and before atomic writes. Active limits are enforced on stored
   transcript text, segments, transition history, durable action hashes,
   per-segment bytes/duration, per-draft totals, tombstones, journals, and total
   store audio. Arithmetic is safe-integer checked, including reopening a store
   under lower limits.
4. **Bounded terminal replay retention.** `maxDrafts` now limits only mutable or
   in-flight records. Cleaned `sent` and `discarded` records are content-free
   replay records retained separately up to `maxTerminalDrafts`. Only a record
   that has no cleanup marker, transcript, PCM metadata, PCM file, journal,
   temp, or unexpected file is eligible. Excess records retire oldest draft
   creation first; active, parked, send-ready, cleanup-pending, and
   content-bearing records are never selected. `status()` exposes capacity,
   terminal replay count, cap, ordering, and the exact-replay scope.
5. **Strict mutation integers.** Expected revisions, declared byte counts, and
   durations require number-typed safe integers. Numeric strings, fractions,
   unsafe integers, `NaN`, and both infinities fail before content, revision,
   history, lease, claim, sent state, or cleanup changes. Internal revision,
   resume, byte, duration, and store arithmetic also fail before overflow.

## Adversarial Regression Evidence

The focused suite retains the original 29 process, lock, recovery, privacy,
authority, and replay tests and adds five audit-4 regressions:

- a moved draft replaced by an outside directory symlink is rejected by direct
  reads, listing, lazy audio, all mutation seams, restart recovery, and cleanup;
  the outside tree remains byte-for-byte unchanged, and an inode-replaced lazy
  handle also fails;
- directory-ID swaps, missing create authority, forged terminal state,
  mismatched tombstones, and terminal raw-content resurrection fail without
  rewriting or deleting evidence;
- oversized metadata bytes, a 100,000-character transcript, 1,000 action
  hashes, and lower configured segment/history/hash/audio/store limits fail
  deterministically without rewrite;
- `maxDrafts: 1` plus `maxTerminalDrafts: 1` permits discarded and sent
  turnover, preserves exact create/discard/sent replay for the retained record
  across restart, and refuses to prune a live content-bearing draft; and
- invalid integer types across create authority, transition, append, claim,
  and mark-sent leave the complete store tree unchanged.

## Verification

The final gate is:

```text
node --check gateway/lib/voice-drafts.js
node --check gateway/test/voice-drafts.test.js
node --check gateway/scripts/smoke-voice-drafts.js
node --test gateway/test/voice-drafts.test.js
  34 tests, 34 pass, 0 fail
node gateway/scripts/smoke-voice-drafts.js
  smoke-voice-drafts: ok
git diff --check
git diff --no-index --check /dev/null <each untracked slice file>
```

The module imports only Node `crypto`, `fs`, and `path`. Pause, park, resume,
discard, and send preparation do not call STT, LLM, TTS, tools, network APIs, or
voice providers.

## Exact Residual Debt

1. **Portable filesystem race limit.** Node does not expose a portable
   `openat`/`renameat`/`unlinkat` API. The implementation binds parent
   device/inode plus canonical path before and after child operations under
   private 0700 directories, which closes static and ordinary replacement
   attacks. A hostile same-UID process racing between those checks requires a
   native directory-FD helper. Callers must use `readBuffer()` or
   `createReadStream()`; reopening the informational raw `path` later does not
   retain the handle's directory binding.
2. **Finite replay horizon.** Exact create/action replay is guaranteed for the
   configured retained terminal window. Once the oldest content-free replay
   record is intentionally evicted, this local bounded store has no unbounded
   global deny-index. A longer compliance or idempotency horizon requires an
   external durable replay index or a larger explicit cap.
3. **Read snapshot lifetime.** Read helpers do not hold the mutation lock for
   the full stream lifetime. Atomic metadata and size/digest checks make races
   fail closed or return an already-open valid prefix, but an already-open file
   descriptor cannot be revoked by a later discard. The gateway API must define
   retry/snapshot behavior.
4. **Synchronous hashing.** Digest validation is bounded but can be quadratic
   across repeated appends and can block the gateway event loop. High-volume
   integration should use a worker or verified streaming digest design.
5. **Module decomposition.** Schema validation, filesystem boundaries,
   locks/recovery, retention, and domain transitions remain in one large module.
   They should be split after the slice contract is stable, without weakening
   the focused adversarial gate.
6. **Tenant and process identity.** The store has no authenticated tenant
   namespace, and cross-host/PID-reuse identity is not a distributed lease.
   Tenant derivation belongs at the gateway API, and multi-host use requires a
   real lease/transaction store.
