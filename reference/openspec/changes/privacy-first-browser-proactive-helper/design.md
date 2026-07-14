# Design

## Data-flow boundary

```text
explicit tab grant
  -> sensitive-page preflight
  -> bounded structural counts in content-script memory
  -> deterministic local classifier
  -> one non-authoritative local suggestion card
  -> dismiss/expire/revoke: purge, no network
  -> trusted page activation may open extension-owned confirmation
  -> immutable canonical disclosure + trusted Allow activation
  -> exact document/frame/sensitivity/destination revalidation
  -> atomically consume confirmation and grant
  -> one POST /v1/proactive/turns request, no page snapshot or action capability
```

The page is untrusted evidence. No page string can enable observation, accept a
card, authorize a request, enable automation, or become an executable command.
Every proactive control embedded in the page ignores synthetic activation. The
page card is a preview only: its trusted Review activation may open
`proactive-confirm.html`, but the final Allow control and canonical disclosure
live in that extension-owned window. Page script or CSS therefore cannot alter
the authoritative disclosure or authorize a request.

## Grant lifecycle

The service worker keeps an ephemeral map keyed by tab id. A grant binds a
random id to the exact top-level `sender.documentId` and `sender.frameId`, a
ten-minute expiry, and a digest of the exact configured request URL.
Content-derived signals remain only in the content script. Neither side writes
page-derived data or grants to local/sync storage.

States are `off`, `initializing`, `granted`, `card_visible`,
`confirmation_pending`, `consuming`, `off`; `suppressed` terminates the current
document. A provisional `initializing` grant exists before asynchronous
destination work so navigation can revoke it. Top-level load/navigation,
history/hash navigation, `pagehide`, tab close, document/frame mismatch, expiry,
dismissal, service-worker restart, sensitivity, destination changes, or entry
into a normal command, voice, ambient, or agent workflow purge the grant and any
pending confirmation.

The worker revalidates the exact document/frame and sensitivity immediately
before it creates the extension-owned confirmation. It repeats those checks,
plus confirmation identity, expiry, immutable body digest, and exact destination
digest, after the user presses Allow. With no asynchronous boundary remaining,
it changes the matching confirmation and grant to `consuming`, deletes the
grant, and retains only an inert in-flight confirmation status until the bounded
request settles. Concurrent decisions therefore cannot issue a second request,
and the original page can detect expiry or a service-worker restart.

## Observation vocabulary

The classifier may receive only clamped counts/booleans for articles, headings,
paragraphs, links, tables, lists/tasks, forms, and editable controls. It maps
those signals to a coarse enum such as `document`, `research`, `table`, `form`,
`task`, or `general`. It receives no title, URL, selected text, body text,
control value, screenshot, accessibility tree, cookie, history, clipboard,
keystroke, or cross-tab activity.

URL and DOM attribute names may be checked ephemerally only for hard-sensitive
markers. Matching values are not recorded; only a bounded reason code is shown.

## Connectivity migration

Privacy schema v1 runs locally before any network-capable startup work. It turns
legacy background automation off unless current versioned consent exists,
clears its poll alarm, revokes proactive state, and removes URL/title fields
from persisted active-owner state. Existing user-saved gateway credentials stay
on device. A packaged destination is a UI suggestion, not an implicitly saved
or contacted endpoint.

Explicit background consent gates task, agent-task, and tool-request claimers,
their alarm path, and heartbeat. The opted-in heartbeat includes operational
identity and a bounded manifest only; it excludes the active-owner object and
all page-derived fields.

The proactive UI reads this consent as an explicit `enabled` or `disabled`
background-connectivity state. That state is informational and separate from
the tab grant: neither state authorizes the other, and other explicitly invoked
workflows may still connect independently.

## Acceptance boundary

The page card may preview the expected destination and packaged prompt, but it
is explicitly non-authoritative. The extension-owned confirmation renders the
immutable request assembled by the worker:

- exact configured HTTP(S) URL ending in `/v1/proactive/turns` (production
  destinations use HTTPS; loopback HTTP is allowed for isolated QA);
- `POST`, `Content-Type: application/json`, bearer-authorization presence with
  its value hidden, and `redirect: error`;
- the exact JSON body and its SHA-256 digest;
- Chief Moa retention exclusions and the warning that the configured model
  provider still processes the packaged prompt under its own data policy;
- the complete excluded categories, including page/screen/context, observed
  structural counts, and action/task/workflow/agent instructions.

The body has exactly `source: proactive_accept_v1`, one allowlisted packaged
`transcript`, `modality: text`, and the fixed browser `client` object. It has no
screen, evidence, page, current-work, action, task, workflow, broker, or agent
fields. There is no client retry, and `redirect: error` prevents forwarding the
approved body to another URL. This is a generic text request, not a current-page
question or browser-agent turn.

`POST /v1/proactive/turns` is a separate server-enforced capability. The gateway
always requires a configured exact bearer token (including local mode), requires
the exact top-level/body shapes and packaged transcript allowlist,
rejects unknown fields and oversized bodies, and invokes the configured model
provider directly with a single fixed-system/single-user text-only envelope.
Both provider paths have hard output-token/response-byte caps and an abort
deadline covering headers and body consumption; Vertex token exchange is also
timed and bounded. It does not enter the voice
or browser-turn router, expose tools, start agent runs, create tasks/workflows,
publish broker events, or persist a conversation/turn. The configured provider
still receives and processes the packaged prompt; this endpoint is not a claim
of provider-side non-retention.

The response schema is bounded text with an empty action capability. Any
returned `action`, `actions`, `proposal`, or `proposals` key—including a null or
deeply nested value—is a protocol violation. A depth/node-limit truncation while
checking is also a violation. The extension refuses the whole response, stores
only a bounded content-free local refusal receipt through serialized writes,
never executes or preserves the field, and makes no second network request. A
future implementation that preserves a real browser action proposal must use
the normal browser-turn validation and receipt route instead.

## Resource boundary

Classification performs one bounded traversal only after a visible-page dwell.
It clamps every counter at 100, stops traversal once all counters are saturated,
and does not install an unbounded mutation observer. If no card matches, local
observation and its timers stop. Grant expiry, visibility/focus changes,
navigation events, and explicit status/revocation messages drive the remaining
lifecycle; at most one card and one confirmation exist for a grant.

## Rollout

Verification uses headless Chrome for Testing, a temporary browser profile, a
fixture page, and a stub gateway. It proves synthetic page/confirmation clicks
cannot authorize, hostile page DOM/CSS cannot replace the extension-owned
disclosure, exact document/frame checks survive races, navigation and normal
workflows revoke, redirect responses fail, concurrent Allow decisions send at
most one request, and every disclosed field matches the captured request. No
installed extension is reloaded.

Gateway smoke runs the candidate endpoint on an isolated port and data store. It
proves the valid allowlisted request returns bounded text, malformed/extra/page
or action fields and unrecognized prompts fail closed, provider/model invocation
is direct, and conversation, task, workflow, broker-event, and agent-run stores
remain unchanged. The manifest patch version and packaged zip provide browser
rollback; active browser reload and gateway promotion remain held until their
separate live-session, preview, backup/restore, compatibility, and rollback
gates are proven.
