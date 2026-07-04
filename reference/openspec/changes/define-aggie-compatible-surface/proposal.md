## Why

Aggie is the personal agent interface. Moa is one family of surfaces where
Aggie can appear.

The existing Chief Moa architecture already has the pieces that make this the
right home: Android overlay, browser extension, gateway voice sessions, durable
broker events, profile state, agent runs, and launcher profiles. What is missing
is the naming and protocol boundary. Without that boundary, the browser/mobile
surfaces look like the product, and backend experiments such as Hermes or
OpenClaw risk owning the user experience.

Decision: **Aggie owns the canonical session, routing, policy, backend adapter
selection, events, approvals, and artifacts. Moa browser/mobile/desktop are
compatible surfaces. Agent runtimes are backend adapters.**

## What Changes

- Define Aggie as the canonical personal-agent session layer inside Chief Moa's
  gateway/control-plane architecture.
- Treat Moa browser, Moa Android, Moa desktop, CLI, and messaging clients as
  surfaces that send turns into Aggie and subscribe to session events.
- Require compatible surfaces to support text turns, voice turns, session
  resume, run status, approval prompts, and artifact viewing.
- Keep LiveVoice in the surface contract. If a backend does not support native
  voice, Aggie owns STT/TTS and passes text/events to the backend adapter.
- Define a backend adapter contract so Hermes, OpenClaw, Codex, Claude, Gemini,
  OpenCode, Ralph, or local runtimes can do work without owning the product
  session.
- Clarify that the MOA browser integration is a surface adapter over the
  existing thin-client gateway path, not a separate canonical chat store.

## Capabilities

### New Capabilities

- `aggie-canonical-session`: Aggie stores canonical sessions, turns, live voice
  events, route decisions, run links, approval requests, artifacts, and
  subscribed surface state.
- `aggie-compatible-surface`: A client can be an Aggie surface if it implements
  the required turn, LiveVoice, resume, status, approval, and artifact affordances.
- `aggie-backend-adapter`: A runtime can be an Aggie backend if it implements
  health, start, turn, resume, cancel, and artifact calls without taking over the
  canonical session.
- `moa-browser-surface-adapter`: The existing browser extension/MOA browser path
  sends page context, text, and voice into Aggie through the gateway and renders
  returned events/actions.

## Impact

- Gateway: namespace/facade for Aggie turns, live voice, sessions, events,
  approvals, artifacts, and backend adapters. Existing `/v1/voice/*`,
  `/v1/broker/messages`, and agent-run routes can back the first slice.
- Browser/MOA: integrate as an Aggie surface through the thin-client gateway
  route. The browser remains a stable client and never owns provider keys or
  canonical chat history.
- Android/Desktop: integrate as Aggie surfaces that share the same session and
  event stream.
- Agent runtimes: expose adapter metadata and capabilities rather than dictating
  the user-facing protocol.
- Naming: `Aggie` is canonical. Historical `Agee` spelling in older files is
  legacy and should be normalized opportunistically when touched.
