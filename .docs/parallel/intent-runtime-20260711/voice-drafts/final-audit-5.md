# Voice Draft Store Final Audit 5

## Disposition

`BLOCK`

The repaired slice passes its authored syntax, focused-test, smoke, and
whitespace gates, and it closes the five concrete audit-4 examples on the paths
covered by those tests. Fresh adversarial probes against the exported store
still found four release blockers: terminal records are not actually
content-free under strict persisted-schema rules, terminal compaction loses
idempotency authority, the lazy stream can emit bytes that fail the stored
digest, and persisted replay authority can be made ambiguous. A caller-supplied
numeric `sent_at` is also coerced into a valid historical timestamp instead of
being rejected.

No implementation, commit, merge, deployment, or live data was changed by this
audit.

## Passing Evidence

- `node --check gateway/lib/voice-drafts.js`: passed.
- `node --check gateway/test/voice-drafts.test.js`: passed.
- `node --check gateway/scripts/smoke-voice-drafts.js`: passed.
- `node --test gateway/test/voice-drafts.test.js`: 34 tests, 34 pass, 0 fail.
- `node gateway/scripts/smoke-voice-drafts.js`: `smoke-voice-drafts: ok`.
- `git diff --check`: passed.
- Each untracked slice file also passed
  `git diff --no-index --check /dev/null <file>`.
- The implementation imports only Node `crypto`, `fs`, and `path`. It contains
  no provider, model, tool, network, STT, LLM, or TTS dependency.
- The focused suite exercises real exported functions and reproduced the
  audit-4 symlink, container-ID, missing-create-authority, forged-terminal,
  raw-audio, configured-limit, strict-number, terminal-turnover, real-child
  lease, stale-lock, append-journal, and cleanup-crash cases.
- A full `npm run check` was attempted. It was not a usable project gate in
  this old isolated worktree because runtime dependencies are absent: the run
  reported 173 pass, 50 fail, and 1 skip, with load/start failures including
  missing `pg`, `ws`, `@executor-js/sdk`, and `livekit-server-sdk`. The voice
  draft tests themselves passed inside that run. This environmental failure is
  separate from the blockers below and must be rerun from the integrated tree
  with installed dependencies.

## Blocking Findings

### 1. Terminal cleanup accepts and preserves unrecognized logical and physical content

Persisted draft normalization begins with `...clone(draft)` and overwrites only
known fields (`gateway/lib/voice-drafts.js:1260-1303`). Unknown top-level fields
therefore survive reads and every later metadata rewrite. Transition-history
entries similarly retain unrecognized nested fields
(`gateway/lib/voice-drafts.js:2254-2258`), and segment append requests are cloned
before only selected fields are checked (`gateway/lib/voice-drafts.js:1422-1448,
3220-3265`).

Discard/sent cleanup clears only the known transcript, audio record, and segment
array (`gateway/lib/voice-drafts.js:1016-1048`) and removes only `audio.pcm`, the
append journal, and recognized atomic temps
(`gateway/lib/voice-drafts.js:1051-1065,3364-3385`). The terminal invariant's
definition of empty content likewise considers only known metadata fields
(`gateway/lib/voice-drafts.js:3136-3141,3183-3191`). Startup validates known
audio but does not reject unexpected files for an authoritative draft
(`gateway/lib/voice-drafts.js:738-767`).

Direct probe:

1. Create a draft whose known partial transcript is `known secret`.
2. Add `unknown_transcript_backup: "must disappear"` and an extra raw-audio
   object to `meta.json`.
3. Call exported `get`, then exported `discard`.
4. The returned and persisted discarded record still contains
   `unknown_transcript_backup: "must disappear"`.
5. Add `transcript.backup` to the clean terminal directory and restart the
   exported store.
6. Restart succeeds, `get` returns `state: "discarded"`, and the physical
   `transcript.backup` remains readable.

This violates the strict-v2 corruption rule and the central privacy claim that
a sent/discarded tombstone contains no audio or transcript. The same weakness
also lets arbitrary bounded metadata bypass the specific collection/text
schemas while remaining under the outer metadata byte cap.

Required repair:

- Construct every persisted normalized record from an exact field allowlist,
  or reject unknown fields at the top level and in every authority/request /
  receipt/history object. With an exact store revision, silently retaining
  future or foreign fields is not compatible fail-closed behavior.
- Define state-specific physical-file allowlists. A clean terminal record must
  reject any file other than its exact metadata/operation-lock scaffolding.
- Cleanup must fail visibly and preserve evidence when an unexpected artifact
  exists; it must not claim content-free completion or silently delete an
  unknown file.
- Add regressions for unknown top-level/nested transcript/audio fields and
  unexpected regular files/symlinks before cleanup, after cleanup, and across
  restart.

### 2. Terminal compaction loses exact create/action replay and permits duplicate creation

`compactTerminalDrafts()` deletes the only authoritative metadata and then the
draft directory (`gateway/lib/voice-drafts.js:1551-1589`). Create replay scans
only surviving authoritative drafts (`gateway/lib/voice-drafts.js:2108-2123`).
The status response explicitly narrows exact replay to `retained_records`
(`gateway/lib/voice-drafts.js:672-677`), but audit 4 required deterministic
replay for retained/compacted keys, not silent reuse after eviction.

Direct probe with `maxDrafts: 1, maxTerminalDrafts: 1`:

1. Create and discard A.
2. Create and discard B, which removes A's terminal directory.
3. Retry A's exact create command.
4. The store returns a newly allocated draft ID rather than A's original ID.
5. Retrying A's original discard by original draft ID returns a store-internal
   500 (`... lock is unavailable: ENOENT`) rather than deterministic replay or
   an explicit expired/not-found result. The 500 originates because mutation
   locking asserts the directory before the required-draft lookup
   (`gateway/lib/voice-drafts.js:1703-1712`).

This converts a lost response or delayed retry into a second capture object and
removes the durable action-deny evidence. Calling the behavior a finite replay
horizon does not satisfy the prior repair contract, and the authored turnover
test checks only the one record still retained
(`gateway/test/voice-drafts.test.js:1393-1481`).

Required repair:

- Compact content and display metadata separately from replay authority. Keep a
  durable minimal create/action replay record or use the canonical event /
  transaction substrate as the external replay index.
- An expired key must never be silently treated as unused. If the product
  intentionally chooses a finite replay horizon, define and persist an
  inspectable expiration outcome that prevents duplicate execution and return a
  deterministic domain status; do not erase all evidence and create again.
- Map valid but absent/expired draft mutations to the documented domain status,
  not a filesystem 500.
- Extend the tiny-cap regression to retry the record that was actually
  compacted, both before and after restart.

### 3. `createReadStream()` can silently emit bytes that fail the advertised digest

`readAudio()` validates the PCM when the handle is created. Later,
`createReadStream()` reopens the file and compares only its byte size
(`gateway/lib/voice-drafts.js:500-520`). In contrast, `readBuffer()` rechecks
both size and SHA-256 (`gateway/lib/voice-drafts.js:522-540`).

Direct probe:

1. Create/append/park a four-byte draft and obtain a `readAudio()` handle.
2. Replace the four PCM bytes in place with different four bytes.
3. `handle.readBuffer()` rejects with `PCM digest changed before reading`.
4. `handle.createReadStream()` succeeds and emits the changed bytes without an
   error.

The stream is the seam intended to feed the ordinary turn path, so a provider
can receive bytes that do not match the canonical segment/audio digest while
the store labels them as verified audio. This is distinct from the documented
fact that an already-open descriptor cannot be revoked after discard.

Required repair:

- Make the stream consume an immutable verified snapshot, or remove the lazy
  stream seam and require a bounded verified buffer until a stream design can
  guarantee the digest before downstream acceptance.
- Add a same-size post-handle mutation regression for both `readBuffer()` and
  `createReadStream()`, plus inode/directory replacement and cleanup races.

### 4. Persisted replay authority is ambiguous, and numeric `sent_at` is coerced

Stored transition-history validation limits length and validates each entry in
isolation, but it does not require unique idempotency hashes
(`gateway/lib/voice-drafts.js:2196-2260`). `findRecordedAction()` selects the
first matching entry (`gateway/lib/voice-drafts.js:2017-2029`). A crafted
metadata record containing two otherwise valid entries for the same key/hash,
with the forged actor first, was accepted across restart. Retrying as the forged
actor returned the forged receipt; retrying the original canonical request then
returned 409.

Sent request/receipt cross-checking omits `expected_revision`
(`gateway/lib/voice-drafts.js:1332-1357`), and terminal-history validation checks
only the key, time, actor, and action (`gateway/lib/voice-drafts.js:3206-3217`).
Changing only persisted `sent_request.expected_revision` was accepted across
restart: the original retry conflicted while a retry carrying the forged
revision replayed the receipt.

Finally, explicit `sent_at` is passed through `normalizeTimestamp()` without a
type check (`gateway/lib/voice-drafts.js:2405-2411,2534-2539`). Passing the JSON
number `123` successfully terminalized a draft and stored
`0123-01-01T07:52:58.000Z`; it did not fail before mutation as a malformed
receipt authority field.

Required repair:

- Reject duplicate transition-history idempotency hashes and contradictory
  canonical requests; validate a coherent final replay record rather than
  choosing the first match.
- Bind `sent_request`, its terminal history request, sent receipt, claim, and
  the transition revision fields exactly.
- Require `sent_at` to be a string before parsing and add numeric/object/array
  rejection tests proving no state or filesystem change.
- Add restart probes showing that any replay-authority disagreement fails
  without rewriting the evidence.

## Reproduced Audit-4 Results

The following earlier attacks now fail closed in the focused run:

- static draft-directory symlink substitution is rejected by `get`, `list`,
  `segments`, `readAudio`, a lazy handle, every mutation, restart recovery, and
  cleanup; the outside tree remains unchanged;
- stored ID/container disagreement and missing v2 create authority are rejected
  without rewrite or duplicate creation;
- a simple forged `sent` state and terminal raw `audio.pcm` resurrection are
  rejected without deleting evidence;
- oversized metadata bytes, transcript, segments, histories, hashes, per-draft
  totals, per-segment totals, and store totals are rejected under active lower
  limits;
- string, fractional, unsafe, NaN, and infinite expected revisions, declared
  byte counts, and durations are rejected before mutation; and
- real child-process capture exclusion, stale-lock ownership, journal crash
  recovery, cleanup retry, and lease rollback tests pass.

These passes are substantive but do not cover the four blockers above.

## Residual Integration Debt

- Tenant/user authorization is still absent from the file store and must be
  derived by the authenticated gateway integration.
- Hashing and validation remain synchronous and potentially quadratic across
  bounded repeated appends; high-volume gateway use needs worker/streaming
  isolation.
- Portable Node filesystem APIs still cannot provide native `openat` /
  directory-FD operations against a hostile same-UID race. The existing
  pre/post inode checks close static and ordinary substitution attacks, not that
  native race class.
- Read snapshot lifetime and already-open-descriptor behavior require an
  explicit gateway contract after the digest-safe stream blocker is repaired.

## Re-Audit Gate

After a focused repair, rerun:

```sh
node --check gateway/lib/voice-drafts.js
node --check gateway/test/voice-drafts.test.js
node --check gateway/scripts/smoke-voice-drafts.js
node --test gateway/test/voice-drafts.test.js
node gateway/scripts/smoke-voice-drafts.js
git diff --check
```

Then run the full gateway check from the integrated tree with dependencies
installed. Do not commit, merge, integrate, or deploy this slice before a fresh
independent audit returns `PASS`.
