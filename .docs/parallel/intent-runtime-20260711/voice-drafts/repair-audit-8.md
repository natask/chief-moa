# Repair contract: voice draft store final-audit-7 blockers

## Required fixes

1. Preserve independently checkable compacted terminal authority. A sent
   outcome must retain or cryptographically bind the exact claim, claim request,
   final revision, terminal history/request/receipt, create/capture authority,
   session/branch/turn, actor/source/surface/release, timestamp, and action hash.
   Discarded outcomes need equivalent independent anchors. One-field and jointly
   coherent tampering must fail before rewrite.
2. Close every nonterminal state/revision chain. Current state must equal the
   last exact transition outcome; current revision must equal the last mutation
   anchor under an explicit no-history/initial rule; append, park/recovery,
   resume/pause, send-ready, and claim request revisions must bind their exact
   predecessor/successor revisions even after bounded history truncation.
3. Give mandatory orphan recovery a dedicated bounded system decision slot or
   record that user action hashes cannot exhaust. Recovery at exact configured
   user capacity must park once and replay identically on later restarts without
   raising limits or deleting client idempotency evidence.
4. Treat an owner/lease file as uncommitted until parent-directory durability
   succeeds. Any post-create failure must compare-and-remove only the exact
   inode/owner ID and durably confirm cleanup (or leave an explicit recoverable
   acquisition marker). A capture lease whose draft was never published is an
   interrupted acquisition, not live capture.
5. Bound expired replay authority without permitting key reuse. Replace one
   directory/JSON per expired outcome with a keyed transactional/bounded index,
   or an equivalent exact structure with explicit maximum records and metadata
   bytes. Lookup/reopen must not scan/retain every historical directory. When
   exact replay capacity is full, fail new admission deterministically with
   backpressure; never delete the only deny/replay decision and never report
   quota green. Status must count every physical/index metadata byte and record.

## Required exported-API/restart regressions

- compacted sent and discarded outcomes reject every single-anchor and jointly
  forged revision/turn/authority change byte-for-byte before/after restart;
- paused revision/state, capturing/append, parked/recovery, send-ready/claim,
  segment revision, and bounded-history truncation matrices reject divergence;
- user action hashes at exact cap still permit one deterministic orphan park
  and subsequent replay, while another user action remains 507;
- store-lock and capture-lease owner-file directory-fsync failures leave no
  blocking live owner and allow same-process retry/restart; cleanup failure is
  explicit and adoptable, never silently stolen;
- a small replay-index count/byte cap stays physically bounded under many
  turnovers, offers keyed lookup, reports exact usage, and rejects further
  admission without duplicate IDs/actions or linear directory growth.

Also retain all 47 existing exact-schema, physical-allowlist, digest-safe
snapshot, symlink, lease/CAS, strict numeric/time, cleanup-crash, and replay
tests.

## Ownership and constraints

Own only the existing voice-draft slice under `gateway/lib`, `gateway/test`,
`gateway/scripts`, its OpenSpec/docs, and this lane's notes. Do not touch routes,
browser, Android, active tree, or live data. Do not commit, merge, or deploy.

## Verification

```sh
node --check gateway/lib/voice-drafts.js
node --check gateway/test/voice-drafts.test.js
node --check gateway/scripts/smoke-voice-drafts.js
node --test gateway/test/voice-drafts.test.js
node gateway/scripts/smoke-voice-drafts.js
git diff --check
```

Write `repair-audit-8-result.md` with exact file:line, resource measurements,
and residual compatibility/performance debt. Root will require another fresh
auditor and an integrated full gateway gate.
