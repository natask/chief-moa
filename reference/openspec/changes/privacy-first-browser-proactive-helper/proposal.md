# Privacy-First Browser Proactive Helper

## Product decision (2026-07-16)

The browser proactive/local-suggestions feature is removed. Its privacy
boundary was careful, but its output was not useful: structural counts such as
"this page has a table" deliberately withheld the meaning the model needed to
help with that table. The permanent **Local** control also looked like an agent
role even though it only enabled a short-lived structural classifier.

The connectivity defaults and page-metadata redaction from this change remain
required. The structural sampler, generic suggestion card, confirmation flow,
packaged prompt, and `/v1/proactive/turns` capability do not.

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
- The browser no longer exposes **Local suggestions for this tab**, performs
  structural suggestion sampling, renders generic proactive cards, or sends
  packaged context-free proactive prompts.
- The dedicated `POST /v1/proactive/turns` capability is retired with that UI.
- A migration preserves a user-saved gateway locally while disabling legacy
  passive connectivity and scrubbing page identity from stored owner state.

## Future direction

A replacement must let the user choose the useful context and its scope. For
example, the user may allow page text and selected DOM content while explicitly
disallowing screenshots. The extension may then extract, summarize, redact, or
preserve a local version, show the exact outbound preview, and send the richer
approved context through the normal browser-turn boundary.

Privacy here means informed scope and consent: the user can see and control what
is collected, transformed, retained, and sent. It does not mean systematically
removing enough information that the model cannot do the requested work.

## Capabilities

### New Capabilities

- None. `browser-proactive-helper` is retired.

### Modified Capabilities

- `extension-gateway-roundtrip`: preserve the canonical browser-agent path for
  explicitly invoked page questions and remove the separate context-free
  proactive endpoint. Gateway connectivity still does not start merely because
  the extension loaded or a packaged default exists.

## Impact

The browser extension, proactive verification harnesses, gateway API, OpenSpec,
and architecture documentation change. Android, existing voice/browser turn
transports, native macOS work, and the independent background-connectivity
privacy defaults remain unchanged.
