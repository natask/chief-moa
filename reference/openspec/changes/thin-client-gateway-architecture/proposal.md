## Why

The product needs one load-bearing architectural decision settled before more
extension work: **where does execution, state, and deployment actually live?**

Two forces converge on the same answer. First, a hard platform constraint:
Chrome Manifest V3 bans remotely-hosted executable code in an extension's
privileged context (service worker + extension pages) — all executable code must
ship inside the Web Store package. So an extension can never be the unit a user
"deploys" their customizations into out-of-band; you cannot push new
`background.js`/`content.js` to end users by any means. MV3 does allow fetching
and caching remote *configuration* at runtime, and exposes exactly one sanctioned
arbitrary-code path: the `userScripts` API, sandboxed and behind a per-extension
opt-in.

Second, experience: even where the browser *can* make a model/API call directly,
it should be routed through a persistent engine anyway — for durability, for a
single place to hold secrets and subscriptions, and for a single place to persist
state and generate/ship customizations. A purely-in-browser design does not hold
up; anything else does not make sense.

Decision: **the browser extension is a thin client; a persistent engine is the
single authority for execution, secret custody, state, and deployment.** This
change records that decision and its boundaries before code moves, and reframes
the deferred extension changes around it.

## What Changes

- Establish the extension as a **thin client**: it renders surfaces from
  engine-served specs, captures text/voice input, and brokers page access. It
  does not hold API keys/subscriptions and is not the deployment unit.
- Establish the **persistent engine** (the gateway, hosted or self-hosted) as the
  single authority: it holds secrets/subscriptions, makes model/API calls,
  persists state, and generates + serves customizations. The browser routes all
  meaningful actions through it even when it could call a provider directly.
- Define how a user "deployment" travels without touching the extension package:
  (A) a declarative UI spec served as remote config; (B) a sandboxed iframe app
  the engine drives; (C) `userScripts` for page-acting generated code, gated
  behind explicit per-extension opt-in.
- Reframe `extension-gateway-roundtrip`, `extension-settings-voice-control`, and
  `extension-ui-self-extension` as "thin client + engine-as-deploy-target," and
  demote the local disk-reload loop to a developer-only convenience (off the
  user-facing path).

## Capabilities

### New Capabilities

- `thin-client-extension`: The extension is a stable thin client — renders
  engine-served surfaces, captures input/voice, brokers page access, holds no
  secrets, and is not the deployment unit.
- `persistent-engine-authority`: A persistent engine is the single authority for
  model/API calls, secret/subscription custody, state persistence, and
  customization generation; the browser routes meaningful actions through it.
- `engine-served-customization`: User customizations and "deployments" travel as
  engine-served declarative config and, for the long tail, sandboxed/opt-in
  generated scripts — never as new extension package code.

## Impact

- Architectural decision record (`design.md`) — no behavior change on its own.
- Reframes `extension-gateway-roundtrip`, `extension-settings-voice-control`,
  `extension-ui-self-extension`; builds on `gateway-runtime-agent-profile` (the
  engine already persists a per-request profile under `data/`).
- `software/browser_extension/extension/` (background.js routing, options/settings
  surface, a renderer) and `software/moa_gateway` (secret custody, customization
  store + serving). Hosted vs self-hosted both point the client at an engine URL.
- Open question deferred to `design.md`: key/subscription custody for the hosted
  (non-self-host) tier.
