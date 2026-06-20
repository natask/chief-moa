# Design — thin client + persistent engine

## The decision

The browser extension is a **thin client**. A **persistent engine** (the gateway,
hosted by us or self-hosted by the user) is the single authority for execution,
secret custody, state, and deployment. The browser routes all meaningful actions
through the engine **even when it could make the call directly**.

## Why the browser cannot be the authority (the MV3 constraint)

Manifest V3 bans remotely-hosted executable code in the extension's privileged
context (service worker + extension pages); all executable code must ship in the
Web Store package. Consequences that pin the architecture:

- You **cannot** push new extension logic (`background.js`/`content.js`) to end
  users out-of-band. The extension is never the unit a user "deploys" into.
- MV3 **does** permit fetching/caching remote **configuration** (e.g. JSON) at
  runtime — so customizations can travel as *data*.
- The one sanctioned arbitrary-code path is the **`userScripts` API**: isolated
  sandbox, and since Chrome 138 a **per-extension "Allow User Scripts" toggle**
  the user must flip. Real friction; reserve for opt-in power use.

Sources: Chrome for Developers — [remotely-hosted code banned](https://developer.chrome.com/docs/extensions/develop/migrate/improve-security),
[userScripts API](https://developer.chrome.com/docs/extensions/reference/api/userScripts).

## Roles

**Thin-client extension**
- Renders surfaces from engine-served specs; captures text/voice input; brokers
  page access (read DOM, act on page) for the engine.
- Holds no API keys or subscriptions — only a session token to its engine.
- Stable: changes rarely, ships via the Web Store. Not the deployment unit.

**Persistent engine (gateway)**
- Holds secrets/subscriptions; makes all model/API calls.
- Persists state (sessions, profile, customizations) — already has a per-request
  profile store under `data/` from `gateway-runtime-agent-profile`.
- Generates and serves customizations. Self-hosted, it *is* the user's persistent
  remote agent. Hosted vs self-hosted differ only in which URL the client targets.

## How a "deployment" travels (no extension repackage)

- **A. Declarative UI spec (config, not code) — backbone.** Engine stores a
  per-user UI spec (panels, buttons, fields, bound actions); the extension's
  renderer interprets it; changes live-refresh. MV3-clean, no opt-in friction,
  inspectable. Reuses the `chrome.storage.onChanged` live-refresh pattern already
  in `options.js`, widened from profile fields to UI spec.
- **B. Sandboxed iframe app — rich generated surfaces.** A sandboxed iframe whose
  content the engine serves; `postMessage`s to the extension, which brokers to the
  engine. Cannot touch privileged APIs.
- **C. `userScripts` — page-acting generated code (long tail).** Engine generates
  JS; extension runs it via `userScripts` in an isolated world, behind the
  explicit per-extension opt-in.

Recommended mix: A as backbone, B for generated rich UI, C only on explicit
opt-in. This also resolves the slider deferred in `extension-ui-self-extension`
(hand-built vs agent-generated): the platform constraint sets the boundary.

## Why route even when the browser could call directly

Durability (the engine survives tab/extension lifecycle), one place for secrets,
one place for state and history, and one place that generates/ships
customizations. A purely-in-browser path is brittle and splits the trust model.
A local BYO-key-in-browser path may remain as a developer/fallback escape hatch,
not the primary path.

## Open question (resolve before building the hosted tier)

Key/subscription custody for the **hosted** (non-self-host) tier. Self-host
sidesteps it — the user runs their own engine. Hosted means custodying users'
keys, which is real liability; options include encrypted-at-rest or
proxy-without-store. Self-host can ship first to avoid blocking on this.
