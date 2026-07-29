# Separate macOS and Browser Products with a Narrow Bridge

## Why

The native Mac companion and browser agent solve different problems. The Mac
product provides a fast, system-wide Clicky-style summon surface and owns
macOS-local permissions. The browser product provides a browser-native agent
and owns Chrome/page authority through its extension. Treating either as a UI
for the other would blur permissions, exclude people who do not use the Mac
app, and make browser automation depend on desktop Accessibility heuristics.

They still need to cooperate. A person should be able to ask from the Mac and
explicitly delegate browser work to an installed extension without moving
cookies, page credentials, Chrome permissions, or browser execution into the
Mac app.

## What Changes

- Establish `MoaMac` and the browser extension as separately installable,
  separately usable products with distinct identities, onboarding, UI,
  permissions, release artifacts, and local authority.
- Keep the Mac interaction a native compact companion. Do not embed the
  extension UI or require an extension for ordinary Mac conversation and
  macOS-local work.
- Keep the browser interaction browser-native. Do not require the Mac app for
  browser conversation, page context, or browser delegation.
- Reuse the gateway device-client and tool-request queue as the only v1 bridge.
  A Mac-originated browser delegation targets a specific compatible browser
  device and remains an inert request until the extension claims it.
- Bind every request to a stable account/session, source Mac device, target
  browser device, user-confirmed intent, bounded browser scope, expiry, and
  idempotency key.
- Let the extension independently revalidate browser state, request any
  browser-local approval, execute with browser-local authority, and post
  progress plus terminal receipts.
- Project the same request/run/receipt identities to both products while each
  renders them using its own UI.
- Fail visibly and safely when the extension is absent, offline, stale,
  incompatible, or declines the request. Never silently substitute macOS
  Accessibility automation or another browser device.

## First Milestone

From the Mac companion, a user can explicitly ask to open one HTTPS URL in a
selected online browser extension. The gateway records a targeted request, the
extension claims and validates it, Chrome opens the tab, and both products can
show the same terminal receipt. An offline target remains visibly queued until
expiry or cancellation and causes no local side effect.

Multi-step delegated browser runs, page evidence transfer, automatic target
selection, shared visual components, and desktop fallback automation are out of
scope for this milestone.

## Capabilities

### New Capabilities

- `macos-browser-product-bridge`: explicit, identity-bound delegation from the
  native Mac companion to an independently authorized browser extension.

## Impact

- Mac product: delegation affordance and request/progress presentation only.
- Gateway: existing device-client registry, targeted tool-request queue, and
  receipt projection; no browser execution.
- Browser product: claim, local validation/approval, execution, progress, and
  receipt presentation.
- Architecture: cooperation shares durable work identity, not UI code,
  platform permission, local context, or execution authority.
