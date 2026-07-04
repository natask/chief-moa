# Design - Aggie-Compatible Surface

## Product Boundary

Aggie is the personal-agent layer. It is not Moa, Hermes, OpenClaw, a model
provider, or a single client.

Moa browser, Moa Android, Moa desktop, CLI, Telegram, WhatsApp, SMS, and any
future control surface can speak to Aggie. Agent runtimes such as Hermes,
OpenClaw, Codex, Claude, OpenCode, Gemini, Ralph, or local model gateways can do
work for Aggie through backend adapters.

```text
voice/text/page/context
  -> compatible surface
  -> Aggie session router
  -> policy + skill/workflow selection
  -> backend adapter
  -> run/event/artifact store
  -> subscribed surfaces
```

## Relationship To Existing Chief Moa Pieces

Chief Moa is still the correct repo because the existing gateway already owns
the persistent engine responsibilities:

- Android overlay captures voice/text and local permission state.
- Browser extension/MOA browser captures page context, text, voice, and browser
  affordances as a thin client.
- Gateway owns provider credentials, routing, profile state, voice sessions,
  broker events, agent runs, tool catalog, storage, and launcher profiles.
- Execution machines own Codex/Gemini/Claude/OpenCode/Hermes/OpenClaw harnesses.

Aggie is the named contract over those pieces. It should initially be a facade
over the current broker, voice, and agent-run routes rather than a second
parallel gateway.

## Canonical Objects

### Session

One durable personal-agent conversation/work graph. It is shared across
surfaces.

```json
{
  "id": "sess_personal_default",
  "title": "Aggie",
  "owner_id": "local-user",
  "policy_id": "aggie/default",
  "active_backend": "hermes",
  "created_at": "2026-06-24T00:00:00.000Z",
  "updated_at": "2026-06-24T00:00:00.000Z"
}
```

### Surface

The input/output layer currently talking to Aggie.

```json
{
  "id": "moa-browser",
  "kind": "browser",
  "capabilities": ["text", "live_voice", "page_context", "approvals", "artifacts"]
}
```

### Turn

An inbound user message or voice event. A turn is stored once, then routed.

```json
{
  "id": "turn_01",
  "session_id": "sess_personal_default",
  "surface": {
    "id": "moa-browser",
    "kind": "browser",
    "mode": "text"
  },
  "input": {
    "kind": "text",
    "text": "research this before implementation"
  },
  "context": {
    "repo": "/Users/natnaelkahssay/projs/chief-moa",
    "url": "https://example.com",
    "page_title": "Example",
    "screen_ref": null
  },
  "created_at": "2026-06-24T00:00:00.000Z"
}
```

### Live Voice Turn

LiveVoice is part of the surface contract. Backend support is optional because
Aggie can own STT/TTS.

```json
{
  "id": "turn_voice_01",
  "session_id": "sess_personal_default",
  "surface": {
    "id": "moa-android",
    "kind": "mobile",
    "mode": "live_voice"
  },
  "input": {
    "kind": "audio_stream",
    "encoding": "pcm_s16le",
    "sample_rate_hz": 16000,
    "channels": 1
  }
}
```

### Run

Backend work launched from a turn.

```json
{
  "id": "run_01",
  "session_id": "sess_personal_default",
  "turn_id": "turn_01",
  "backend": "hermes",
  "workflow": "landscape-research",
  "status": "running",
  "created_at": "2026-06-24T00:00:00.000Z"
}
```

### Artifact

Output produced by a run and visible to subscribed surfaces.

```json
{
  "id": "artifact_01",
  "run_id": "run_01",
  "kind": "markdown",
  "title": "Research report",
  "path": "scratch/aggie/runs/run_01/report.md"
}
```

## Surface API Shape

The first implementation can map these routes to existing Chief Moa endpoints.
The point is to stabilize the contract surfaces speak, not to duplicate storage.

### Text Turn

```http
POST /v1/aggie/turns
content-type: application/json
```

```json
{
  "session_id": "sess_personal_default",
  "surface": {
    "id": "moa-browser",
    "kind": "browser",
    "mode": "text"
  },
  "input": {
    "kind": "text",
    "text": "implement this spec"
  }
}
```

Initial backing route: `POST /v1/broker/messages`, with returned route decisions
linked to agent-run and voice/chat responses as needed.

### LiveVoice

```http
WS /v1/aggie/live
```

Client sends:

```json
{
  "type": "start",
  "session_id": "sess_personal_default",
  "surface": {
    "id": "moa-android",
    "kind": "mobile",
    "mode": "live_voice"
  },
  "audio": {
    "encoding": "pcm_s16le",
    "sample_rate_hz": 16000,
    "channels": 1
  }
}
```

Server emits:

```json
{ "type": "transcript_delta", "text": "research the" }
{ "type": "transcript_final", "text": "research the best backend for this" }
{ "type": "route", "workflow": "landscape-research", "backend": "hermes" }
{ "type": "run_started", "run_id": "run_01" }
{ "type": "assistant_text", "text": "I started the research run." }
{ "type": "assistant_audio", "encoding": "pcm_s16le", "sample_rate_hz": 24000 }
{ "type": "turn_done" }
```

Initial backing route: `WS /v1/voice/sessions` or `POST /v1/voice/turns`,
depending on whether the surface can stream audio.

### Session Events

```http
GET /v1/aggie/sessions/:session_id/events
accept: text/event-stream
```

Event types:

- `turn.created`
- `turn.transcript_delta`
- `turn.transcript_final`
- `route.selected`
- `run.queued`
- `run.running`
- `run.needs_approval`
- `run.completed`
- `run.failed`
- `artifact.created`
- `message.created`

## Backend Adapter Contract

A backend adapter lets Aggie invoke an agent runtime without letting that runtime
own the whole product.

Required calls:

```text
health() -> backend status
startRun(request) -> run handle
sendTurn(session, turn) -> assistant message or run event stream
resumeRun(run_id) -> stream
cancelRun(run_id) -> terminal event
listArtifacts(run_id) -> artifacts
```

Required metadata:

```json
{
  "id": "hermes",
  "display_name": "Hermes",
  "supports": {
    "text": true,
    "live_voice": false,
    "sessions": true,
    "tools": true,
    "skills": true,
    "artifacts": true,
    "approvals": false
  }
}
```

If `live_voice` is false, Aggie still supports LiveVoice at the surface by
running STT/TTS around text turns.

## MOA Browser Surface Integration

The MOA browser integration should be implemented as an Aggie surface adapter:

- Capture command text, voice, current URL, page title, selected text, and
  allowed page context.
- Send turns through the gateway/Aggie route with `surface.id = "moa-browser"`.
- Subscribe to session events and render assistant text, run status, approvals,
  and artifact links.
- Keep provider keys and canonical chat history out of the browser.
- Treat generated page actions as proposals that the browser validates before
  execution.

This aligns with `thin-client-gateway-architecture`: the browser remains a
stable thin client, and the persistent gateway/Aggie layer is the deployment and
state authority.

## Routing Policy

Aggie must classify before acting:

1. direct chat
2. research
3. coding
4. QA
5. design
6. writing
7. approval-required action
8. backend choice
9. surfaces to notify

Research is required before implementation when the request touches:

- architecture
- agent routing
- deployment
- persistent policy
- new backend adapters
- third-party agent runtimes
- repeated failures
- broad product behavior

## Non-Goals

- Aggie is not Moa.
- Aggie is not Hermes.
- Aggie is not OpenClaw.
- Aggie is not a new model provider.
- Aggie does not force every backend to implement native voice.
- Aggie does not split chat history by surface.
- Aggie does not let backend model output perform hidden device or browser
  actions.

## First Build Target

Build Aggie as the session and surface protocol first:

1. Implement text turns as a facade over broker messages.
2. Implement LiveVoice turns as a facade over voice sessions/turns.
3. Store sessions, turns, runs, events, approvals, and artifacts with canonical
   Aggie identifiers.
4. Add an echo backend adapter.
5. Add a Hermes or OpenClaw adapter after the echo path works.
6. Add MOA browser as one surface adapter, not the owning product.
