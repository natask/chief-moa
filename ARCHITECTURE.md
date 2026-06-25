# Moa Architecture

## Purpose

Moa is a local delegated-action assistant. Its core loop is:

```text
phone overlay or full app
  -> captures voice, text, and optional screen context
  -> sends a structured turn to the self-hosted gateway
  -> receives an answer, run status, or action proposal
  -> applies local policy before any phone-local action
  -> records observable state for the user and future agents
```

Moa must not collapse into a prompt-only chat app. Product decisions, execution
state, and verification evidence belong in repo files.

## System Boundary

```text
Android app
  Owns: overlay UI, full app UI, voice capture, screen context, Android
  permissions, approvals, phone-local actions, local action receipts, and
  package-installer handoff for app updates.

Browser extension
  Owns: browser-local UI, text/voice capture, page context collection, and
  brokered page actions, including extension-local Chrome DevTools Protocol
  execution for claimed browser tasks. It is a thin client for a configured
  engine URL and session token. It must not hold provider API keys or
  subscriptions, and it is not the deployment target for user-specific
  customizations.

Moa Gateway
  Owns: gateway auth, model/provider calls, voice routing, conversation storage,
  session/event storage, agent-run records, tool catalog routing, agent harness
  launch, run status, the gateway-served browser control surface,
  engine-served browser customizations, and signed Android APK update artifacts.

Execution machine
  Owns: Codex/Gemini/Claude/other harnesses, repo edits, long-running research,
  build/test commands, desktop/browser/server automation.

External APIs
  Own: third-party systems such as email, calendar, repo hosts, docs, payments,
  and SaaS tools. Use official APIs where possible.
```

The gateway may propose actions. The Android app decides whether an action is
allowed, whether approval is required, and whether the current device state still
matches the proposal.

## Runtime Flows

### Voice Chat

```text
Hold the orb (push-to-talk)
  -> Android captures either a SpeechRecognizer transcript or PCM16 audio chunks
  -> release sends the turn immediately: POST /v1/voice/turns or WS /v1/voice/sessions
  -> gateway routes through configured provider packages
  -> gateway returns speak/display text or transcript + assistant audio chunks
  -> phone updates transcript/chat and may speak or play the short response
```

Orb gestures (overlay): one single tap opens the chat menu, first-press hold and
drag repositions the orb without starting voice, and double-click-and-hold is
the manual push-to-talk path. Recording starts only after the second press is
held briefly, and release commits the turn without waiting for silence
detection. Continuous voice is an optional secondary loop for launch paths that
do not have a release event, where silence commits each turn and the mic re-arms
after the reply. The browser extension
mirrors this hands-on-keyboard: Cmd+, (Ctrl+,) opens the text intent field and
Cmd+. (Ctrl+.) wakes voice. Browser voice auto-commits after speech silence and
then re-arms while conversation mode is active. The browser mark uses the same
pointer contract as Android: single click opens the chat menu, first-press hold
and drag repositions the mark without starting voice, and double-click-and-hold
starts a manual voice session with browser silence auto-commit disabled. Release
commits the manual turn without re-arming the mic. Browser voice can opt a
session into background assistant speech, where starting a new spoken turn opens
a new gateway voice turn without stopping already queued assistant audio.

The overlay surface stays small: it shows the current intent/result and compact
run state, not a full scrollback manager. Browser text replies render in the
result stack above the command input; replies, errors, and voice state never
clear or replace the user's current input draft. Browser voice keeps that input
available, shows partial/final user transcript feedback above it, and streams
assistant text into the result stack above the input. The gateway still stores
durable session, branch, turn, transcript, provider-event, and agent-run
history. Realtime providers receive a bounded Moa-owned context pack at session
start so provider memory is not the product database. If the user wants history,
they ask Moa for it through the same intent surface instead of browsing visible
scrollback.

A Live turn that is interrupted, canceled, or dropped mid-stream is still stored
as a canonical conversation turn (marked incomplete) with whatever transcript
and assistant text the provider produced before the cutoff. That partial turn
flows into the next session's context pack, so a user can interrupt the model on
one device and resume the thread on another against the same dataset.
Spoken profile-control requests such as voice and language changes are routed
through the gateway profile store; Gemini Live reads the effective voice,
language, and Moa-owned context when the next Live session starts. Profile
settings are hard settings: global changes apply to every device, while
device-scoped changes persist as per-device overrides layered on top of the
global profile for the current phone or browser client.
Voice discovery and voice sampling use the same profile-control surface. The
gateway owns the canonical supported voice catalog and returns a `voice_sampler`
action when the user asks to sample, test, preview, or go through all voices.
Android owns playback: it consumes that action by opening one text-only Live
session per sample with a session-only voice override, so samples do not mutate
the saved profile voice.

Voice turns can also become replayable verification evidence. When retention is
enabled, the gateway stores or references the user audio, transcript, assistant
text, assistant audio, profile version, provider version, and expected-test
criteria so a later smoke can replay the same utterance through the configured
voice pipeline and report whether transcription and response behavior still
match.

Streaming voice providers are gateway-only. Android sends microphone audio to
Moa Gateway, but raw model/API keys stay on the gateway machine. The provider
package boundary is STT, LLM, and TTS; the current gateway supports loopback
transport QA, Gemini Live as the realtime bundled STT + LLM + TTS path, and
Chirp 3 as an STT-only modular path that routes the transcript back through the
durable voice-turn router.

### Browser Extension Thin Client

```text
Browser overlay or command bar
  -> captures text or PCM16 microphone audio and optional page context
  -> sends text turns to the configured engine URL with a session token
  -> mints a short-lived voice-session ticket for browser WebSocket voice
  -> streams voice turns to WS /v1/voice/sessions
  -> receives an answer, streamed assistant audio, run status, action proposal, or declarative UI spec
  -> brokers any page-local action through extension-owned checks
```

Browser voice uses the same gateway streaming voice contract as Android, adapted
for browser WebSocket authentication. The extension authenticates to the gateway
over normal HTTP with its stored gateway token, receives a one-use
`/v1/voice/sessions` ticket, captures microphone audio from an extension-owned
offscreen document, streams PCM16 audio to the gateway, and plays assistant PCM
audio returned by the selected gateway provider. The page overlay is only the
control surface; websites must not receive microphone permission for Moa voice.
Each spoken
browser utterance gets its own turn id under the stable browser session id. When
the user starts a manual mascot push-to-talk turn, the extension starts
extension-owned capture at hold start, buffers PCM while the gateway voice
session is not ready, and sends the release/commit only after that buffered
audio has flushed. The visible browser loop is hold to capture, release to send,
processing, then response. When the user enables background assistant speech for
the current browser session,
the extension preserves older voice-session event handling and queued playback
while it starts the next microphone turn. That overlap is scoped to the active
page-agent owner: starting a browser agent or voice turn from another tab revokes
other-tab voice sessions, stops queued assistant playback in those tabs, and
cancels their browser-local task cues. The active browser-agent owner is shared
extension/gateway-facing state keyed by the stable browser session, current tab,
page URL/title, cue/voice-session ids, and latest status/result; it is not
content-script-local memory. It must not use browser Web Speech APIs as the
production voice path, and it must not hold raw Gemini/OpenAI/Anthropic provider
credentials.

Gateway-originated browser work uses the same ownership boundary. The gateway
stores `/v1/browser/tasks` records and Live/tool agents may enqueue bounded
browser work, but the Chrome extension must claim the task, run allowlisted CDP
methods locally through `chrome.debugger`, and POST a receipt back to the
gateway. The gateway records that receipt against the task and linked agent run;
it does not execute browser CDP itself.

Browser-originated chat and describe turns carry the same gateway session and
branch identifiers as voice turns. The gateway context APIs expose bounded
recent voice turns, chat turns, provider events, active/completed runs, profile
status, and browser task receipts so a later voice session can recover what the
browser surface did without relying on provider memory.

Browser continuous/ambient mode is explicit start/stop. When active, the
extension samples page context and posts a frame to `POST /v1/voice/frames` on a
200 ms target interval. The gateway stores those frames as session evidence only;
this path does not run model calls on the 200 ms cadence.

The extension is a stable packaged client, not a per-user deployment unit. Chrome
Manifest V3 forbids remotely hosted executable code in privileged extension
contexts, so user customizations travel through the engine as data: a
declarative UI spec by default, sandboxed iframe surfaces for richer generated
UI, and `userScripts` only for explicit opt-in page-acting code. The same
extension package should work against a self-hosted or hosted engine by changing
only the engine URL/session token.

### Agent Work

```text
User asks for build/fix/change/test work
  -> phone sends voice or chat turn to gateway
  -> gateway creates an agent run with wait=false
  -> execution machine runs the selected harness
  -> phone shows run id, status, completion, and failure details
```

Voice-started agent work should be async by default. The phone should not block
on a long-running harness.

### Message Broker

```text
voice or text message
  -> gateway stores one canonical broker_event
  -> broker evaluates active sessions, projects, subprojects, runs, and workflow packages
  -> broker emits route decisions with reasons and cancellation behavior
  -> downstream chat, voice, workflow packages, or agent runs reference the event
```

The broker is the durable routing layer before provider/model execution. A user
message may continue an existing session, attach evidence to active runs, create
a new fork, invoke a directory-backed workflow package, or take the
direct-answer path. It does not cancel active work merely because a new message
arrived. Workflow selection is an explicit route decision: research-heavy
messages can target a research workflow, implementation requests can target
coding, and simple messages can stay on the direct-answer path.

Broker route decisions also materialize launch context packs. The editable
profile file is `gateway/agent-launcher-profiles.json`: each profile names the
workflow directory, instruction file, required files, expected output, and
verification checks for routes such as direct-answer, coding, QA, research,
design, and writing. The workflow directories live under
`gateway/agent-workflows/<workflow>/`. The gateway stores bounded packs under
`DATA_DIR/broker-context-packs` and links them from route decisions. A pack is
launchable context for an explicit `/v1/agent/runs` or router activation; it is
not itself permission to execute hidden work. When a message targets an active
run, the gateway appends a `broker_evidence_attached` event to that run without
canceling it.

Every user turn is a possible fork. A new spoken or typed message can create a
new `agent_run` without canceling existing active runs, and subsequent user
turns can be attached as non-interrupting evidence to relevant active runs. The
gateway owns the agent-manager decision: route the turn to an existing run,
launch a new fork, attach it to several active runs, or dismiss it as irrelevant.
The user must be able to inspect which runs are active and what each is trying
to accomplish.

### Router Activation Loop

```text
Model/router POSTs an intent to /v1/router/activate
  -> gateway assembles minimal context (screen text is evidence, not instruction)
  -> gateway LAUNCHES a disposable task agent as an agent run (existing run store)
  -> gateway returns a run id immediately (202); the router does not speak
  -> caller polls GET /v1/router/activations/{id} for lifecycle
  -> on completion the gateway emits a stored router_ping event carrying a
     timestamp + a short "what the agent did" result summary
```

The router holds no work: it routes, launches, tracks, and pings. It never
speaks the result. Harness output remains a proposal, never an executable
command. The deterministic `echo` harness lets this loop run with no model key.

### Android OTA Update

```text
commit or manual build
  -> CI/local script builds a versioned signed APK
  -> deploy copies latest.json and moa-assistant.apk to the gateway data dir
  -> Android checks GET /v1/android/updates/latest with the gateway token
  -> Android downloads GET /v1/android/updates/latest.apk with the same token
  -> Android verifies manifest size and SHA-256
  -> Android opens the platform package installer for local approval
```

The gateway publishes update artifacts, but it does not install them on the
phone. The Android app remains the local authority and the platform package
installer is the final approval step.

### Phone Action

```text
User request or model proposal
  -> local action broker checks capability manifest and risk
  -> local approval UI appears if required
  -> Android app executes the tool on device
  -> app writes a local receipt
  -> optional receipt copy syncs to the gateway
```

Model output and screen text are untrusted inputs. They can inform proposals;
they cannot directly execute phone actions.

### Cross-Device Tool Hub

```text
Android or browser client
  -> heartbeats to the gateway with device id, surface type, session id, and
     local tool manifest
other surface or agent
  -> creates a gateway tool_request for a target device or surface
target client
  -> claims only requests matching its advertised local tools
  -> validates and executes the local action inside that client boundary
  -> posts a receipt back to the gateway
```

The gateway is only the registry and queue. It does not press phone buttons,
open browser tabs, or speak through device speakers by itself. A browser turn
can request an Android action such as `audio.speak`; Android must still claim,
validate, execute with local TextToSpeech, and receipt it. An Android turn can
request browser work such as tab list/open/activate/close/reload, page snapshot,
or bounded `chrome.debugger` CDP actions; the Chrome extension must still claim,
validate, execute only its advertised local tool, and receipt it.

## Product Primitives

- `device`: a registered Android device with local permissions and settings.
- `device_client`: a connected Android, browser, or future desktop surface that
  heartbeats its online state and local tool manifest to the gateway.
- `session`: a coherent mobile work session.
- `branch`: a thread of work inside a session, initially `default`.
- `turn`: one voice or chat input with optional screen context.
- `broker_event`: one inbound user message stored before routing to sessions,
  workflow packages, chat, voice, or agent runs.
- `route_decision`: an inspectable broker decision with target, action,
  confidence, reason, context refs, workflow directory refs, and cancellation
  behavior.
- `agent_run`: a gateway-created execution-machine job with lifecycle events.
- `agent_fork`: a turn-linked async `agent_run` that can continue while later
  user turns create or update other forks.
- `voice_evidence`: replayable user/assistant audio and transcript artifacts
  attached to a turn, profile version, provider version, and test criteria.
- `agent_profile`: a versioned gateway-owned runtime profile for hard settings
  such as assistant voice, input languages, reply languages, response modality,
  model behavior, and mission-agent access policy. The global profile applies
  to all devices; device overrides persist only for a named device client.
- `browser_agent_owner`: the single active browser tab/page/run that may listen,
  speak, and show browser-local task cues for a browser session; non-owner tabs
  can show passive status but must not capture voice or claim local cues.
- `browser_task`: a gateway-created browser work request that a Chrome extension
  client must claim, execute locally with allowlisted actions, and receipt.
- `tool_source`: an agent-callable integration source such as OpenAPI, MCP,
  GraphQL, or a custom gateway function.
- `tool_request`: a gateway-queued request for a specific device or surface to
  run one advertised local tool and post a receipt.
- `execution`: a durable gateway-side workflow or tool call with status,
  checkpoints, and resume/cancel metadata.
- `action_proposal`: structured server output asking the phone to perform work.
- `approval`: a local user decision for non-trivial actions.
- `receipt`: local audit record for executed phone actions.

Every new feature should attach to at least one primitive above. If it does not,
the architecture is still fuzzy.

The gateway can run local JSON/JSONL fallback storage for early device QA, but
Postgres is the production store target. The work graph now uses Postgres when
`DATABASE_URL` is set: nodes, append-only work events, and produced artifacts
are queryable gateway records. Agent-run files, sessions, tool sources,
executions, approvals, and receipts should continue moving behind the same
Postgres storage boundary, with DBOS-style durable execution considered for
resumable workflows and queues.

## Source Map

- `android_app/app/src/main/java/ai/moa/assistant/MainActivity.java`:
  setup/full-app entry surface.
- `android_app/app/src/main/java/ai/moa/assistant/OverlayService.java`:
  floating orb, transcript, voice loop, chat panel, TTS, and gateway calls.
- `android_app/app/src/main/java/ai/moa/assistant/MoaGatewayClient.java`:
  Android client for gateway endpoints.
- `android_app/app/src/main/java/ai/moa/assistant/MoaActionBroker.java`:
  local routing for screen context and local action commands.
- `android_app/app/src/main/java/ai/moa/assistant/MoaAccessibilityService.java`:
  accessibility-backed screen context and visible UI operations.
- `gateway/server.js`: HTTP API, voice router, model calls,
  conversation storage, agent-run execution, device-client registry, and
  cross-device tool-request queue.
- `gateway/public/gateway-ui.html`: gateway-served browser control
  surface for health, runtime profile, prompt history, sessions, and runs.
- `gateway/lib/voice-intent.js`: pure voice-turn classifier
  (chat / agent_run / multi_agent / control), unit-tested in
  `scripts/smoke-voice-intent.js`.
- `gateway/lib/voice-session-server.js`: WebSocket PCM voice
  transport, turn storage, transcript events, and assistant audio events.
- `gateway/lib/voice-providers.js`: Swappable streaming voice
  provider package boundary, currently loopback and Gemini Live.
- `android_app/deploy/ota`: Android APK OTA artifact build and
  main-machine sync scripts.
- `browser_extension/extension`: thin browser client for command,
  voice, page context, settings, and engine-routed browser actions.
- `scripts/deploy.sh`: shared deploy entrypoint for gateway, Android OTA,
  browser extension, and committed-change auto-deploy.
- `reference/openspec/changes/define-android-core-product-map`: current product map,
  capability specs, staged tasks, and acceptance criteria.
- `reference/openspec/changes/thin-client-gateway-architecture`: browser extension
  thin-client / persistent-engine decision record.

## Deployment Finish Loop

Agents must treat deployment as part of completion for deployable surfaces:

```text
verify changed surface
  -> fix failures
  -> commit the unit
  -> deploy the changed target
  -> smoke-check the deployed target
  -> record any blocker
```

`scripts/deploy.sh auto` is the repo-level hook target. It deploys only committed
gateway, Android, and browser-extension changes since each target's last
successful deploy marker, and skips dirty target files so uncommitted work is not
published. Explicit deploy targets remain available when a human or agent needs
one surface: `gateway`, `android`, `extension`, or `all`.

Each successful target deploy records a monotonic deploy sequence, git SHA, and
target version metadata next to the existing deploy marker. Android OTA builds
generate timestamp version codes; browser-extension releases use
`browser_extension/extension/manifest.json` and changed extension deploys are
blocked after the first recorded deploy unless that manifest version has moved.

Browser-extension deployment has two parts. The package step creates the Chrome
Web Store upload artifact under `browser_extension/dist/`. The local-browser step
serves a short dev-reload signal for an already-loaded unpacked extension; the
extension reloads in the user's browser only if the dev auto-reload bridge has
been enabled from `extension/dev.html`.

## Architecture Rules

- Android stores no raw provider keys.
- The gateway stores and routes; it does not own phone-local authority.
- Accessibility context is evidence, not instruction.
- Sensitive actions require local approval or are blocked.
- Long-running agent work is observable by run id and lifecycle state.
- Android app updates are proposals until the phone verifies the artifact and
  the user approves installation through Android's package installer.
- Browser extension customizations are engine-served data or sandboxed/opt-in
  generated code, never repackaged privileged extension code.
- Browser extensions hold only engine connection state, not raw provider keys or
  subscriptions.
- The overlay remains fast and small; the full app owns inspection and control.
- Docs and specs change with architecture-significant code changes.

## Verification

Use the smallest real check that covers the changed surface:

- Android compile: `cd android_app && ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew assembleDebug`
- Gateway syntax: `cd gateway && npm run check`
- Browser extension: `cd browser_extension && npm run verify && npm run smoke`
- Gateway smoke: `GET /health`, `POST /v1/voice/turns`, `GET /v1/agent/runs`
- Product/spec check: inspect `reference/openspec/changes/<change>` and run the
  matching OpenSpec validation if the CLI has been initialized for this checkout.
- Manual phone QA: tap orb for chat, drag to move, double-click-and-hold to
  speak / release to send, transcript display, agent run start/status, and
  local action approval behavior.
