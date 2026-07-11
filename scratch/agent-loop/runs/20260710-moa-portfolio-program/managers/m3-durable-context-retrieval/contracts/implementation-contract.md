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
- Redact bearer/API credentials, OAuth URL/query credentials (including encoded
  callback forms), and common PAT-like tokens before artifact rendering.
- Omit incognito and deleted items; treat unauthorized filtering as future MF
  work and do not fabricate it.
- Produce deterministic `artifact_id` and `cache_identity.key` from version,
  query, scope, and cited source revisions.
- Emit a bounded client receipt containing version, ids, counts, truncation, and
  ranking rationale for sources that actually contributed rendered text; do not
  expose raw full-text source payloads there.
- Enforce session and branch scope while collecting run/task candidates. A
  turn-supplied run reference never overrides the run's own stored scope.
- Inspect at most 256 or `max_sources * 4` candidate sources (whichever is
  smaller), eight lines per source, and 4,000 input characters per line before
  sorting/redaction. Record omitted prefixes honestly.
- Keep existing fork inheritance and interruption continuity behavior.

## Forbidden shortcuts

- No provider memory authority.
- No vector database, embeddings service, or LLM judge.
- No global unscoped cache key.
- No raw secret/token text in artifacts.
- No claim of hosted multi-tenant safety before MF authority lands.
- A caller-provided `authorized` flag is only an eligibility hook; it is not
  evidence of authenticated or tenant-authorized reads.
- No deploy, preview, or runtime restart.

## Gates

- Focused smoke: `cd gateway && node scripts/smoke-context-artifact.js`
- Full gateway gate: `cd gateway && npm run check`
- Fresh hostile privacy/performance/anti-gaming audit recorded in the claims and
  merge ledgers.

## Escalation

Escalate tenant-scoped reads/deletion policy, cross-surface client rendering,
and broader retrieval evaluation corpora as follow-on units.
