# M6 implementation contract

## Exact objective

Add a deterministic, bounded, fail-closed companion package verifier and
non-executing lifecycle receipt seam. Preserve the existing catalog and profile
authority boundaries.

## Owned paths

- `gateway/lib/companion-package.js`
- `gateway/test/companion-package.test.js`
- `gateway/package.json`
- `ARCHITECTURE.md`
- `reference/openspec/changes/companion-catalog-profile-control/**`
- this M6 packet

## Contract

The envelope is `moa-companion-package/v1` with one canonical manifest and an
asset-body map. The manifest declares identity/version, timestamps, publisher,
provenance, SPDX-shaped license evidence, protocol compatibility, capabilities,
declared profile fields, bounded assets, moderation evidence, signing key and
signature. Ed25519 signs canonical manifest content excluding `signature`.

Verification requires caller-owned trust keys, accepted licenses, current
protocol, moderation approval and revocation sets. It checks all fields and
asset bytes before returning a frozen verified result. Preview/apply/revert
receipts are chained hashes over bounded data. `apply` is only a proposed plan;
it cannot call the profile store.

## Forbidden shortcuts

No archive extraction, URLs fetched during verification, dynamic code, CSS,
shell, unknown media, trust-on-first-use, default accepted license, cosmetic
revocation, mutable returned structures, active profile write, route exposure,
tenant/global state, publication or live deployment.

## Quality/resource targets

Decision complexity target <=10 and CRAP target <=15; exceptions require audit
evidence. Maximum 32 assets, 2 MiB each, 8 MiB total, 4096x4096 dimensions,
64 capabilities and 24 declared profile fields. Base64 length is bounded before
decode. Verification is linear in bounded manifest/assets and performs no I/O.

## Gates and escalation

Focused hostile test, full gateway check, strict companion spec inspection and
fresh adversarial review. Escalate rather than invent public trust roots,
accepted licenses, moderation/appeals, hosted sharing identity, tenant policy,
or client apply authority.
