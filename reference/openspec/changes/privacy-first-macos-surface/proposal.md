# Privacy-First macOS Surface

## Why

Chief Moa needs a native macOS surface that can understand and act across apps
without recreating Clicky's opaque activity timeline, ambient server-side
proactive suggestion processing,
or private-framework control path. macOS already exposes supported semantic
inspection and actions through `AXUIElement`; pixels and coordinate automation
are unnecessary for the first useful version.

## What Changes

- Define `MoaMac.app` as an Aggie-compatible macOS surface and the sole owner of
  Accessibility permission, product observation grants, local redaction,
  outbound preview, approvals, semantic execution, and canonical receipts.
- Use only public `AXUIElement`/`AXObserver` APIs in v1. Screen Recording,
  synthetic pointer/keyboard events, Apple Events, private SkyLight, login
  launch, analytics, and automatic network activity are absent.
- Separate the macOS permission from a visible, memory-only, one-app product
  grant. Observation/dismissal has zero network traffic.
- Bound and redact AX snapshots before an exact byte-bound payload preview.
- Treat every gateway/model action as an inert proposal requiring a fresh local
  confirmation, target/state binding, and pending/terminal local receipt.
- Keep a portable semantic proposal/approval/receipt vocabulary while using
  platform-specific adapters on macOS, Windows, Android, browser, and iOS.

## Capabilities

### New Capabilities

- `macos-ax-surface`: explicit per-app AX observation with hard bounds,
  redaction, no ambient network, exact release preview, local semantic-action
  validation/confirmation, and receipt chaining through the canonical Aggie
  surface protocol rather than a parallel desktop backend.

## Impact

This change is a staged native-app contract. The browser helper implementation
does not add macOS permissions or code. Future implementation creates a stable,
Developer-ID-signed/non-sandboxed `MoaMac.app`, a pure Swift core/AX adapter,
fixture app and privacy smokes, then extends the Aggie surface protocol with
explicit semantic UI action kinds. Production promotion remains blocked until
signing/notarization, rollback, isolated TCC QA, and no-active-session evidence
exist.
