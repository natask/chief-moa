# Privacy-First macOS Surface

## Why

Chief Moa needs a native macOS surface that reproduces Clicky's useful
cross-application observation, optional visual context, proactive suggestions,
and semantic action capabilities while moving the trust boundary to the user's
own Aggie gateway. The user may intentionally release this data to that server;
the product difference is inspectable ownership, destination control, and local
authority rather than artificially removing the capability.

## What Changes

- Define `MoaMac.app` as an Aggie-compatible macOS surface and the sole owner of
  Accessibility permission, product observation grants, local redaction,
  outbound preview, approvals, semantic execution, and canonical receipts.
- Use public `AXUIElement`/`AXObserver` for semantic context and actions, plus an
  independently enabled ScreenCaptureKit focused-window capture. Synthetic
  pointer/keyboard events, Apple Events, private SkyLight, login launch, vendor
  analytics, and ungranted network activity are absent.
- Separate macOS permissions from a visible, memory-only, one-app product
  grant. The grant explicitly chooses local-only, approve-each-release, or a
  time-bounded trusted-server mode pointed at the user's configured gateway.
- Bound and redact AX snapshots and optional focused-window JPEGs before an
  exact byte-bound preview or trusted-server release.
- Treat every gateway/model action as an inert proposal requiring a fresh local
  confirmation, target/state binding, and pending/terminal local receipt.
- Add a narrower user-originated literal-transcription insertion path that binds
  the prior focused editable target before Moa takes focus, previews the exact
  final transcript, and revalidates immediately before one AXValue write.
- Keep a portable semantic proposal/approval/receipt vocabulary while using
  platform-specific adapters on macOS, Windows, Android, browser, and iOS.

## Capabilities

### New Capabilities

- `macos-ax-surface`: explicit per-app AX observation and optional focused-window
  capture with hard bounds, redaction, user-owned gateway routing, exact release
  authority, proactive suggestion cards, local semantic-action confirmation,
  and receipt chaining through the canonical Aggie surface protocol.

## Impact

This change now creates a buildable unsigned `MoaMac.app` candidate, pure Swift
core/AX/capture adapters, strict self-hosted proactive gateway route, and tests.
Production promotion remains blocked until stable signing/notarization,
rollback, isolated TCC QA, gateway preview/backup evidence, and
no-active-session evidence exist.
