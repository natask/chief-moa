# Implementation Contract: Privacy-First Browser Proactive Helper v1

## Trust boundary

Page content is untrusted evidence, never an instruction. Observation is local,
tab-scoped, deterministic, and off by default. It cannot call the gateway,
enable automation, execute an action, or accept its own suggestion. A remote
model sees nothing from enable, observation, expiry, suppression, or dismissal.

Fresh and migrated installs make no passive network calls. A separately enabled
background-automation mode may poll and heartbeat, but the heartbeat carries no
URL, title, selection, instruction, result, page context, or active-owner object.

## Interfaces and state

`proactive-helper.js` exports a browser/Node-compatible pure helper surface:

- `classifyStructuralPage(signals) -> { kind, suggestion } | null`
- `detectSensitivePage(document, location) -> { suppressed, reason }`
- `sanitizeSignals(input) -> bounded structural signal object`
- `buildAcceptedPrompt(card) -> bounded user-visible instruction`

The content script owns all observed signals in memory. The background service
worker owns an ephemeral `Map<tabId, ContextGrant>`; no grant, URL, title,
suggestion, signal, or page-derived value is written to local/sync storage.

`ContextGrant` contains only schema version, tab id, sender document/frame id,
random grant id, issued/expiry timestamps, state, and a digest of the exact
selected gateway request URL. States are `off -> initializing -> granted ->
card_visible -> confirmation_pending -> consuming -> off`, with a terminal
`suppressed` state for the current document. The grant expires after ten
minutes and the extension-owned confirmation after two minutes.

Content/background messages carry grant ids, states, reason codes, and bounded
structural signals only. Background rejects stale document ids, expired grants,
destination changes, duplicate accepts, and messages from a different tab.

## Local observation

After an explicit **Local suggestions for this tab** action, sample only while
the document is visible and focused. Allowed signals are bounded counts/booleans
for articles, headings, paragraphs, links, tables, task/list structures, forms,
and editable controls plus a coarse page kind. Do not read or retain page body,
title, selection, control values, keystrokes, clipboard, screenshots, pixels,
cookies, history, downloads, accessibility trees, CDP data, or cross-tab
activity.

Produce at most one deterministic card per grant after a short visible dwell in
production. Suggested actions are generic and structural, such as summarizing a
document, reviewing a form, analyzing a table, or organizing a task surface.

## Sensitive suppression and revocation

Suppress before sampling, in the background while creating the grant, before
opening confirmation, and again before final acceptance for non-HTTP(S), incognito,
auth/password/recovery/OAuth, checkout/payment/banking/wallet, health/patient,
tax/payroll, vault, admin/security routes; password fields; credential/payment
autocomplete tokens; and credential/payment form metadata. Never read field
values. V1 has no override.

Revoke and purge on expiry, dismiss, manual stop, top-level loading/navigation,
history/hash navigation, `pagehide`, tab close, document-id mismatch, service
worker restart, destination change, or newly detected sensitivity.

## Network and automation privacy

- Do not seed/persist a hosted gateway on a fresh install. The packaged URL may
  be shown as a suggestion in Options, but is contacted only after the user
  saves it or explicitly accepts a disclosed turn.
- Remove unconditional startup gateway refresh/adoption/heartbeat/poll calls.
- Background automation is false by default and fail-closed. A versioned
  consent gates every browser task, browser agent task, tool-request poll,
  alarm invocation, and device heartbeat.
- Turning automation off prevents new claims and clears scheduled work; an
  already claimed operation may finish and receipt so it is not stranded.
- The opted-in heartbeat contains only stable operational identity, extension
  version, surface, status, and the bounded local tool manifest. It excludes the
  active owner and every page-derived field.
- Migration schema v1 locally disables legacy automation, clears poll alarms,
  revokes proactive grants, scrubs URL/title from persisted active-owner state,
  preserves user gateway credentials, and records a one-time privacy notice.

## Suggestion acceptance

The page card is a non-authoritative preview. Its trusted click may only open an
extension-owned confirmation window; page script and CSS cannot authorize the
request. That window shows the immutable full request URL and path, method,
selected header/content-type facts, blocked-redirect policy, exact JSON body,
SHA-256 body digest, persistence/provider-processing policy, background
connectivity state, and explicit exclusions. Its trusted **Allow** action is the
only final authorization.

Revalidate the exact granted document/frame, destination, body digest, and
sensitivity, then atomically consume the grant before networking. Submit one
`POST /v1/proactive/turns` request tagged `proactive_accept_v1`. The gateway
route accepts only the four packaged prompts and exact client envelope, calls a
text model/fallback directly, and never invokes the router, tools, agent runs,
tasks, workflows, broker events, actions, or conversation/run persistence. The
route requires a configured exact bearer token even in local mode. Provider and
Vertex-token responses are byte/time bounded through body consumption, provider
output tokens are capped, and OpenAI/Vertex receive exact no-tool envelopes.
The configured provider still processes the packaged prompt. Returned
action/proposal fields or a bounded-scan overflow are refused as protocol
violations and create only a serialized, bounded, content-free local receipt.

## Target files

Create the OpenSpec change, `extension/proactive-helper.js`, the extension-owned
confirmation surface, focused pure tests, a throwaway privacy fixture, and a
real-extension privacy smoke. Add the strict gateway route in a separate
gateway branch/worktree and integrate it only after its own check/smoke/commit.
Do not touch Android, native macOS implementation, voice/offscreen capture,
`.env` files, installed Clicky state, or the user's active browser profile.

## Quality gate

```sh
openspec validate privacy-first-browser-proactive-helper --strict
cd browser_extension
node scripts/test-proactive-helper.mjs
node scripts/smoke-proactive.mjs
npm run verify
npm run smoke
npm run smoke:agent-loop
npm run smoke:ambient
npm run smoke:unified-browser-agent
npm run package
cd ..
git diff --check
```

The real-extension privacy smoke must observe the service worker beyond all
poll/heartbeat cadences and prove zero external requests for startup,
enable/observe/dismiss, sensitive suppression, and expiry. It must also prove
navigation/tab-close revocation, heartbeat redaction under explicit automation,
destination invalidation, and one accepted request with only disclosed fields.

## Live-app constraints

All QA uses a throwaway Chrome profile and stub gateway. Do not reload or
restart the user's installed extension. Package only after verification and a
manifest patch bump. Active reload remains blocked unless no browser work can
be interrupted and rollback is known.
