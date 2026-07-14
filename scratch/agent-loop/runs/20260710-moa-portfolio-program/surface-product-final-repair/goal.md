# Surface product final repair

## Outcome

Materialize the Aggie N/N-1 contract as honest, locally authoritative product
surfaces: an unsigned macOS SwiftUI shell, an unsigned iOS Simulator shell, a
Windows build/CI artifact, and Android/browser protocol adapters. Local effects
remain proposal-only until platform approval and durable receipt recovery prove
the effect state.

## Lane

- Branch: `agent/surface-product-final-repair`
- Worktree: `/Users/natnaelkahssay/projs/chief-moa-worktrees/surface-product-final-repair`
- Base: `caba6a1`

## Owned paths

- `apple_surfaces/**`
- `windows_app/**`
- new narrow protocol-adapter paths and tests under `android_app/**` and
  `browser_extension/**`
- Apple/surface OpenSpec and this workflow packet

Gateway protocol changes require a new parent-approved contract.

## Non-negotiables

- Closed semantic enums, bounded decoding, and finite/safe numeric canonicalization.
- Durable pending/consumed/outcome-aware receipts survive restart. An unknown
  effect outcome cannot be retried as though no effect occurred.
- Explicit permission, denial, stale-state, expiry, interrupted/unknown-effect,
  and recovery UX with accessibility identifiers and tests.
- N and N-1 golden vectors are identical across JS, Swift, Rust, Kotlin, and
  browser JavaScript adapters.
- No signing, physical-device, live install, provider credentials, or production
  readiness claim.

## Acceptance

- Swift package tests and macOS release build pass.
- Unsigned iOS Simulator app build passes where installed SDK permits.
- Rust tests/clippy and Windows target cross-build pass; Windows-host CI is a
  source artifact unless GitHub executes it.
- Android unit/build gate and browser verify/smoke adapter gate pass.
- Security, UX/accessibility, performance/resource, quality/complexity,
  anti-gaming, and integration auditors return PASS or create repair contracts.

