# Windows surface core adversarial audit

Date: 2026-07-11

## Verdict

PASS for the provider-neutral portable core and Windows-target source artifact.
BLOCK for any claim of a Windows application, WinUI UX, secure credential
storage, native action execution, MSIX, signing, install, update, accessibility,
physical-device behavior, transport authentication or production readiness.

## Claims ledger

```text
Implementer claim -> proposal approval is local and full-surface-bound -> VERIFIED
Evidence checked -> src/lib.rs evaluate/validate_approval; complete_surface_is_authority
Auditor verdict -> PASS

Implementer claim -> proposal mutation cannot retain approval -> VERIFIED
Evidence checked -> gateway-compatible digest fixtures, including JS number formatting; proposal_mutation test
Auditor verdict -> PASS

Implementer claim -> benign additive data does not enable authority -> VERIFIED
Evidence checked -> recursive security scan plus additive surface/payload fixtures
Auditor verdict -> PASS

Implementer claim -> the core cannot execute effects or store keys/history -> VERIFIED for owned paths
Evidence checked -> dependency/source inventory; no network, process, filesystem, unsafe, Windows API, or provider client
Auditor verdict -> PASS

Implementer claim -> Windows build -> REFUTED if interpreted as native/runtime evidence
Evidence checked -> macOS host lacks .NET/MSBuild/WinUI/Windows runtime; only Rust MSVC-target cross-build ran
Auditor verdict -> BLOCK broader claim
```

## Attack passes and repairs

- Security/trust boundary: attacked surface ID-only authorization, optional
  device stripping, cross-session scope, mutation, missing/rejected/malformed
  approval, stale state, expiry, impossible timestamps, credential/OAuth and
  executable smuggling. A wire approval provenance bypass was found and
  repaired: eligibility now accepts only an opaque `LocalApproval` minted by
  `approve_locally`, never a deserialized approval envelope. Repairs also added
  exact enum/ID/digest/time checks, complete-surface equality and recursive
  fail-closed scanning.
- Anti-gaming/integration: compared proposal digest to the actual gateway JS
  implementation. A numeric-canonicalization risk was found and repaired with
  JS-compatible number rendering plus fixed gateway fixtures.
- Resource/performance: parsing rejects input over 64 KiB before JSON decode,
  and bounds nesting, array width and object width. No benchmark was run and no
  latency/throughput claim is made.
- Quality/complexity: Clippy is warning-free and API ownership is narrow. No
  mutation tool, coverage tool, CRAP calculator or Windows static analyzer ran;
  those gates are unproven rather than inferred from tests.
- UX/accessibility: no UI exists. That is an honest staged boundary, not a PASS.
- Packaging/supply chain: exact Cargo lock exists and GitHub job permissions are
  read-only. GitHub-hosted Windows CI has not yet run, and action pinning remains
  by major tag rather than immutable commit digest.

## Measured evidence

- `cargo test --locked`: 14 passed, 0 failed, 0 ignored.
- `cargo clippy --all-targets -- -D warnings`: passed.
- `cargo build --locked --target x86_64-pc-windows-msvc`: passed as a macOS
  cross-build after installing the Rust standard library target.

These are deterministic source/core results, not native Windows runtime or
benchmark measurements.

## Architecture confidence (not a benchmark score)

Medium-high confidence that the core preserves the M5 local-authority boundary,
based on disjoint ownership, gateway digest fixtures, hostile cases and absence
of I/O/effect capabilities. Residual unknowns are the full native shell,
transport/device authentication, secure token lifecycle, action-specific
validation/execution, UI Automation, keyboard/Narrator behavior, power/memory
on hardware, MSIX identity/signing/update and rollback.
