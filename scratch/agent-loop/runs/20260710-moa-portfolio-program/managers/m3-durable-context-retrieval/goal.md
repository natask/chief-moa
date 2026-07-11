# M3 durable context retrieval

## Objective

Advance the gateway from ad hoc string context blocks to a canonical bounded
context artifact that is inspectable, cacheable, and privacy-aware without
introducing provider memory authority, a vector database, or live deploy work.

## Non-negotiables

- Context stays gateway-authored and bounded by explicit item/char limits.
- Provider memory remains derived and non-authoritative.
- Incognito, deleted, and unauthorized material must never enter retrieval.
- Cache identity must change when the retrieval query or cited source revision
  changes.
- Fork and interruption continuity must keep working.
- No tenant/auth redesign, no destructive migration, no deploy.

## Ownership and lane

- Branch: `agent/m3-durable-context-retrieval`
- Worktree: `/Users/natnaelkahssay/projs/chief-moa-worktrees/m3-durable-context-retrieval`
- Owns gateway context artifact assembly, retrieval metadata, and focused tests
  for the existing chat/voice retrieval seam.

## Acceptance for this implementation unit

1. Gateway builds a canonical context artifact with version, artifact id, cache
   identity, source ids, ranking rationale, and redaction metadata.
2. Chat and cascaded voice context assembly consume that artifact instead of
   open-coded string blocks.
3. The response `context` block exposes a bounded receipt for the artifact.
4. Focused tests prove privacy guards, deterministic cache identity, bounded
   output, and adversarial dedupe behavior.
5. `cd gateway && npm run check` passes in this environment.

## Live constraints

No active service restart, preview, push, or deploy. This unit ends at source
change, verification evidence, audit evidence, and a commit.
