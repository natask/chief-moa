# Privacy-First Browser Proactive Helper

## Why

Proactive assistance is valuable only if the user can tell when observation is
happening, what stays local, and what leaves the machine. The existing browser
extension starts gateway polling and heartbeat work without an invocation,
defaults background browser automation on, and can include page identity in
shared owner metadata. Adding suggestion cards on top of that would reproduce
the trust failure this project is trying to avoid.

## What Changes

- Fresh and migrated installations make no passive gateway request.
- Background browser automation becomes versioned, explicit, and fail-closed;
  it gates every remote claim poll and device heartbeat.
- Heartbeats never include URL, title, instruction, result, page context, or the
  active-owner record.
- A user may explicitly grant one tab/document up to ten minutes of local-only
  structural observation.
- A deterministic local classifier creates at most one generic suggestion from
  bounded DOM affordance counts. It never reads page body text, title,
  selection, form values, screenshots, accessibility data, or cross-tab
  activity.
- Sensitive pages are suppressed. Navigation, tab close, expiry, dismissal,
  service-worker restart, normal workflow entry, and gateway-destination changes
  revoke the grant.
- The on-page card is a non-authoritative preview. Every proactive page control
  requires trusted activation, and Review can only open an extension-owned
  confirmation; only its trusted Allow control may authorize networking.
- The canonical confirmation shows the exact URL, method, content type,
  authorization presence, redirect policy, JSON body, SHA-256 body digest,
  Chief Moa retention boundary, provider-processing warning, and exclusions.
- Acceptance revalidates the exact document/frame and immutable disclosure,
  atomically consumes the grant, and sends one request to the separate
  text-only `POST /v1/proactive/turns` capability. Returned actions and
  incomplete response scans fail closed as local protocol violations.
- The gateway allowlists the packaged proactive request, calls the configured
  model directly without router/tools, and creates no conversation, broker,
  task, workflow, or agent-run record.
- A migration preserves a user-saved gateway locally while disabling legacy
  passive connectivity and scrubbing page identity from stored owner state.

## Capabilities

### New Capabilities

- `browser-proactive-helper`: explicit local observation grants, deterministic
  suggestion previews, sensitive-page suppression, extension-owned canonical
  confirmation, and disclosed exactly-once acceptance.

### Modified Capabilities

- `extension-gateway-roundtrip`: preserve the canonical browser-agent path for
  real page questions while defining and enforcing a separate, narrow,
  text-only proactive endpoint with no page evidence, router, action, agent, or
  durable-work capability. Gateway connectivity no longer starts merely because
  the extension loaded or a packaged default exists.

## Impact

The browser extension, its extension-owned confirmation page, settings copy,
focused verification/smoke harnesses, the gateway API and isolated gateway
smoke, and architecture documentation change. Android, existing voice/browser
turn transports, native macOS work, and the user's active extension remain
untouched. This slice ships as an isolated gateway candidate and browser package
artifact first; active promotion requires the separate live-session and
stateful-service safety evidence.
