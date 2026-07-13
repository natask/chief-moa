# M6 companion catalog, sharing and provenance

Branch: `agent/m6-companion-catalog-sharing`

Worktree: `/Users/natnaelkahssay/projs/chief-moa-worktrees/m6-companion-catalog-sharing`

## Objective

Create a local, provider-neutral companion package boundary with canonical
manifests, asset hashes, provenance, license and compatibility declarations,
explicit capabilities, signature/revocation verification, bounded import/export
and reversible preview/apply planning receipts.

## Non-negotiables

- Packages are data/assets only: no JavaScript, CSS, shell, eval, archives or
  undeclared profile mutation.
- Unknown signers, revoked artifacts/signers, missing licenses, incomplete
  provenance, incompatible protocols and unapproved moderation states fail
  closed.
- Public trust roots, accepted license policy, marketplace moderation/appeals,
  hosted sharing authority and live execution remain unresolved and unwired.
- No public publish, credentials, network calls, active profile mutation or
  deployment.

## Ownership

Own `gateway/lib/companion-package.js`, focused tests, the companion OpenSpec,
and this M6 packet. Do not change identity, billing, deployment, existing
catalog persistence, profile mutation, clients or live routes.

## Acceptance

- Deterministic canonical package digest and Ed25519 verification.
- Hostile fixtures cover tamper, unknown signer, revocation, license,
  moderation, traversal, executable media, resource bounds and undeclared
  profile fields.
- Import/export is bounded and in-memory; no archive extraction.
- Preview/apply/revert records are immutable data plans and never execute.
- `cd gateway && node --test test/companion-package.test.js` and `npm run check`.
