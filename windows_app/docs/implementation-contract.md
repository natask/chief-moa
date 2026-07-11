# Windows surface core implementation contract

## Objective and non-negotiables

Deliver the largest testable Windows-compatible slice available on this host:
a provider-neutral protocol authority core and Windows CI contract. Server or
model output remains a proposal. A complete local surface, current state and
explicit approval decide eligibility. The library performs no effects.

## Ownership and lane

- Branch: `agent/windows-native-surfaces-20260711`
- Worktree: `/Users/natnaelkahssay/projs/chief-moa-worktrees/windows-native-surfaces-20260711`
- Owned: `windows_app/**`, `.github/workflows/windows-native-core.yml`
- Do not touch: Apple, Android, browser, gateway, deployment or existing M5
  protocol paths.

## Required behavior

- Parse no more than 64 KiB and accept only protocol 2 and 1.
- Permit benign additive data but recursively reject credential/executable
  names and representative credential values.
- Accept only a complete `windows` surface with ID/kind/mode and identical
  optional-device presence/value semantics.
- Require session, expiry, current-state and explicit approval invariants.
- Bind approval to proposal message, complete surface and the gateway-compatible
  canonical SHA-256 proposal digest.
- Make an eligible proposal an opaque capability that can produce a bounded
  data receipt only after an observed outcome is supplied.
- Contain no network, provider credential, canonical history, effect execution,
  command invocation, storage, install, signing, or update code.

## Edge cases and forbidden shortcuts

Reject unknown versions, malformed/impossible timestamps, stale state,
cross-session/surface/device approvals, mutated proposals, missing approval,
oversized/nested/wide input, OAuth callback codes, bearer/token material and
executable-shaped fields. Do not call the Windows CI artifact a native Windows
app, signed package, accessibility proof or production build.

## Gates

```sh
cd windows_app/core
cargo fmt --check
cargo test --locked
cargo clippy --all-targets -- -D warnings
```

Windows CI additionally runs an MSVC target build. No paid benchmark, model
call, external evaluation, signing, install, deployment or live promotion is
authorized.

## Audit blockers and escalation

Block on any effect path, credential/canonical-history storage, approval bypass,
digest incompatibility, unconstrained input, false Windows-build claim, or
ownership overlap. Escalate WinUI/MSIX/UX/signing decisions to the portfolio
manager because this contract deliberately does not invent them.
