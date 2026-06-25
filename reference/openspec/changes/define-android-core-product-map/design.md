## Context

The existing Android app already includes a native overlay orb, live transcript overlay, Android `SpeechRecognizer`, local TTS, gateway calls, accessibility screen context, basic local commands, and a gateway that can store voice turns and launch home-machine harness runs. The missing product structure is not basic feasibility; it is the durable loop that makes the app useful every day:

```text
phone overlay
  captures voice + current-screen context
  sends turn to gateway
  shows short answer or run status
  keeps local control of phone actions

gateway / execution machine
  routes intent
  stores sessions and events
  starts/monitors agents
  returns structured status or action proposals
```

## Goals / Non-Goals

**Goals:**

- Make the Android app the first-class Moa control surface.
- Keep voice interaction fast: tap, speak, see transcript, submit, keep listening.
- Let voice launch agent work without blocking the phone.
- Make active and completed agent work visible from the overlay and full app.
- Keep phone-local actions governed by local permission, approval, and receipts.
- Keep provider keys and long-running automation off the phone.

**Non-Goals:**

- No custom earbuds hardware, vendor SDK work, or media-button hijacking in
  this Android milestone. Standard Android assistant and voice-command launch
  intents are in scope.
- No autonomous sensitive actions such as sending messages, payments, banking, or security changes.
- No raw model/API keys in Android storage or APK.
- No hard dependency on hosted realtime audio until the core loop works.
- No hidden server authority over phone UI actions.

## Decisions

### Decision: Android App Is The Interface, Gateway Is The Router

The app captures input, renders state, and executes phone-local actions. The gateway classifies voice turns, stores events, starts home-machine agent runs, and returns structured results.

Alternative considered: put routing and provider logic in the Android app. Rejected because it leaks credentials to the device and makes long-running execution unreliable.

### Decision: Overlay Is Capture, Full App Is Inspection

The overlay stays small and fast: orb controls, transcript, short response, quick run status, and approval prompts. The full app owns deeper inspection: sessions, branches, run history, settings, action logs, and capability configuration.

Alternative considered: make the overlay the whole product. Rejected because it would become visually heavy and hard to trust over other apps.

### Decision: External Button Launch Uses Android Voice-Command Intents

Earbuds, headphones, and system gestures that invoke the assistant should enter
Moa through Android's assistant/voice-command intent path. `MoaAssistActivity`
is the thin exported entry point; it validates local permissions and starts the
overlay voice turn. The app should register for standard assistant and
voice-command actions such as `ACTION_ASSIST`, `ACTION_VOICE_ASSIST`, and
`ACTION_VOICE_COMMAND`.

Alternative considered: intercept generic media play/pause buttons or build
earbud-specific integrations. Rejected because media buttons are owned by active
media sessions and vendor integrations would expand hardware scope before the
core Android loop is reliable.

### Decision: Agent Runs Are Async By Default

Voice-started agent work must return quickly with a run ID and status. The phone polls or subscribes for lifecycle updates and displays completion later.

Alternative considered: block the phone until the harness finishes. Rejected because mobile voice interaction must stay responsive and the log explicitly calls for agents to continue working unless stopped.

### Decision: Action Proposals Are Not Commands

The gateway may propose structured actions, but the Android app validates them against local capability manifests, current screen/package state, and approval rules before execution.

Alternative considered: let model output directly trigger accessibility actions. Rejected because screen text and model output are untrusted inputs.

### Decision: Sessions And Branches Are Product Primitives

Every voice turn, chat message, screen snapshot summary, agent run, and action receipt should attach to a mobile session and branch. Branching can start simple with `default`, but the identifiers must be present now.

Alternative considered: only keep chat history. Rejected because the product needs multiple agent threads and operation history, not one flat conversation.

### Decision: Parallel Speech Starts New Durable Sessions, Not Merge Jobs

When the user starts a new spoken thread while another one is still responding
or running, the gateway should create a new session or branch and store both
streams in the shared event database. The agent does not need a special
conversation merge step. Code-mode agents can read the latest session, branch,
turn, run, approval, and receipt records from the gateway store when they need
current state.

Alternative considered: merge concurrent voice threads into one in-memory
assistant conversation. Rejected because it makes mobile interruption handling
fragile and hides important run/action history from later agents.

### Decision: Executor-Style Tool Catalog Lives Behind The Gateway

Moa should adopt the useful `executor` pattern: integrations become a catalog of
typed tools with input/output schemas, auth, policy, execution IDs, and resumable
status. The gateway may use Executor or an Executor-compatible adapter for
OpenAPI, MCP, GraphQL, and custom JS sources, but Android still sees only safe
action proposals, approvals, and receipts.

Alternative considered: expose third-party tool calls directly to Android or
raw model output. Rejected because provider/integration credentials and
execution policy belong behind the gateway, while phone-local authority remains
on Android.

### Decision: Gateway Is The Hub, Devices Own Local Tool Execution

Moa should use a hub-and-spoke execution model. Android, browser, and future
desktop clients connect to the gateway as device clients with advertised local
tool capabilities. A model turn can request a tool, but the gateway routes that
tool request to the execution environment that owns the authority: phone-local
app launches and accessibility actions run on Android; tab creation and
browser-local CDP actions run in the Chrome extension; long-running coding and
research harnesses run on the execution machine. Each environment returns a
receipt, and the gateway stores the receipt so any other surface can inspect the
active/completed work.

This model is bidirectional without making any client omnipotent. From the
browser, a user can ask the gateway to request a phone action such as speaking a
message on the phone; Android still receives, validates, executes, and receipts
that action. From the phone, a user can ask to open or inspect browser tabs; the
browser extension still owns the tab action and receipt. Agent runs remain
shared records in the gateway, so the phone can inspect browser-launched agents
and the browser can inspect phone-launched agents.

Alternative considered: let the gateway directly control every connected
device. Rejected because it would collapse the trust boundary; the device that
owns permissions and local state must execute and receipt local actions.

### Decision: Postgres Becomes The Shared Execution Store

The gateway's current file-backed `DATA_DIR` storage is only an early QA
implementation. The durable product store should be Postgres-backed so code-mode
agents, gateway APIs, and future Executor-style integrations all read the same
session, branch, turn, run, tool-source, execution, approval, and receipt state.
DBOS is a strong fit to evaluate because it keeps durable workflows and queues
inside the application process while checkpointing workflow state in Postgres.

Alternative considered: keep JSON/JSONL files as the canonical store. Rejected
because concurrent mobile sessions, resumable tool executions, cancellation,
dedupe, and cross-agent inspection need transactional records and queryable
state.

### Decision: Streaming Voice Uses Gateway Provider Packages

The Android app sends PCM16 microphone chunks over the gateway WebSocket and
receives transcript/audio events back. STT, LLM, and TTS provider packages live
behind the gateway boundary so provider credentials stay off Android and the
phone protocol does not change when the provider changes. The first concrete
packages are `loopback` for transport QA and `gemini-live` as an optional bundled
STT + LLM + TTS path.

Alternative considered: call hosted realtime audio directly from Android.
Rejected because it would move provider credentials and provider-specific
session logic onto the phone.

### Decision: OTA Publishes Artifacts, Android Approves Installs

The gateway may serve the latest signed Android APK manifest and artifact, and
CI may update those files automatically after commits. Android still downloads
through the configured gateway token, verifies size and SHA-256 from the
manifest, and opens the platform package installer for user approval.

Alternative considered: have the gateway or execution machine remotely install
APK updates on the phone. Rejected because package installation is a
phone-local action and must remain under Android/user authority.

## Risks / Trade-offs

- Recognition quality is limited by Android `SpeechRecognizer` -> keep the interaction robust with final-result preference, partial fallback, and later replace with streaming STT.
- Earbud assistant gestures vary by device and OEM -> rely first on the Android
  voice-command chooser/default assistant path and verify real devices such as
  AirPods 4 before adding any fallback.
- Local TTS is not the desired final voice -> split `speak` from `display` now so hosted TTS can be swapped in later.
- Accessibility context can leak sensitive screen text -> summarize/redact before remote storage and never treat screen text as instructions.
- Agent runs can create unwanted code changes -> keep named harnesses, token auth, visible run state, and cancellation.
- OTA deploys can publish a bad APK quickly -> use a stable signing key,
  monotonically increasing version codes, manifest checksum verification, and
  Android package-installer approval.
- Full app scope can expand too fast -> build it as an inspection/control center for the five core primitives only.

## Migration Plan

1. Keep the current overlay and gateway working.
2. Add mobile-visible async run tracking before adding more agent power.
3. Add run cancellation and lifecycle status on the gateway.
4. Stabilize session/branch/event records.
5. Add local action approval and receipt storage.
6. Build the full app control center around the resulting data model.
7. Improve voice quality after the loop is observable and trustworthy.
