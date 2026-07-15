# Repair contract: voice draft store final-audit-5 blockers

## Required fixes

1. Make persisted v2 schemas exact. Reject unknown top-level fields and unknown
   fields in every nested authority, request, receipt, segment, transition, and
   history object without rewriting the corrupt evidence.
2. Make physical draft directories state-specific and exact. A terminal
   directory may contain only its minimal replay metadata and explicitly named
   lock/atomic scaffolding. Unexpected regular files, symlinks, or directories
   before/after cleanup or restart must fail visibly; the store must never call
   such a record content-free or silently delete the unknown artifact.
3. Separate content compaction from replay authority. Tiny configured limits
   may remove audio/transcript/display material, but cannot erase the durable
   create/action decision and then reuse its idempotency key. A retry for an
   actually compacted draft must deterministically replay or return a durable,
   inspectable expired-domain outcome that cannot create/execute again. Valid
   absent/expired mutations must never become filesystem 500s.
4. Make audio consumption digest-safe. `createReadStream()` must consume an
   immutable verified snapshot or fail before yielding any byte when the
   current PCM differs by digest/inode/path. It may not reopen and trust size
   alone. Preserve the documented bounded-memory and cleanup lifetime contract.
5. Reject duplicate transition-history idempotency hashes and any contradictory
   canonical replay authority. Bind `sent_request.expected_revision` and all
   other request authority exactly across terminal history, claim, receipt, and
   transition revision.
6. Require `sent_at` to be a canonical string timestamp before parsing. Reject
   numbers, objects, arrays, booleans, coercible values, and malformed strings
   before any state or filesystem mutation.

## Required adversarial regressions

- unknown transcript/audio fields at every nested level, plus unexpected
  files/symlinks/directories, fail before cleanup, after cleanup, and restart;
- with `maxDrafts:1` and `maxTerminalDrafts:1`, retry the record actually
  compacted before and after restart: no new draft ID, duplicate action, or 500;
- same-size post-handle PCM mutation, inode replacement, directory replacement,
  and cleanup races cause both `readBuffer()` and `createReadStream()` to fail
  without emitting unverified data;
- duplicate persisted hashes, reordered forged entries, and every sent
  request/history/claim/receipt/revision mismatch fail closed across restart and
  preserve evidence;
- malformed `sent_at` values prove zero revision/state/file change.

## Ownership and constraints

Own only the existing voice-draft slice files under `gateway/lib`,
`gateway/test`, `gateway/scripts`, its OpenSpec/docs, and this lane's durable
notes. Do not touch server routes, Android, browser, active tree, or live data.
Do not commit, merge, or deploy.

## Verification

```sh
node --check gateway/lib/voice-drafts.js
node --check gateway/test/voice-drafts.test.js
node --check gateway/scripts/smoke-voice-drafts.js
node --test gateway/test/voice-drafts.test.js
node gateway/scripts/smoke-voice-drafts.js
git diff --check
```

Return PASS/BLOCK with file:line and exported-API evidence in
`repair-audit-6-result.md`. Root will arrange a fresh audit and integrated full
gateway gate.
