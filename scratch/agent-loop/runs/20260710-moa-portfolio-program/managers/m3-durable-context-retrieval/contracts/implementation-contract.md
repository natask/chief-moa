# Contract M3-1: canonical context artifact envelope

## Objective

Add one canonical, deterministic artifact envelope around the existing gateway
retrieval inputs so chat/voice can cite what context they used and invalidate
stale caches safely.

## Owned paths

- `gateway/lib/context-artifact.js`
- `gateway/server.js`
- focused gateway tests and smoke for the context artifact seam
- `ARCHITECTURE.md`
- `reference/openspec/changes/context-thread-management/*`
- this manager packet

## Behavior

- Collect standing facts, recency, semantic recall, and operational context into
  normalized source items with stable source ids.
- Redact secret-like text before it enters the artifact text or receipt.
- Omit incognito and deleted items; treat unauthorized filtering as future MF
  work and do not fabricate it.
- Produce deterministic `artifact_id` and `cache_identity.key` from version,
  query, scope, and cited source revisions.
- Emit a bounded client receipt containing version, ids, counts, truncation, and
  ranking rationale; do not expose raw full-text source payloads there.
- Keep existing fork inheritance and interruption continuity behavior.

## Forbidden shortcuts

- No provider memory authority.
- No vector database, embeddings service, or LLM judge.
- No global unscoped cache key.
- No raw secret/token text in artifacts.
- No claim of hosted multi-tenant safety before MF authority lands.
- No deploy, preview, or runtime restart.

## Gates

- Focused smoke: `cd gateway && node scripts/smoke-context-artifact.js`
- Full gateway gate: `cd gateway && npm run check`
- Fresh hostile privacy/performance/anti-gaming audit recorded in the claims and
  merge ledgers.

## Escalation

Escalate tenant-scoped reads/deletion policy, cross-surface client rendering,
and broader retrieval evaluation corpora as follow-on units.
