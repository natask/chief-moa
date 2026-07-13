# Goal: Apple native Aggie surfaces

## Objective

Produce the largest coherent unsigned, simulator-buildable Apple adapter for the
frozen Aggie N/N-1 protocol. The shared Swift core must consume bounded protocol
envelopes and preserve local proposal, approval, execution-decision and receipt
authority on macOS and iOS without becoming a second canonical product store.

## Lane

- Branch: `agent/apple-native-surfaces-20260711`
- Worktree: `/Users/natnaelkahssay/projs/chief-moa-worktrees/apple-native-surfaces`
- Base: integration `c4df1f5`

## Ownership

- `apple_surfaces/**`
- `reference/openspec/changes/define-apple-native-aggie-surface/**`
- this workflow packet
- narrowly scoped Apple-boundary additions to `ARCHITECTURE.md`

Do not touch Android, browser, Windows, gateway runtime/provider/storage,
payments, telemetry, deployment, or companion ownership.

## Non-negotiables

- No provider keys, canonical conversation store, implicit approval, proposal
  auto-execution, signing claim, device-install claim, or permanent UX choice.
- Server/model output remains an untrusted proposal.
- Approval binds the complete proposal and complete Apple surface identity.
- Receipts are locally formed evidence and never proof of remote persistence.
- No actual local action executor ships in this slice. An injected executor seam
  may be exercised only by deterministic tests after local eligibility passes.
- No signing, provisioning, Keychain claim, physical device action, live network,
  deployment, or active promotion.

## Acceptance

1. A Swift package builds for macOS and an available iOS Simulator SDK.
2. The core decodes only bounded N/N-1 Aggie envelopes, rejects credential or
   executable authority, validates complete surface/session/proposal bindings,
   and exposes bounded replay/reconnect behavior.
3. An actor-isolated coordinator requires an explicit injected local approver,
   rechecks expiry and local state immediately before an injected effect, and
   returns a proposal-bound local receipt.
4. Tests cover approval denial, mutation/replay, stale state, expiry, cross-
   session/device/surface mismatch, secret/executable payloads, duplicate
   proposals, bounded resources, and executor non-invocation on every denial.
5. Strict OpenSpec and specialist audit ledgers are green after repair cycles.

## Verification

- `cd apple_surfaces && swift test`
- `cd apple_surfaces && swift build -c release`
- `xcodebuild -scheme AggieAppleSurface -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build`
- strict OpenSpec validation for `define-apple-native-aggie-surface`

Simulator build availability proves compilation only. It does not prove UI,
accessibility, battery, networking, secure storage, signing, update, or device
behavior.
