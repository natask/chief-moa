# Architecture: AG Browser Prototype

AG starts as a Chrome Manifest V3 extension because the browser is the smallest surface where a user-owned interface can appear on top of real work and, when explicitly asked, experiment with page-aware actions.

## Goals

- User-owned and open source.
- Thin client for a self-hosted or hosted agent gateway.
- Provider keys, subscriptions, model routing, and durable state live on the
  gateway, not in the browser.
- Browser-native interface first, with a path to desktop/Moa/local runtimes later.
- No sidebar as the primary surface.
- Keep extension development on a dedicated dev bridge page and localhost demo page.
- Simple enough to load unpacked and review today.
- Constrained enough that the model cannot execute arbitrary code.

## Non-Goals For This Version

- Full cross-tab autonomous browsing.
- A standalone browser agent product identity.
- Sidebar-first UX.
- Account/payment/password workflows.
- Cross-origin iframe control.
- Native dialogs, file pickers, browser UI, or restricted browser pages.
- Hosted billing, usage caps, or telemetry.
- Extension marketplace polish.
- Remote JavaScript updates.

## Runtime Boundaries

### Content Script

Files:

- `extension/content.js`
- `extension/overlay.css`

Responsibilities:

- Render the command overlay.
- Render the on-page invocation surface.
- Accept typed input and control browser voice state.
- Collect visible interactable page elements.
- Execute constrained page actions.
- Show progress, completion, and errors.

The content script is the only component that touches the page DOM. It must not
request microphone access from the page origin; browser voice capture belongs to
the extension offscreen document so Chrome grants the microphone to the
`chrome-extension://` origin rather than to each website.

The packaged manifest currently injects the inert UI shell on matching pages so
the on-page mark and hotkeys are immediately available. Injection is not an
observation grant. The removed Local-suggestions mode no longer samples page
structure or renders generic proactive cards. Automated QA uses only localhost
fixtures in a throwaway profile.

### Background Service Worker

File:

- `extension/background.js`

Responsibilities:

- Read gateway connection settings from `chrome.storage.local`.
- Run the local, network-free privacy migration before any optional background
  connectivity.
- Capture visible-tab screenshots.
- Route commands, describe requests, profile updates, and agent work to the
  configured gateway.
- Validate and translate gateway-proposed actions into content-script actions.
- Handle the extension keyboard command.
- Own the gateway voice WebSocket proxy and coordinate extension-owned
  offscreen microphone capture.

The background worker does not hold provider API keys and does not call model
vendors directly. It holds only the engine URL/session token needed to reach the
gateway. It does not contact that gateway merely because the worker loaded.
Remote task/tool polling and heartbeat require current, versioned background
automation consent; missing or unreadable consent fails closed. Heartbeat never
contains page URL/title or the active-owner object.

The existing command composer is injected into ordinary page DOM. A host page
can inspect or interfere with that light-DOM UI, just as it can observe
keystrokes elsewhere in its own document. Do not treat the on-page composer as
a confidential input surface; sensitive command entry belongs in the
extension-owned side panel.

### Offscreen Voice Document

Files:

- `extension/offscreen.html`
- `extension/offscreen.js`

Responsibilities:

- Request microphone audio from the extension origin with `getUserMedia`.
- Convert microphone samples to PCM16 at 16 kHz.
- Send PCM chunks back to the background service worker for the existing
  gateway voice WebSocket.
- Stop capture when the current voice session is committed, canceled, revoked,
  or closed.

The offscreen document exists only to keep microphone permission extension-owned.
If Chrome has not granted microphone access to the extension yet, the user grants
it from the options page once.

### Options Page

Files:

- `extension/options.html`
- `extension/options.js`

Responsibilities:

- Save the user's gateway URL/token locally.
- Show the packaged hosted destination as a suggestion without silently saving
  or contacting it.
- Keep background connectivity/automation off until current disclosure is
  accepted.
- Seed/check the one-time extension microphone permission.
- Read and write gateway-owned runtime profile fields such as system prompt,
  model selection, temperature, language, and voice settings.
- Explain that provider credentials live on the gateway, not in the browser.

### Dev Bridge

Files:

- `extension/dev.html`
- `extension/dev.js`
- `scripts/dev-extension.mjs`

Responsibilities:

- Run development against `http://localhost:7777/fixtures/demo.html`, not arbitrary active tabs.
- Poll the local dev server for file-change versions.
- Call `chrome.runtime.reload()` when extension files change.
- Reload only localhost / 127.0.0.1 demo tabs so content scripts re-inject with the latest code.
- Keep normal browsing outside the development loop.

The dev bridge is an extension page, not a content script. It has access to extension APIs and can reload the extension, while the demo page stays a disposable target for testing page UI and actions.
It is a developer-only convenience for unpacked-extension work, not a user-facing
promotion, deployment, or customization path.

## Message Contract

Current messages are intentionally small:

```ts
type OverlayToWorker =
  | { cmd: "run"; instruction: string }
  | { cmd: "cancel" };

type WorkerToContent =
  | { cmd: "ping" }
  | { cmd: "toggle" }
  | { cmd: "open" }
  | { cmd: "confirm"; text: string }
  | { cmd: "snapshot" }
  | { cmd: "act"; action: Action; index?: number; text?: string; url?: string; direction?: "up" | "down" }
  | { cmd: "progress"; text: string }
  | { cmd: "done"; summary: string }
  | { cmd: "error"; text: string };

type Action =
  | "click"
  | "type"
  | "clear"
  | "select"
  | "scroll"
  | "navigate"
  | "key"
  | "wait";
```

Current hardening:

- One active task is allowed per tab.
- The overlay has a stop control that cancels the current task.
- Risky DOM actions and cross-origin navigation ask for user confirmation.
- Non-HTTP(S) navigation is blocked.
- Task status is checkpointed to `chrome.storage.local` after major steps so a worker interruption leaves evidence of the last known state.
- Page content can produce evidence after explicit invocation; it cannot enable
  observation, grant authority, enable automation, or execute an action.

Next hardening step:

- Wrap all messages in a typed envelope with `id`, `version`, `source`, `tabId`, `frameId`, `origin`, and `createdAt`.
- Add structured error codes such as `NO_ACTIVE_TAB`, `NO_PERMISSION`, `MODEL_TIMEOUT`, and `ACTION_TARGET_NOT_FOUND`.
- Persist a resumable conversation state without storing large screenshot payloads.

## Context And Execution-Adapter Discovery

The extension's existing device-client heartbeat advertises two separate
concepts to the gateway:

- `local_tool_manifest` remains the fixed, locally validated execution
  vocabulary. Opening a particular site does not create new model tools.
- `metadata.context_descriptor` identifies the active web application by
  hostname and origin, with a bounded title. It never includes the full URL,
  query, fragment, DOM, page text, screenshot, cookies, or incognito identity.
- `metadata.execution_adapters` advertises the existing `browser_session`
  execution channel and its bounded modes. It records auth as `not_inspected`:
  an open page is not proof that the user is logged in.

This discovery record lets gateway routing prefer an already-running browser
session when the active web application is relevant. Detailed page context is
still collected only through the explicit evidence flow, and every proposed
effect is still checked by the extension before execution.

## Agent Loop

1. User opens overlay with Cmd/Ctrl+, through the extension command. On the localhost demo page, the content script shortcut also works directly.
2. User enters a typed or spoken instruction.
3. Content script sends `{ cmd: "run", instruction }`.
4. Background asks content script for a fresh snapshot.
5. Background captures a visible-tab screenshot.
6. Background sends instruction, DOM affordances, and screenshot to the gateway.
7. The gateway/model returns an answer, run status, or action proposal.
8. Background validates any proposed action and executes it through the content script or tab API.
9. Background waits briefly, refreshes snapshot/screenshot, and continues.
10. Loop ends when the model calls `finish`, errors, or hits the step limit.

This loop is experimental capability. The product frame remains a browser-native interface that can host multiple workflows, not an autonomous browser agent whose default behavior is to take over tabs.

## Gateway-Queued Browser Tasks

Gemini Live and other gateway agents can enqueue browser work as durable
`/v1/browser/tasks` records. Only after current versioned background-automation
consent, the extension polls `/v1/browser/tasks/claim`,
claims one pending task at a time, executes allowlisted Chrome DevTools Protocol
methods through `chrome.debugger` in a disposable background tab, and posts a
receipt to `/v1/browser/tasks/:id/receipts`.

The gateway stores the request, claim, and receipt; the extension owns the actual
browser-side execution. A receipt includes compact action results, page state,
and screenshot metadata. Raw provider keys stay out of the browser, and raw
screenshot payloads are not posted back in receipts.

## Context Sharing Direction

The structural **Local suggestions** helper is removed. It protected page data
by discarding the meaning that would have made the model useful, and its label
confused a context-handling choice with an interaction role.

A future replacement should begin with an explicit user request and concrete
context controls. The user may include page text or a selection while excluding
a screenshot. Local extraction may summarize, redact, or preserve a local
version. Before release, an extension-owned review surface should distinguish
the source, the local transformed/retained representation, the exact outbound
payload, and the destination. The user can edit, approve, or cancel; approved
context then uses the normal browser-turn path.

Privacy means informed scope and consent. It does not require sending less
information when the user deliberately wants richer model understanding.

## Security Rules

- Never execute model-generated JavaScript.
- Never inject remote code.
- Do not update executable extension behavior from a website.
- Keep provider API keys and subscriptions out of the extension entirely.
- Route model/API-backed actions through the configured gateway.
- Capture screenshots only after user invocation.
- Make no gateway call on fresh/default extension startup or privacy migration.
  A persisted current background-automation opt-in intentionally starts
  polling/heartbeat.
- Default background automation off and gate every task/tool/agent poll,
  alarm, and heartbeat with current versioned consent.
- Never put page or active-owner metadata in heartbeat.
- For future context sharing, expose concrete context types and exact outbound
  preview; support useful no-screenshot choices and explicit approval.
- Restrict model actions to the explicit action DSL.
- Block non-HTTP(S) navigation.
- Confirm cross-origin navigation.
- Reject concurrent tasks in the same tab.
- Execute gateway-queued CDP tasks only through the allowlisted method set and
  always return a receipt.
- Treat screenshots and prompts as sensitive user data.
- Treat broad manifest access as capability, not consent; page reads and actions
  still require the narrow invocation/grant defined for their path.

## Customization Boundary

Safe to update from the app:

- Theme settings.
- Shortcut preferences where Chrome allows user control.
- Overlay placement and density.
- Prompt templates.
- Declarative tweaks and workflow definitions.

Not safe to update from the app:

- Arbitrary JavaScript loaded from a website.
- Extension service-worker code.
- Content-script code.
- Permission grants without explicit Chrome approval.

If userScripts are added later, they should be an explicit opt-in path with a walkthrough, a clear permission gate, and user-owned scripts stored locally or in an account the user controls.

## Review Checklist

- Manifest parses as valid JSON.
- Extension JavaScript passes syntax checks.
- Cmd/Ctrl+, works through the Manifest `commands` entry point.
- Localhost demo content-script path works for automated smoke tests.
- Developer-only dev bridge reloads the unpacked extension when `extension/`
  files change.
- Dev bridge touches only localhost / 127.0.0.1 test tabs.
- Options page stores and reloads gateway URL/token settings.
- Runtime profile settings read/write through gateway endpoints.
- Fresh/default state makes no passive gateway request and background automation
  is off/fail-closed.
- No Local suggestion control, structural sampler, proactive card, confirmation
  flow, or proactive request remains.
- Screenshot capture path lives in the background worker.
- Gateway-routed action proposals use a constrained action schema.
- Content script can snapshot visible affordances.
- Content script can click/type/scroll/select without arbitrary code execution.
