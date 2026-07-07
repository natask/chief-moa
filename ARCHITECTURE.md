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

Website
  Owns: the public marketing surface and static account/customization tools
  such as the companion pet studio. It may call same-origin Pages Functions that
  proxy to token-guarded gateway endpoints, but it must not hold provider API
  keys, raw gateway tokens, or local execution authority in browser JavaScript.

Moa Gateway
  Owns: gateway auth, model/provider calls, voice routing, conversation storage,
  session/event storage, agent-run records, tool catalog routing, agent harness
  launch, run status, the gateway-served browser control surface,
  companion manifests, pet manifests, engine-served browser customizations, and
  signed Android APK update artifacts.

  The same gateway binary runs in `local`, `self-host`, or `hosted` mode.
  Remote modes bind to `0.0.0.0`, require `MOA_GATEWAY_TOKEN` and
  `DATABASE_URL`, trust proxy headers only when configured, and should publish a
  canonical `PUBLIC_GATEWAY_URL` such as `https://api.<domain>`. Android and the
  browser still store only that gateway URL plus a token; voice uses the matching
  `wss://.../v1/voice/sessions` URL.

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
Cmd+. (Ctrl+.) mirrors the browser mark's double-click voice path. A quick
Cmd+. tap, or a quick mark double-click, toggles a manual voice turn on; the
next quick Cmd+. tap or double-click commits it. Holding Cmd+. or holding the
second mark click uses push-to-talk: capture starts immediately, browser
silence auto-commit is disabled, and release commits the turn without re-arming
the mic. The browser mark's single click opens the chat menu, and first-press
hold with movement only repositions the mark. Browser voice can opt a session
into background assistant speech, where starting a new spoken turn opens a new
gateway voice turn without stopping already queued assistant audio.

An experimental voice-first gesture mode (off by default; browser flag
`ageeVoiceFirstGesturesEnabled`, Android pref `voice_first_gestures`) remaps
both surfaces to the same contract: a still first-press hold is push-to-talk
(release commits), double-click toggles hands-free talk mode with a visible
active state on the mark/orb, triple click opens the demoted chat surface, and
single click interrupts (stops assistant speech, dismisses the panel) instead
of opening chat. Drag and resize are unchanged, and the flag off keeps the
default contract above. Contract:
`reference/openspec/changes/voice-first-orb-gestures/proposal.md`.

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

The model performs customization through gateway tool calls, not client-side
keyword detection. On the Live path and on the cascaded reasoning path the
model calls `update_agent_profile` to change any vetted setting (reply
language, heard/input languages, voice including masculine/feminine aliases,
`response_modality`, `voice_max_chars`, assistant name, persona, and the
reasoning `model`/`reasoning_provider`), `revert_agent_profile` to undo its
last change (`mode=previous`) or restore the gateway defaults (`mode=reset`),
and `propose_page_tweak` on browser turns. On cascaded turns the tools run
through a bounded gateway tool loop that works on both the Vertex and
OpenAI-compatible providers and degrades to a plain reply when the model or
provider cannot call tools. Language switching is exclusively model-owned: the
deterministic transcript matchers for language were removed, so understood and
reply languages change only through `update_agent_profile` (or the
`set_languages` code-mode skill on the execute path), and the Live safety gate
accepts language fields on the model's word while every other profile field
still requires the deterministic parser to confirm the user asked. STT input
languages stay explicitly user-specified (profile `input_languages`) — the
gateway never auto-detects what the user speaks; Chirp recognition is
constrained to exactly that set, and `input_language_primary` reorders it so
one understood language leads recognition. Every write passes through the same
sanitizer as the HTTP path (persona-prompt override stripping, the language
allowlist, per-field coercion), so no tool value can blank a field or break the
app; a rejected value keeps the previous setting and returns a structured
`language_rejection`-style result rather than failing the turn. The HTTP turn
path exposes the same capabilities through the deterministic profile-control
intent parser: "undo that" reverts the last change and "reset your settings"
restores defaults, both scoped global or per-device and both appending a new
profile version so history stays append-only and every voice change is itself
reversible by voice.

Browser page tweaks follow the proposal boundary: `propose_page_tweak` is
available only on browser-sourced turns, and the gateway validates the proposed
`{ kind, params, name? }` record against the extension's own tweak allowlist
(`hide`, `css-selector-hide`, `font-scale`, `font-size`, `dark`, `black`,
`width`) and the params shape, then returns it as a structured
`{ type: "page_tweak", record }` action in the turn result. The gateway never
compiles CSS, emits code, or executes the tweak; it only passes a bounded
declarative record, and the browser extension compiles the CSS locally and
applies it. This keeps the no-eval boundary: the model cannot send CSS or JS
strings, only a kind and bounded params, and an unknown kind or malformed params
returns a `page_tweak_rejected` result instead of failing the turn.

Spoken input must never be lost. Each stored voice turn keeps the exact final
transcript with a transcript source label (real STT, typed text, or synthetic
placeholder), streaming partials merge into the final record when the provider
result is a placeholder, and stored turns are queryable by id
(`GET /v1/voice/turns/{turnId}`). A control intent such as "what did you hear"
returns the prior user transcript verbatim. Echo-back depends on the user input
transcript, which the gateway always requests from the Live provider
(`inputAudioTranscription`), so the exact-transcript guarantee holds on every
Live model.

Native-audio Live models are audio-only for output: they reject any text-output
request and close the socket with 1007 "Text output is not supported for native
audio output model." The gateway therefore omits `outputAudioTranscription` for
native-audio models (keeping it for non-native Live models) and keeps
`responseModalities` at `["AUDIO"]`. On native-audio the assistant-side text
mirror (`assistant_text`) is empty because the model emits neither an output
transcription nor text parts; downstream treats empty `assistant_text` as "no
assistant transcript" and does not depend on it, so the turn still returns audio
and the stored user transcript.

The language catalog covers the full Chirp 3 set (about 115 codes, GA plus
preview; see `agent_profile` below) and is enforced in the same profile-control
path: an out-of-catalog language is dropped by the sanitizer with the previous
setting kept, and the reply states the language is not in the supported set
rather than silently failing.

Voice turns can also become replayable verification evidence. When retention is
enabled, the gateway stores or references the user audio, transcript, assistant
text, assistant audio, profile version, provider version, and expected-test
criteria so a later smoke can replay the same utterance through the configured
voice pipeline and report whether transcription and response behavior still
match.

Streaming voice providers are gateway-only. Android sends microphone audio to
Moa Gateway, but raw model/API keys stay on the gateway machine. The provider
package boundary is STT, LLM, and TTS. Two switchable pipelines drive the same
`processTurn(turn, hooks)` contract, so both write identical turn records and
PCM files:

- `native_live`: one bundled STT + LLM + TTS provider. Gemini Live (Gemini
  Developer) or Vertex Live. It auto-detects the INPUT language and cannot be
  constrained, which mistranscribes English.
- `cascaded`: Chirp 3 streaming STT, restricted to the configured input
  languages, then the gateway's model-agnostic LLM turn, then hosted TTS reply
  audio (gemini-tts or classic Cloud TTS). The reasoning model is swappable at
  boot (`MODEL_PROVIDER`/`MODEL_ID`) and at runtime per profile
  (`model`, `reasoning_provider` — settable by voice through
  `update_agent_profile`), so the middle model can be A/B tested without a
  restart and is not tied to any one LLM.

loopback stays for transport QA. The legacy Chirp STT-only path (transcript
routed back to the durable voice-turn router) is preserved: it is the same
provider without the hosted-TTS leg.

### Cascaded voice pipeline and the switch

```text
Chirp 3 STT (input restricted per turn to the agent profile's input_languages;
             CHIRP_LANGUAGE_CODES is only the boot fallback)
  -> gateway LLM turn (model-agnostic; swappable per profile via `model` +
     `reasoning_provider`; reply language/voice from the agent profile as
     OUTPUT policy; injects durable session context, gbrain recall, a
     modality/TTS-delivery hint, and — on gemini-tts — an expressive-speech
     directive; profile tools available through the bounded tool loop)
  -> hosted TTS reply audio (gemini-tts synthesizes any reply language,
     including am-ET; classic cloud-tts only languages with a hosted voice).
     `response_modality:"text"` deliberately skips TTS; a synthesis failure
     is logged and carried as `tts_error` — either way the reply text still
     reaches the client, which shows it with a "(not spoken)" cue. The device
     never speaks with local TTS.
```

The active pipeline is selected per deployment/session by provider names,
falling back to env:

- Cascaded `{en-US, am-ET}`: `VOICE_PROVIDER=chirp`,
  `VOICE_TTS_PROVIDER=cloud-tts`, `CHIRP_MODEL=chirp_3`,
  `CHIRP_LANGUAGE_CODES=en-US,am-ET`. The reasoning stage is the gateway
  (`VOICE_REASONING_PROVIDER=gateway`).
- Legacy Gemini Live: `VOICE_PROVIDER=gemini-live` (all three stages), with
  `GEMINI_API_KEY` and `GEMINI_LIVE_*`.

On Chirp, a language-restricted request is a primary code plus at most one
alternate; more codes (or pairing auto-decoding with `languageCodes`) demote
the codes to hints and auto-detection still runs. The provider caps the list to
two codes and uses explicit LINEAR16 decoding so recognition is truly
restricted. am-ET (Amharic) exists only on `chirp_3`; the provider asserts the
model before a recognize call. Classic Google Cloud TTS has no Amharic voice,
but the gemini-tts leg (`gemini-3.1-flash-tts`) synthesizes any language the
model speaks, including am-ET, so hosted reply audio covers both catalog
languages. On gemini-tts the reasoning model is prompted to direct the
delivery: a leading `[style: ...]` line becomes the synthesis style prompt
(`input.prompt`) and whitelisted inline tags such as `[sigh]` or
`[short pause]` stay in the spoken text (`input.text`), while the displayed
and stored transcript is stripped clean of both.

The restricted input set is read from the agent profile per turn (mirroring how
the reply language already works), so a spoken or typed language change applies
without a gateway restart. Recognize results whose language falls outside the
active restricted set are dropped and flagged on the turn record instead of
leaking a foreign-language transcript.

A voice turn can never end silently, and it must end honestly. Model and TTS
calls run under bounded timeouts, every commit/text turn error also emits
`turn_done{status:"error"}` (not just an `error` event), and completed
cascaded turns carry `tts_spoke`, `reply_language`, `modality`, and (on a real
synthesis fault) `tts_error` on `turn_done`. `modality:"text"` marks a
deliberate text-only delivery, never a failure. Profile-control confirmations
are synthesized and spoken like any other reply. Clients act on those fields:
when no hosted reply audio arrives (`tts_spoke=false`) the phone keeps the
reply visible longer with a "(not spoken)" cue — never local TTS — `no_speech`
turns are surfaced ("didn't catch that"), a mid-turn socket drop shows a
visible retry message, and the Android watchdog re-arms on every streaming
event so a stalled turn times out audibly instead of hanging forever. The
reasoner sees the delivery state (modality, TTS availability, the previous
turn's `tts_error`) as a hint block, so "why did you answer in text?" gets a
truthful answer and the model can change `response_modality` by tool call.

### LiveKit prototype (flag-gated)

The default voice transport is the cascaded WebSocket pipeline above and is
unchanged. A separate LiveKit (WebRTC) transport exists as a measurement
prototype behind flags and is inert by default. It is Option A: the gateway
mints room tokens (`POST /v1/voice/livekit/token`, env-gated on `LIVEKIT_URL` +
`LIVEKIT_API_KEY` + `LIVEKIT_API_SECRET`, 503 when unset) and a standalone
`@livekit/agents` worker (`livekit_worker/`, its own package, not in the gateway
deps) joins the room and drives Chirp 3 STT -> the gateway's existing reasoning
(`/v1/internal/voice/reason`) -> the gateway's existing TTS
(`/v1/internal/voice/synthesize`), recording each turn through
`/v1/internal/voice/turn-record`. The gateway stays the single owner of
reasoning, hosted TTS, turn records, threads, incognito, and the tool loop, so a
LiveKit turn is byte-identical to a WS turn. The production droplet cannot host
the LiveKit SFU (1 vCPU, no UDP surface), so the spike runs on LiveKit Cloud or
an external LiveKit server. A custom Chirp STT plugin is required because the
Node agents Google plugin has Gemini LLM + beta Gemini TTS but no Chirp STT. The
browser extension has an off-by-default "LiveKit voice (experimental)" setting
that mints a token, publishes the mic with the pre-connect audio buffer, and
maps `lk.agent.state` onto the mark states, falling back to the WS path on any
error. The pre-connect buffer and `lk.agent.state` are the features being
measured; live cutover is not decided. Contract:
`reference/openspec/changes/livekit-voice-transport/proposal.md`.

### Record Mode (raw audio notes)

```text
user enters record mode and speaks (extension record control or Android
record toggle + double-click-and-hold)
  -> client captures PCM16 locally and buffers it (no voice session opened)
  -> on stop/release the client POSTs the finished audio to /v1/audio-notes
  -> gateway stores bytes under DATA_DIR/audio-notes plus a JSON record and
     mirrors an audio_note.created product event
  -> client shows a stored/failed receipt; a failed Android upload keeps the
     local capture file
```

Record mode is note-taking, not conversation. It stores exactly what was said
as playable audio and runs no STT, LLM, or TTS by construction: the capture
path is a plain HTTP upload and never opens `/v1/voice/sessions`. Notes are
listable (`GET /v1/audio-notes`) and playable
(`GET /v1/audio-notes/{id}/audio`) behind the same gateway token as other
`/v1` routes. Evaluating or improving notes is a later change; this slice
only captures and stores. Contract:
`reference/openspec/changes/record-mode-audio-notes/proposal.md`.

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
audio returned by the selected gateway provider. Offscreen capture starts as
soon as the extension owns a local voice-session id; PCM chunks captured before
gateway `session_ready` are buffered in order and flushed before any pending
commit so the start of the utterance is not dropped. The page overlay is only
the control surface; websites must not receive microphone permission for Moa voice.
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

### Self-Extension Artifacts

```text
spoken or typed customization request
  -> gateway stores the user intent as normal message/session evidence
  -> gateway creates one or more self_extension_artifact candidates
  -> gateway validates each candidate against a known artifact schema
  -> gateway can expose previews and variants without applying them
  -> user or agent applies one candidate by moving an active pointer
  -> clients fetch a bounded runtime document
  -> each client renders only the artifact types it explicitly supports
  -> clients record visible/local receipts when they apply a runtime change
```

Self-extension is the mechanism for conversational customization and capability
creation. The model does not directly mutate Moa. It proposes structured
artifacts such as avatar behavior, theme, view, workflow, tool binding, or code
patch specs. The gateway owns storage, validation, variant history, active
pointers, runtime projection, and provider/tool routing. Moving an active
pointer requires source provenance and approval metadata, even for API-driven
development use. Android and browser clients own rendering and local execution
for the artifact types they support.

The first browser slice is `avatar_behavior`: the gateway serves an active
declarative spec such as "thinking -> orbit -> subtle", and the extension maps
that spec to known CSS classes on the Aggie/Lion mark. No generated JavaScript is
executed in privileged extension code. Richer generated UI remains declarative
or sandboxed, and page-acting code remains opt-in through the existing
`userScripts` boundary. Browser clients preserve the last-good runtime when the
gateway is temporarily unavailable and mark the cached runtime stale instead of
visually clearing an applied customization.

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
coding, and simple messages can stay on the direct-answer path. Explicit broker
launch starts at most one selected launchable route in this slice; ordinary
messages still only store decisions and context packs.

A broadcast turn ("update all active agents ...") fans out across active/forked
runs: runs the message pertains to receive it as `broker_evidence_attached`, and
each unrelated fork self-dismisses with a `dismiss_irrelevant` route decision
plus a no-op `broker_fork_dismissed` run event. A dismissal only records why the
broadcast was not attached; it never cancels, pauses, or restarts the run.

When the broker selects the research workflow, `POST /v1/broker/research` runs a
gateway-side research fan-out (`gateway/lib/research-workflow.js`): it derives
focused sub-queries, runs one search/model pass per sub-query, then one refine
pass that synthesizes a recommendation, and stores a durable `research_report`
under `DATA_DIR/broker-research-reports` (readable at
`GET /v1/broker/research/{id}`, mirrored as a `broker.research.completed` product
event). Each pass uses the configured reasoning provider when present and a
deterministic fallback otherwise, so a report returns with no model key. The
report is a stored proposal; it launches and executes nothing.

The broker is also the intent-management entry point. A user intent is the
durable user-authored message plus its source surface, session/browser/page
context, evidence references, route decisions, context packs, linked agent runs,
and eventual completion or input-needed pings. The user should not have to
manage child agents directly. Agents update the gateway-owned intent/run/event
stores as they work, and user-facing clients read those stores to show what is
active, finished, blocked, or waiting for input.

No spoken intent may be treated as ephemeral, with one deliberate, explicit
exception: an incognito turn (see Context And Threads). Streaming voice stores
the raw user PCM under the gateway voice-session archive while the provider
processes it, stores the canonical turn transcript and assistant output, and
exposes token-protected history/search and playback references so the user can
inspect or replay what they sent. Local clients may keep their own capture spool
while uploading, but the trusted gateway archive is the cross-device source of
truth once the turn reaches the server. An incognito turn is the carve-out: it is
answered normally but the gateway persists nothing for it, and it requires either
an explicit client choice or an explicit spoken/typed warrant, so the default
"nothing is ephemeral" guarantee still holds for every ordinary turn.

gbrain is the semantic recall layer for this intent store, not the store itself.
After a broker event is durably written, the gateway may index a concise intent
summary into gbrain under the Moa namespace so later searches can recall related
intent threads semantically. If gbrain is unavailable, stale, or incomplete, the
gateway still relies on broker events, voice turns, agent runs, receipts, and
event records as the authoritative product history.

Broker route decisions also materialize launch context packs. The editable
profile file is `gateway/agent-launcher-profiles.json`: each profile names the
workflow directory, instruction file, required files, expected output, and
verification checks for routes such as direct-answer, coding, QA, research,
design, and writing. The workflow directories live under
`gateway/agent-workflows/<workflow>/`. The gateway stores bounded packs under
`DATA_DIR/broker-context-packs` and links them from route decisions. A pack is
launchable context for an explicit `/v1/agent/runs`, router activation, or
broker launch request; it is not itself permission to execute hidden work. When
the broker request explicitly asks to launch an agent, the gateway activates the
strongest workflow or new-fork route as a non-blocking `agent_run`, stores the
run id on the route decision and broker event, and appends a `broker_activated`
event to the run. When a message targets an active run, the gateway appends a
`broker_evidence_attached` event to that run without canceling it.

Every user turn is a possible fork. A new spoken or typed message can create a
new `agent_run` without canceling existing active runs, and subsequent user
turns can be attached as non-interrupting evidence to relevant active runs. The
gateway owns the agent-manager decision: route the turn to an existing run,
launch a new fork, attach it to several active runs, or dismiss it as irrelevant.
The user must be able to inspect which runs are active and what each is trying
to accomplish.

### Context And Threads

```text
user turn (chat or cascaded voice)
  -> deterministic prior: explicit client context_action wins; else continue,
     lifted to new/fork by phrasing, to incognito only on an explicit warrant
  -> the model may call context_management (one tool call) to refine the choice,
     and returns a retrieval_query for recall
  -> double gate: the model may override the prior EXCEPT it may only choose
     incognito with the same explicit warrant
  -> the turn is filed on the resolved branch and the decision is stored as a
     record + product event
```

A thread is a `branch` inside the one shared session. The thread store adds the
lifecycle the turn ledgers do not carry: kind (default/new/fork/incognito), a
label, fork lineage, the active-thread pointer per surface, and a rolling
summary. `GET /v1/threads` lists every branch merged from the chat, voice, and
browser stores; `POST /v1/threads/switch` sets the active thread (or mints a
new/fork/incognito branch); `GET /v1/threads/active` returns it so every device
resolves the same thread.

The four actions:

- continue: same thread (the caller or active branch).
- new: an unrelated fresh `thr-` branch, cold start (standing facts still load).
- fork: a `fork-` child branch carrying `parent_branch_id` + `fork_point` (the
  parent's latest turn at fork time). Its recency is the parent's turns up to the
  fork point plus its own, with no data copy. The child summary is seeded from
  the parent.
- incognito: an ephemeral `inc-` branch. The turn is answered normally but the
  gateway skips ALL persistence: no chat/voice turn file or ledger line, no
  product event, no gbrain write, no PCM voice archive, no rolling summary, and
  no broker event. The reply carries `context: { action: "incognito", persisted:
  false }`. This is the explicit carve-out to "no spoken intent is ephemeral".

Every non-incognito turn gets per-query enrichment, assembled LLM-free at read
time within the existing char budgets, in priority order: (1) standing facts,
(2) thread recency scoped to the active branch with fork-point inheritance, and
(3) a bounded semantic recall block from `brain.recall` over rolling thread
summaries (`moa/memory/thread/*`) and intent memories, deduped against the
recency block. Rolling per-thread summaries are regenerated asynchronously after
the response is sent (never adding turn latency) on a turn-count cadence and when
the user moves off the thread, and indexed into gbrain for later recall. The
context decision, the thread store, and the enrichment blocks never fail a turn:
any error falls back to continue on the caller branch with standing-facts recall.

### Voice Work-History Control Plane

```text
spoken/typed work-history turn
  -> gateway stores the turn + one canonical broker_event (broker-first)
  -> deterministic intent parser maps ONE spoken operation:
     create task/run, status query, feedback, deployment link, ui.open
  -> gateway appends durable proposal records as product events
     (work_task, queued run, user_feedback, run_control_request,
      deployment_request, ui.open tool_request)
  -> workers claim queued runs and post before/after repo snapshots,
     diff refs, verification artifacts, and lifecycle events
  -> clients claim ui.open tool requests and post receipts
  -> status/deployment/run-detail answers fold from projections only
```

This is the first implementation slice of
`reference/openspec/changes/remote-hosted-gateway/voice-work-history-control-plane.md`.
Voice creates durable intent and queries history; it never executes shell,
browser, Android, or deployment work. A queued run stays inert until a worker
records `run.claimed`. A spoken correction attaches as `user_feedback` without
canceling; explicit pause/cancel creates a `run_control_request` that only the
owning worker can claim and receipt. Deployment-link questions read
`deployment_record` projections; an applied record is rejected unless it carries
an explicit promotion marker plus backup and restore-check refs. "Open the run
on my phone" queues a `ui.open` tool request through the cross-device tool hub;
the gateway never opens UI itself. All records are product events, so every
projection (status, run detail, deployment links) rebuilds from the event log.

Endpoints live under `/v1/work-history/*`: `turns` (spoken/text entry),
`status`, `tasks`, `runs` (+ `claim`, `events`, `snapshots`, `diffs`,
`verifications`), `feedback`, `controls` (claim/receipt), and `deployments`
(+ `requests`). `POST /v1/voice/turns` routes matching transcripts through the
same path before the legacy dispatch branch, so a status question never
launches work and an explicit "queue a run" creates a queued run instead of
starting a harness.

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

### Account Connection And Credential Health

```text
User connects a provider account (POST /v1/account-connections)
  -> gateway returns a short-lived user action: OAuth URL or gateway secret form
  -> user completes it in a browser; the provider redirects back to the gateway
  -> gateway stores the credential encrypted (AES-256-GCM) server-side
  -> a periodic health pass refreshes OAuth credentials before expires_at
  -> when refresh fails or is unsupported, the gateway marks action_required,
     queues a credential_health notification for the target device, and the
     user reauthorizes through a fresh short-lived URL/code
```

The gateway owns the whole credential lifecycle. Clients (Android, browser
extension) see only connection ids, labels, status summaries,
`credential_ref_kind`, and short-lived user-action URLs; raw provider
credentials never leave the gateway-side credential boundary. A user may hold
multiple labeled connections for one provider. Every status change appends an
audit event on the `account-connection:{id}` stream. Contract:
`reference/openspec/changes/remote-hosted-gateway/account-connection-policy.md`.

When a connection enters `needs_user_action`, the gateway writes a durable
internal notification and bridges it onto the cross-device tool hub: it creates
a `/v1/tool/requests` entry with the `notification.account_connection` tool
targeting the connection's `device_notification_target`, carrying only the
non-secret fields (connection id, provider label, connection label, reason,
`reauth_endpoint`), and links the two by `tool_request_id`. A registered device
claims and receipts it like any other tool request, so the phone or browser
actually learns it must reauthorize. A connection with no enabled device target
records a skipped notification and stays visible in the list instead of queuing
untargeted device work. The gateway also serves a read-and-fix credential panel
at `/credentials` (`GET`, gateway token entered in-page): it lists connections
with provider, status, expiry, last refresh, and needs-action state, shows
pending device notifications, and exposes refresh, reauthorize, and run-health
actions. The panel reads only the `/v1/account-connections` endpoints and never
receives raw credential material. The account-provisioning pipeline (creating
new accounts, emails, or subscriptions) is deliberately out of scope.

## Product Primitives

- `device`: a registered Android device with local permissions and settings.
- `device_client`: a connected Android, browser, or future desktop surface that
  heartbeats its online state and local tool manifest to the gateway.
- `session`: a coherent work session. The gateway owns one canonical shared
  default session per account (`GET /v1/sessions/default`); chat, voice, and
  browser turns that omit a session id resolve to it, and Android and the
  browser extension adopt it on startup so every surface continues the same
  stored conversation. Threads inside the shared session stay separated by
  `branch`.
- `branch`: a thread of work inside a session, initially `default`. A branch
  carries lifecycle metadata in the thread store: kind (default/new/fork/
  incognito), a label, and, for a fork, `parent_branch_id` + `fork_point`. New
  branches are minted as `thr-`, forks as `fork-`, and incognito branches as
  `inc-` (ephemeral, never persisted).
- `thread_summary`: a rolling per-branch summary regenerated asynchronously on a
  turn cadence and on switch-away, seeded from the parent on fork, indexed into
  gbrain under `moa/memory/thread/<branch>` for semantic recall. Never generated
  for an incognito branch.
- `context_decision`: the inspectable record of where a turn was filed (action,
  prior, prior source, model action, model override, incognito warrant, thread
  label, retrieval_query, reason), stored on the turn and mirrored as a
  `context.decision.recorded` product event.
- `active_thread`: the durable pointer to the branch a session (and optionally a
  surface) is currently on, so every device resolves the same thread.
- `turn`: one voice or chat input with optional screen context.
- `broker_event`: one inbound user message stored before routing to sessions,
  workflow packages, chat, voice, or agent runs.
- `product_event`: one canonical append-only event in the self-hostable event
  substrate, carrying origin, stream, version, actor, authority, causation,
  correlation, idempotency, payload, blob refs, and CRDT refs.
- `route_decision`: an inspectable broker decision with target, action,
  confidence, reason, context refs, workflow directory refs, and cancellation
  behavior.
- `agent_run`: a gateway-created execution-machine job with lifecycle events.
- `agent_fork`: a turn-linked async `agent_run` that can continue while later
  user turns create or update other forks.
- `voice_evidence`: replayable user/assistant audio and transcript artifacts
  attached to a turn, profile version, provider version, and test criteria.
- `audio_note`: a record-mode capture stored directly as playable audio bytes
  plus a queryable record (surface, session, content type, size, duration
  hint, label). Deliberately not a voice turn: no transcript, no reply.
- `agent_profile`: a versioned gateway-owned runtime profile for hard settings
  such as assistant voice, input languages, reply languages, response modality,
  persona (vetted catalog or sanitized free-form system prompt), model behavior,
  and mission-agent access policy. The `user_address` field (default "master",
  env `MOA_USER_ADDRESS`) carries the required form of address for the user; it
  is emitted as an explicit directive after the identity instruction in every
  prompt assembly (chat and Live voice), so it survives companion apply,
  profile reset, and persona rewrites. The global profile applies to all devices;
  device overrides persist only for a named device client. Profile-change
  responses report the scope and device id they applied to. The current
  language catalog is intentionally limited to English (`en-US`) and Amharic
  (`am-ET`) until the product scope explicitly expands.
- `companion`: a gateway-owned manifest for a selectable or user-created helper.
  It bundles assistant identity, role instructions, voice, appearance hints,
  starter prompts, smoke prompts, and discovery tags. Applying a companion
  patches `agent_profile` with active companion metadata and behavior fields; it
  does not grant phone, browser, or execution-machine authority.
- `companion_pet`: a gateway-owned visual manifest attached to a companion. It
  describes the Shimeji-style web renderer, sprite source, palette, motion,
  frame actions, weighted behaviors, drag/walk/climb/fall affordances, and
  gateway-side image/animation generation metadata. Applying a pet applies the
  underlying companion through the same versioned `agent_profile` path; it does
  not add any executable client code or provider credentials.
- `browser_agent_owner`: the single active browser tab/page/run that may listen,
  speak, and show browser-local task cues for a browser session; non-owner tabs
  can show passive status but must not capture voice or claim local cues.
- `browser_task`: a gateway-created browser work request that a Chrome extension
  client must claim, execute locally with allowlisted actions, and receipt.
- `work_task`: the user-facing durable unit of intent in the work-history
  control plane, linking broker event, session, runs, and status events.
- `repo_snapshot_ref`: a worker-recorded before/after/checkpoint codebase state
  (branch, commit sha, dirty state) attached to a claimed run.
- `diff_ref`: the before->after link between two repo snapshots with changed
  paths, stats, and a patch artifact ref.
- `verification_artifact`: one command/smoke/manual-QA result with surface,
  exit code, status, and speakable summary, attached to a run.
- `user_feedback`: a follow-up utterance stored as evidence against tasks,
  runs, or deployment records; non-interrupting unless explicitly cancellation.
- `run_control_request`: a pause/cancel/redirect proposal the owning worker
  must claim and receipt before the run state changes.
- `deployment_record`: preview/artifact/applied deployment state with URLs and
  commit sha; applied records require explicit promotion plus backup and
  restore-check evidence.
- `tool_source`: an agent-callable integration source such as OpenAPI, MCP,
  GraphQL, or a custom gateway function.
- `tool_request`: a gateway-queued request for a specific device or surface to
  run one advertised local tool and post a receipt.
- `execution`: a durable gateway-side workflow or tool call with status,
  checkpoints, and resume/cancel metadata.
- `account_connection`: a gateway-owned link between one user and one provider
  account or subscription, with encrypted server-side credentials, health
  state, and reauth actions.
- `action_proposal`: structured server output asking the phone to perform work.
- `approval`: a local user decision for non-trivial actions.
- `receipt`: local audit record for executed phone actions.
- `self_extension_artifact`: a persistent, inspectable customization or
  capability artifact proposed from user intent. Examples include
  `avatar_behavior`, `theme_spec`, `view_spec`, `workflow_spec`,
  `tool_binding_spec`, and `code_patch_spec`.
- `self_extension_variant`: a candidate artifact in a variant group so the user
  can try parallel looks or behaviors without losing older versions.
- `self_extension_runtime`: the bounded gateway projection of currently active
  artifacts that clients fetch and interpret. It is data, not privileged code.

Every new feature should attach to at least one primitive above. If it does not,
the architecture is still fuzzy.

The gateway can run local JSON/JSONL fallback storage for early device QA, but
Postgres is the production store target. The work graph now uses Postgres when
`DATABASE_URL` is set: nodes, append-only work events, and produced artifacts
are queryable gateway records. Agent-run files, sessions, tool sources,
executions, approvals, and receipts should continue moving behind the same
Postgres storage boundary. The gateway also exposes the first product event
substrate slice: `/v1/events` appends and queries canonical `product_events`,
with the same envelope persisted to a local `product-events.jsonl` fallback when
Postgres is not configured. Chat turns, voice turns, profile changes, agent-run
events, browser tasks, tool requests, receipts, work events, and work artifacts
now mirror into that substrate while legacy read paths remain intact. DBOS-style
durable execution remains a separate consideration for resumable workflows and
queues.

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
- `gateway/public/credential-panel.html`: gateway-served credential-autopilot
  panel at `/credentials`; lists account connections, credential health,
  expiry, and pending device notifications, and drives refresh/reauth/run-health
  over the `/v1/account-connections` endpoints. No raw credential ever reaches
  it.
- `gateway/lib/account-connections.js`: account-connection store (encrypted
  credential boundary, refresh/health loop, internal notification queue). Its
  `onUserActionNotification` hook bridges a needs-action notification onto the
  device-hub tool-request queue; `gateway/server.js`
  (`bridgeCredentialNotificationToDeviceHub`) supplies that hook. Smoke:
  `scripts/smoke-account-connections.js` (lifecycle) and
  `scripts/smoke-credential-device-notification.js`
  (`npm run smoke:credential-notify`, the transition -> device notification ->
  claim -> receipt bridge, plus the panel route).
- `gateway/lib/event-substrate.js`: product event substrate adapter for
  Postgres `product_events` or local `product-events.jsonl`.
- `gateway/lib/self-extension-artifacts.js`: self-extension artifact store,
  validators, active pointers, and runtime projection for conversational
  customization.
- `gateway/schema.sql`: Postgres schema for work graph records, product events,
  projection checkpoints, event blobs, and sync import checkpoints.
- `gateway/lib/voice-intent.js`: pure voice-turn classifier
  (chat / agent_run / multi_agent / control), unit-tested in
  `scripts/smoke-voice-intent.js`.
- `gateway/lib/thread-store.js`: durable per-session branch metadata, the
  active-thread pointer, and rolling per-thread summaries; behind the
  `/v1/threads` endpoints. Smoke: `scripts/smoke-threads.js`.
- `gateway/lib/context-decision.js`: pure deterministic prior + double-gate
  resolver for the `context_management` decision (continue/new/fork/incognito),
  plus the tool schema. Smoke: `scripts/smoke-context-decision.js`
  (`scripts/smoke-thread-enrichment.js` covers enrichment,
  `scripts/smoke-incognito.js` covers the incognito persistence invariants).
- `gateway/lib/work-history-intent.js`: deterministic parser for the spoken
  work-history operations (create/status/feedback/deployment/ui-open),
  unit-tested in `scripts/smoke-work-history-intent.js`.
- `gateway/lib/work-history.js`: event-sourced work-history control-plane
  store: tasks, queued runs, claims, snapshots, diffs, verifications, feedback,
  control requests, deployment records, and rebuildable projections.
- `gateway/scripts/smoke-work-history.js`: end-to-end control-plane smoke
  (voice create, worker evidence, status, feedback, cancel receipt, deployment
  links, ui.open claim/receipt), run via `npm run smoke:work-history`.
- `gateway/lib/research-workflow.js`: broker research fan-out engine (derive
  sub-queries -> pass per sub-query -> refine pass -> report); pure and
  deterministic by default. Behind `POST /v1/broker/research`. Smoke:
  `scripts/smoke-research-workflow.js` (`npm run smoke:research-workflow`).
- `gateway/lib/audio-notes.js`: record-mode audio-note store (raw bytes +
  JSON sidecars under `DATA_DIR/audio-notes/`), served by the
  `/v1/audio-notes` routes; deterministic smoke in
  `scripts/smoke-audio-notes.js` (`npm run smoke:audio-notes`).
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
- `.github/workflows/android-ota.yml`: commit-triggered Android OTA artifact
  build and main-machine deploy.
- `gateway/Dockerfile`, `docker-compose.yml`, `docker-compose.vps.yml`: one
  gateway image and the VPS stack (gateway + Postgres + Caddy TLS).
- `gateway/deploy/vps`: VPS runbook, Caddyfile, and compose env example.
- `scripts/vps`: droplet bootstrap, update, backup, and restore-check scripts.
- `reference/openspec/changes/define-android-core-product-map`: current product map,
  capability specs, staged tasks, and acceptance criteria.
- `reference/openspec/changes/thin-client-gateway-architecture`: browser extension
  thin-client / persistent-engine decision record.
- `reference/openspec/changes/context-thread-management`: thread/fork/incognito
  semantics, the `context_management` decision, and per-query enrichment.

## Deployment Topology

The gateway ships as one Docker image whose behavior is selected by env, never
by build variant (`reference/openspec/changes/remote-hosted-gateway`):

```text
MOA_MODE=local      dev default: no auth required, file fallback allowed,
                    loopback bind
MOA_MODE=self-host  remote: MOA_GATEWAY_TOKEN + DATABASE_URL required at boot,
                    binds 0.0.0.0, trusts proxy-forwarded protocol
MOA_MODE=hosted     self-host plus per-user accounts and backup expectations
```

The VPS stack (`docker-compose.yml` + `docker-compose.vps.yml`) runs gateway,
Postgres, and Caddy TLS on one droplet. Named volumes hold the shared event
store and `DATA_DIR` blobs; they survive image rebuilds and git updates. A
preview stack runs under a different compose project name with its own volumes;
that is a preview, not a rollback of the active store. Promotion (update,
active URL change, active-service restart) requires a Postgres dump, a
`DATA_DIR` snapshot, and a passing scratch restore check first
(`scripts/vps/backup.sh`, `scripts/vps/restore-check.sh`).

Agent harnesses and their credentials never run on or mount into the VPS
gateway; remote agent execution uses the worker-pull model where the user's
execution machine connects outbound to claim queued runs.

## Deployment Finish Loop

Agents must treat preview deployment or release artifact creation as part of
completion for deployable surfaces:

```text
verify changed surface
  -> fix failures
  -> commit the unit
  -> create or update the preview deployment or release artifact
  -> promote the active target automatically when the active-promotion gate passes
  -> smoke-check the promoted target or record the blocker
```

The active-promotion gate requires a passing preview smoke, a known rollback
path, proof that no running recording, voice turn, upload, agent run, queue job,
migration, or user session will be stopped or stranded, and state compatibility
across old and new code. Stateful changes use staged releases: add schema or
storage first, run bridge code that reads old and new state, backfill with
idempotent jobs, switch reads after verification, and remove old state only after
active code no longer needs it.
Promote automatically when the gate is proven. Wait at the preview or artifact
when it is not proven.

`scripts/deploy.sh auto` is the repo-level active-promotion target after the
gate passes. It deploys only committed gateway, Android, and browser-extension
changes since each target's last successful deploy marker, and skips dirty
target files so uncommitted work is not published. Explicit deploy targets
remain available when a human or agent needs one surface: `gateway`, `android`,
`extension`, or `all`.

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
- Connected-account credentials live only in the gateway's encrypted credential
  store; API responses expose `credential_ref_kind`, never credential values.
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
- Self-extension artifacts are proposed data until the gateway validates them and
  a supported client renders or executes them inside its own authority boundary.
- Privileged Android and browser code must not execute arbitrary generated code
  from self-extension artifacts.
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
