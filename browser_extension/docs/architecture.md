# Architecture: Agee Browser Prototype

Agee starts as a Chrome Manifest V3 extension because the browser is the smallest surface where a user-owned interface can appear on top of real work and, when explicitly asked, experiment with page-aware actions.

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

- `extension/proactive-helper.js`
- `extension/content.js`
- `extension/overlay.css`

Responsibilities:

- Render the command overlay.
- Render the on-page invocation surface.
- Accept typed input and control browser voice state.
- Collect visible interactable page elements.
- Execute constrained page actions.
- Show progress, completion, and errors.
- After an explicit per-tab grant, collect only bounded structural affordance
  counts for deterministic local suggestion classification.
- Render at most one non-authoritative proactive preview. Every proactive page
  control requires a trusted activation; Review may only ask the worker to open
  the extension-owned confirmation and cannot authorize networking.

The content script is the only component that touches the page DOM. It must not
request microphone access from the page origin; browser voice capture belongs to
the extension offscreen document so Chrome grants the microphone to the
`chrome-extension://` origin rather than to each website.

The packaged manifest currently injects the inert UI shell on matching pages so
the on-page mark and hotkeys are immediately available. Injection is not an
observation grant: proactive sampling is off, page-derived proactive state is
kept in memory only, and the service worker rejects signals until the user
explicitly grants that tab/document. Restricted and sensitive pages are
suppressed. Automated QA uses only localhost fixtures in a throwaway profile.

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

For proactive help, the worker owns the ephemeral tab/document/frame grant and
pending-confirmation maps. It revalidates the exact top-frame document and
sensitivity before opening confirmation and again before sending, verifies the
immutable request URL/body digests, atomically consumes the grant and marks the
confirmation as inert in-flight status, and calls
only `POST /v1/proactive/turns` with `redirect: "error"`. It also reports the
separate background-connectivity consent as an explicit `enabled`/`disabled`
state.

### Proactive Confirmation Page

Files:

- `extension/proactive-confirm.html`
- `extension/proactive-confirm.css`
- `extension/proactive-confirm.js`

Responsibilities:

- Provide the final authorization surface from the `chrome-extension://`
  origin, isolated from page DOM and CSS.
- Render the worker's immutable exact URL, method, content type,
  authorization-presence indicator, `redirect: error` policy, JSON body, body
  SHA-256 digest, Chief Moa retention boundary, provider-processing warning,
  exclusions, and explicit background-connectivity state.
- Require trusted activation on Allow and Cancel.
- Send only a one-time opaque confirmation token and the user's decision; never
  accept request details from the web page.

The page card is a preview only. Host-page script or CSS can alter that preview,
so it is never an authority. A page activation can at most open this
extension-owned window; only its trusted Allow activation can authorize the
exact request already held by the worker.

The existing command composer is still injected into ordinary page DOM. A host
page can inspect or interfere with that light-DOM UI, just as it can observe
keystrokes elsewhere in its own document. Do not treat the on-page composer as
a confidential input surface; sensitive command entry belongs in the
extension-owned side panel. The proactive page preview therefore exposes no
gateway origin, token fact, or background-consent state.

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
  accepted. Local proactive help is enabled only by the per-tab page control,
  not an Options preference.
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
  | { cmd: "proactiveGrantStart" }
  | { cmd: "proactiveGrantStop"; grantId: string; reason: string }
  | { cmd: "proactiveGrantStatus"; grantId: string }
  | { cmd: "proactiveSignal"; grantId: string; signals: StructuralSignals }
  | { cmd: "proactiveConfirmationOpen"; grantId: string; kind: "form" | "table" | "tasks" | "document"; cueId: string }
  | { cmd: "cancel" };

type ConfirmationPageToWorker =
  | { cmd: "proactiveConfirmationDetails"; token: string }
  | { cmd: "proactiveConfirmationDecision"; token: string; decision: "allow" | "cancel" };

type WorkerToContent =
  | { cmd: "ping" }
  | { cmd: "toggle" }
  | { cmd: "open" }
  | { cmd: "confirm"; text: string }
  | { cmd: "snapshot" }
  | { cmd: "act"; action: Action; index?: number; text?: string; url?: string; direction?: "up" | "down" }
  | { cmd: "progress"; text: string }
  | { cmd: "done"; summary: string }
  | { cmd: "proactiveGrantRevoked"; grantId: string; reason: string }
  | { cmd: "proactiveConfirmationResult"; cueId: string; grantId: string; ok: boolean; summary?: string; reason?: string }
  | { cmd: "error"; text: string };

type StructuralSignals = {
  schema_version: 1;
  article_count: number;
  heading_count: number;
  paragraph_count: number;
  link_count: number;
  table_count: number;
  list_count: number;
  task_count: number;
  form_count: number;
  editable_count: number;
  button_count: number;
};

// Every count is an integer clamped to 0..100. Unknown keys are dropped.

type ProactiveRequest = {
  source: "proactive_accept_v1";
  transcript: PackagedProactivePrompt;
  modality: "text";
  client: {
    platform: "browser";
    source: "agee-extension";
    input: "text";
  };
};

// The worker, not the page, builds this exact body. The confirmation page gets
// a read-only rendering and SHA-256 digest; it sends only token + decision.

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
- Proactive grants are service-worker-memory-only, bound to tab/document, and
  consumed before a disclosed accept request.
- Page content can produce evidence or a suggestion proposal; it cannot enable
  observation, accept itself, enable automation, or execute an action.

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

## Proactive Local Helper

The proactive path is deliberately separate from the invoked page-aware agent
loop and explicit ambient upload:

1. The user grants the current tab/document for up to ten minutes.
2. Sensitive-page preflight runs before every sample.
3. `proactive-helper.js` receives only clamped structural counts/booleans and
   returns at most one deterministic generic page preview after one bounded
   visible-page traversal. If no card matches, observation and its timers stop.
4. Dismiss, expiry, navigation, tab close, history change, destination change,
   normal workflow entry, or service-worker restart purges the grant and pending
   confirmation without a proactive network request.
5. A trusted page Review activation may open `proactive-confirm.html`; it cannot
   authorize a request. The extension-owned window shows the immutable canonical
   request and requires a separate trusted Allow activation.
6. The worker revalidates the exact document/frame and sensitivity before
   opening confirmation and again before final consumption. It verifies expiry,
   destination URL digest, body digest, and record identity, then removes the
   grant and marks the confirmation consuming with no intervening await.
7. It sends one `POST /v1/proactive/turns` request with
   `source: proactive_accept_v1` and `redirect: "error"`. No screenshot, title,
   URL, body, selection, observed count, element label, form value, action, task,
   workflow, broker, or agent instruction is attached.
8. The gateway endpoint strictly allowlists the packaged body and calls the
   configured provider directly for bounded text. It always requires a
   configured exact bearer token, including in local mode. OpenAI-compatible
   and Vertex calls use exact no-tool envelopes plus output-token,
   response-byte, and end-to-end body-consumption time limits; Vertex token
   exchange is timed and bounded too. It does not enter a router,
   expose tools, start an agent/task/workflow, publish a broker event, or persist
   a conversation/turn. The provider still processes the prompt under its own
   data policy.
9. Any nested/scalar action or proposal key, null-valued key, or response-scan
   truncation is refused as a protocol violation and recorded only in a bounded,
   content-free local receipt through serialized writes.

This mode may truthfully say that **page observation stays local**. It must not
claim that the whole extension is offline when the user has separately enabled
background gateway connectivity.

## Security Rules

- Never execute model-generated JavaScript.
- Never inject remote code.
- Do not update executable extension behavior from a website.
- Keep provider API keys and subscriptions out of the extension entirely.
- Route model/API-backed actions through the configured gateway.
- Capture screenshots only after user invocation.
- Make no gateway call on fresh/default extension startup, privacy migration,
  proactive observation, suppression, expiry, or dismissal. A persisted current
  background-automation opt-in intentionally starts polling/heartbeat.
- Treat every page-hosted proactive control as untrusted unless its activation
  is trusted. Page Review can only open extension-owned confirmation; only a
  trusted Allow activation from the exact extension confirmation URL/token can
  authorize networking.
- Bind grants and confirmations to the exact top-level tab/document/frame;
  revalidate before confirmation and before atomic final consumption.
- Revoke proactive state when a normal command, voice, ambient, or browser-agent
  workflow starts.
- Default background automation off and gate every task/tool/agent poll,
  alarm, and heartbeat with current versioned consent.
- Never put page or active-owner metadata in heartbeat.
- Suppress proactive observation when the closed password/autocomplete/form/
  recognized-sensitive-route marker set matches; do not claim perfect semantic
  detection of every sensitive page.
- Restrict proactive networking to the exact disclosed
  `POST /v1/proactive/turns` request with `redirect: "error"`; never route it
  through voice/browser turns, tools, agents, tasks, workflows, or the broker.
- Refuse returned action/proposal keys and incomplete bounded scans; record only
  serialized, bounded, content-free local protocol-violation receipts.
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
- Proactive observe/dismiss has zero network and no persistent page-derived data.
- Proactive acceptance is disclosed, exactly once, text-only, and action-inert.
- Screenshot capture path lives in the background worker.
- Gateway-routed action proposals use a constrained action schema.
- Content script can snapshot visible affordances.
- Content script can click/type/scroll/select without arbitrary code execution.
