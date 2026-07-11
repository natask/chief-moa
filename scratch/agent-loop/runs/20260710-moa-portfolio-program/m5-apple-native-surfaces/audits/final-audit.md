# Apple native surface final audit

## Cycle 1 — BLOCK

The fresh hostile audit refuted the initial green-test claim. It found gateway
digest drift, empty preconditions, non-protocol surface/approval enums,
incomplete secret shapes, retry after uncertain effects, and caller-controlled
replay byte accounting. The 5-group initial test run did not cover these cases.

## Repair contract and result

- Reproduce the gateway canonical digest with a fixed cross-language vector.
- Enforce macOS/iOS surface kinds, gateway action kinds, all approval classes,
  and nonempty state preconditions.
- Reject additional token shapes and control characters before typed decoding.
- Consume a proposal before entering the uncertain injected-effect boundary so
  an effect-then-error cannot be retried.
- Derive replay size from retained canonical bytes, not a caller integer.
- Add hostile digest, enum, precondition, secret and uncertain-effect tests.

## Cycle 2 — PASS for the unsigned library seam

Tier 0 inspected the repaired source and reran the macOS tests, release build,
unsigned generic iOS Simulator build and strict OpenSpec validation. No network,
Keychain, SwiftUI, process, provider, or OS-effect import exists in the source.

This PASS is limited to deterministic protocol/local-authority behavior and
compilation. UX, accessibility, energy, authenticated networking, secure token
storage, signing, update, distribution and physical-device behavior remain
explicitly unimplemented and unmeasured.

## Claims ledger

| Implementer claim | Evidence checked | Verdict |
|---|---|---|
| N/N-1 bounded proposal consumer | decoder source, hostile tests, Swift test | verified for action proposals only |
| Gateway-compatible proposal digest | fixed JS-generated digest vector | verified |
| Approval cannot cross session/surface/device/mode | coordinator guards and denial tests | verified |
| Stale/expired/denied proposal cannot invoke effect | pre/post checks and zero-count tests | verified |
| Uncertain effect cannot be retried | consume-before-effect and failing-executor test | verified |
| Replay resource accounting is bounded | retained `Data.count`, event/count limits | verified |
| macOS/iOS compile | Swift release and unsigned iOS Simulator builds | verified |
| Native application/device/signing readiness | no app target/device/signing evidence | unproven and not claimed |

No paid benchmark, external model evaluation, device test or production trial
ran. Complexity and CRAP are unmeasured because no Swift metric gate is installed.
