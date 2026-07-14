# Surface product implementation contract

## Sequence and ownership

1. Repair the shared Swift authority seam, then build the macOS SwiftUI shell.
2. Reuse that seam in an iOS Simulator SwiftUI shell; do not fork authority.
3. Add the Windows project/CI artifact around the existing Rust authority core.
4. Add Android and browser Aggie adapters and a cross-language N/N-1 golden matrix.

The sequence is mandatory because each shell consumes the same frozen wire
vectors. Disjoint client paths may be implemented in parallel only after those
vectors are frozen.

## Swift authority contract

- Wire strings decode into closed `SurfaceKind`, `SurfaceMode`, `ActionKind`,
  `ApprovalClass`, and receipt outcome enums. Unknown values fail before prompt.
- JSON numbers reject NaN/infinity, unsafe integers, negative zero ambiguity and
  representations that cannot reproduce the gateway canonical digest.
- A bounded durable journal records pending, consumed, and terminal receipts.
  Journal writes are atomic and injectable for tests. Restart recovery exposes
  `not_started`, `known_failed`, `known_succeeded`, and `unknown_effect`; only
  `not_started`/known safe failures are retryable.
- The effect boundary is journaled before invocation. An executor error is an
  unknown effect unless the executor returns a typed authoritative outcome.

## Product-shell contract

- macOS first, iOS Simulator second, both real SwiftUI application targets.
- Show proposal summary, required permission, approval/deny controls, expiry or
  stale-state rejection, executing state, terminal outcome, and restart recovery.
- Controls have labels, hints, traits, deterministic identifiers, keyboard paths,
  Dynamic Type-compatible layouts, and no color-only status.
- App executors remain safe no-op/demo executors; no OS effect or network authority.

## Windows and adapter contract

- Windows project consumes the Rust core and has a Windows-host CI workflow.
  If this host cannot execute it, report source/cross-build evidence only.
- Kotlin and browser adapters parse/validate the frozen protocol subset, preserve
  complete surface scope, and never execute gateway/model payload directly.
- Golden fixtures cover versions N/N-1, number/string canonicalization, proposal
  digest, full surface scope, expiry, stale state, unknown semantic enums,
  additive credential fields, and receipt correlation.

## Forbidden shortcuts

No second protocol, gateway edits, permissive string enums, in-memory-only effect
authority, retry after unknown effect, fake app target, test-only UI presented as
product, secrets, provider calls, signing, install, or benchmark claim.

## Gates

Decision complexity target is <=10 and CRAP <=15 where measured tooling exists;
otherwise label unmeasured. Pending proposals <=128, replay <=256 events/1 MiB,
journal records bounded and compacted. No polling or main-thread blocking.

Auditors must produce `claim -> verified/refuted/unproven`, exact evidence, and
PASS/BLOCK/repair-required verdicts. A BLOCK yields a targeted repair contract.

