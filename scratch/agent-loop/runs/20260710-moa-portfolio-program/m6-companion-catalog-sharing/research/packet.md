# Research packet

## Topology

The existing `gateway/lib/companion-catalog.js` persists mutable custom
companions and compiles profile patches. Gateway routes expose catalog draft,
preview and apply behavior, while browser/Android clients consume the active
companion. M6 therefore adds a package verification boundary without replacing
that store or silently making imported data executable.

## Trust and provenance

Node 20 provides Ed25519 signing/verification through `node:crypto`; the package
format can use canonical JSON and SHA-256 without a new dependency. A signature
only proves possession of a configured key. It does not establish who belongs
in a public trust root, whether a license is acceptable, or whether moderation
was legitimate. Those policies remain injected, empty-by-default, and fail
closed.

## Resource and archive risks

Archive extraction introduces traversal, symlink and decompression-bomb attack
classes. The local milestone deliberately uses a bounded JSON envelope with a
small allowlist of image/audio media and base64 asset bodies. It validates
encoded length before decoding, then validates byte length, digest, dimensions,
path uniqueness and total limits. Unknown keys and executable media are
rejected.

## Compatibility and recovery

Compatibility is an exact protocol range checked by a caller-supplied current
version. Import produces a verified immutable value; preview/apply/revert
functions produce chained receipts but perform no mutation. Integration must
later bind apply authority to tenant identity, profile versioning and the M5/MX
protocol gate.

## Verification and model/tool selection

This slice needs security/state reasoning more than UI generation. Built-in
Node crypto plus deterministic unit/property-style hostile fixtures provide the
closest local evidence. No paid model evaluation, external benchmark, vendor
trial, live client, public catalog or offline revocation service was exercised.
