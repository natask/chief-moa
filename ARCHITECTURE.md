# Moa Architecture

## Purpose

Chief Moa is a local delegated-action product and surface family. Its core loop
is platform-neutral:

```text
permission-scoped Surface (Android, browser, macOS, Windows, iOS, ...)
  -> captures explicitly granted voice, text, and optional local context
  -> sends a structured turn to the self-hosted gateway
  -> receives an answer, run status, or action proposal
  -> the Surface applies local policy before any platform-local action
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

Native desktop surfaces
  Own: platform UI, Accessibility/UI Automation permission, product observation
  grants, local redaction, outbound preview, native action validation and
  approval, semantic execution, and canonical local receipts. macOS and Windows
  use separate supported platform adapters and never inherit authority merely
  from sharing an Aggie session. `MoaMac` may release bounded AX context and an
  independently enabled focused-window screenshot only to the user's configured
  Aggie gateway during an explicit visible grant.

Website
  Owns: the public marketing surface and static account/customization tools
  such as the companion pet studio. It may call same-origin Pages Functions that
  proxy to token-guarded gateway endpoints, but it must not hold provider API
  keys, raw gateway tokens, or local execution authority in browser JavaScript.
  For voice, a Pages Function mints short-lived voice session tickets with its
  server-side token; the browser connects the `wss://.../v1/voice/sessions`
  socket with the ticket only, and may send a per-session `voice` override
  (e.g. a pet speaking in its own voice) that never mutates the stored profile.

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

## Context-to-capability boundary

Browser, Android, macOS, and Windows publish bounded active-app/page descriptors
and local execution-adapter advertisements through the same device-client
contract. These observations contain identity and freshness evidence, not page
bodies, accessibility text, credentials, or instructions. The gateway combines
them with its own declarative service catalog, project context, and opaque
account-connection summaries to rank API, browser-session, and device-local
candidates. Resolution is deterministic planning only; it performs no action.

The model-facing execution surface remains small and generic. Adding a service
catalog entry or connector adapter must not register another permanent model
tool. An official API connection keeps credentials in the gateway or an
approved external broker. An already authenticated browser is a local executor,
not a credential source: cookies, authorization headers, passwords, and browser
storage never move to the gateway. Every side effect still becomes a bound
proposal that the owning gateway/device policy revalidates, approves, executes,
and receipts.

## Cross-surface release boundary

Release selection is a shared planning contract over immutable artifact
metadata, compatibility, rollout cohort, and declared rollback. It never
downloads or installs software. Platform adapters retain native trust and
installation authority: Android verifies and hands an APK to the package
installer, browser releases use Chrome Web Store policy or a development reload,
macOS uses Sparkle 2/App Store/managed distribution, and Windows uses Microsoft
Store or App Installer/MSIX. Common metadata cannot replace APK signer
continuity, Apple code signing/notarization, Authenticode/publisher identity, or
store review.

CI build evidence, an uploaded artifact, store submission, publication,
installation, and post-relaunch smoke are distinct states. No earlier state may
be reported as a later one. macOS and Windows remain protocol/library seams
until native application packaging, signing, installation, and recovery are
proven on their respective platforms.

## Billing and entitlement boundary

Billing facts are gateway-owned, tenant-scoped and append-only. Price and budget
authority is versioned; usage and reservations reference an immutable version,
and money is represented only as safe integer minor units plus a three-letter
currency code. Provider webhook input is evidence until its raw-body signature,
timestamp, event identity and payload digest pass verification; even then it is
stored as `verified_unapplied` and cannot directly mutate an entitlement.

The provider-neutral sandbox adapter has no charging effect. Real provider,
pricing, tax, refund, dispute and grace policy remain intentionally unwired.
Billing tables use FORCE RLS and deny application-role update/delete. The local
domain seam proves deterministic invariants, but Postgres migration/restore,
cross-process atomic budget reservation and live-provider behavior require
separate isolated evidence before the seam can become payment authority.

## Companion package boundary

Portable companions are canonical signed data and bounded image/audio assets,
never executable extensions. The provider-neutral verifier requires a
caller-owned Ed25519 trust store, accepted-license set, moderation-policy set,
protocol version and revocation snapshot. All policies are empty and fail
closed by default: a valid signature alone is not marketplace authority.

The local package envelope is JSON rather than an extracted archive. Its initial
portable-media profile accepts only fully parsed PNG and PCM-style WAV
containers; broader formats require equally strict bounded parsers. It rejects
unknown fields, traversal, polyglot/trailing or executable media, and undeclared profile fields;
checks encoded, per-asset, total-byte, count and dimension limits; and verifies
each content hash before returning an immutable value. Preview, apply and revert
records are hash-chained non-mutating plans. They do not write a profile,
publish a listing, fetch remote content or execute a capability. Hosted sharing
and actual profile apply wait for identity and Aggie/MX protocol authority.
Public trust roots, accepted licenses, moderation/appeals, offline revocation
freshness and client rollback remain intentionally unwired.

Gateway runtime companion mutation now sits behind an additional authority
boundary. Preview accepts only a verified package under an operator-owned trust,
license, moderation, compatibility and revocation policy. Apply requires an
Ed25519 approval from an operator-configured device/approver key and binds that
approval to the package digest, preview receipt, exact profile version and
global/device scope. Apply and rollback require profile-effect receipts and are
idempotent. The older catalog/pet identifiers remain useful for discovery and
drafting but cannot directly mutate the active profile. With no operator policy,
the runtime boundary denies all package apply operations.

The billing runtime seam likewise defaults to deny. When an operator supplies
tenant-owned immutable sandbox facts, authorization requires the latest active
entitlement and a budget reservation against an exact version; usage must match
the immutable price calculation before it is recorded. These routes always
report `sandbox_no_charge` and never invoke a payment provider. JSONL receipts
are operational audit evidence, not a substitute for the existing relational
billing migration or proof of cross-process transactional authority.

## Telemetry and observability boundary

Canonical product events remain the source of truth. Operational telemetry is a
derived, loss-tolerant projection and must never decide product state. Moa owns
the versioned semantic envelope, redaction/allowlist policy, release metadata,
and cross-surface correlation before any vendor translation occurs.

The gateway telemetry foundation exposes a bounded asynchronous exporter seam.
Exporter rejection, timeout, or queue overflow may drop telemetry and increment
local counters, but cannot fail the product operation. User content, identity,
credentials, financial data, and high-cardinality IDs are excluded by default;
opaque release/correlation identifiers use numeric `major.minor.patch` plus generated or validated
`prefix_uuid` formats and are not metric dimensions. Export timeouts abort the
adapter signal and quarantine new export starts until the timed-out underlying
attempt settles, so a non-cooperative adapter cannot pile up unresolved export
work. Client SDKs, consent-aware analytics, and a Collector/backend remain
inactive until identity policy and an isolated preview satisfy the telemetry
OpenSpec.

The gateway may propose actions. The Android app decides whether an action is
allowed, whether approval is required, and whether the current device state still
matches the proposal.

## Aggie surface protocol boundary

Aggie is the gateway-owned personal-agent session contract; Moa browser,
Android and future native clients are thin compatible surfaces. Protocol
versions N and N-1 share bounded typed envelopes for turns, events, action
proposals, approvals and local receipts. Unknown additive fields are ignored,
but unknown semantic types, executable/credential-shaped payloads, cross-session
replay, sequence conflicts, expired actions and stale state fail closed.

The protocol library is transport- and provider-neutral. Its echo adapter has
no external I/O and proves deterministic contract behavior before any backend
adapter or native shell is added. It does not create a second session database:
the existing gateway event, voice, broker and work stores remain authoritative.
Local clients alone validate current device state, request required approval,
execute allowed local effects and upload receipts. Platform UX, secure storage,
signing, updates and device behavior require separate per-OS evidence.
This protocol slice binds approvals to a canonical proposal digest and receipts
to proposal-message correlation. It does not authenticate a device or actor;
transport authentication, device signing and native execution remain outside
this module and must not be inferred from those correlation checks.

### Apple native surface and authority seam

`apple_surfaces` is a shared, portable macOS/iOS Swift authority library that
consumes the same bounded Aggie N/N-1 proposal contract. It owns only local
decoding, explicit approval coordination, final expiry/state revalidation,
bounded replay and local receipt formation. Stateful authority is
actor-isolated and any effect is available only through an injected executor
after all local checks pass.

The library seam has no transport, provider credential, canonical conversation
store, Keychain policy, OS action implementation, SwiftUI product shell,
signing, update or distribution authority. The `AggieSurfaceApp` product is a
static SwiftUI demo shell over this seam; an unsigned macOS or iOS Simulator
build is compilation evidence only and does not establish device behavior,
security, accessibility, energy use, signing or production readiness. Permanent
companion versus seamless-assistant UX remains an explicit product decision.

The macOS-only `MoaMac` product adds the native proactive surface:

```text
menu-bar app or Control-Space
  -> app-owned compact command panel (no AX read or pixel capture)
  -> bounded authenticated POST /v1/chat to the user-configured gateway
  -> inert assistant text rendered in the panel
```

The command panel stores the canonical gateway origin in app preferences and
the gateway bearer token in Keychain. It contains no packaged destination or
provider credentials, rejects redirects, uses an ephemeral URL session, and
never attaches screen context implicitly. Provider selection and credentials
remain gateway-owned. This is the first daily companion slice; ticketed live
voice, shared session-event presentation, pointer overlays, and approved native
actions remain staged work.

The privacy-scoped proactive flow remains separate:

```text
Paused launch (no AX read, screen capture, or network)
  -> user selects the verified frontmost process
  -> user chooses local_only, ask_each_time, or trusted_server_15m
  -> optional focused-window screenshot is enabled separately
  -> visible 15-minute grant starts scoped AX observation
  -> bounded/redacted observation becomes a local suggestion or an immutable
     POST /v1/proactive/macos request to the configured Aggie origin
  -> bounded inert suggestion card; no action executes from that response
```

The grant is memory-only and binds bundle id, PID, launch date/process
generation, and verified signing identity. Pause/Stop, expiry, app/process
change, permission loss, or asynchronous generation change invalidates queued
work. AX traversal is bounded to 128 nodes/depth 8/16 KiB and suppresses secure
subtrees/editable values. ScreenCaptureKit is off by default and may capture
only the same process's focused window, re-encoded and size-bounded. Neither
macOS permission alone starts observation or release.

There is no packaged gateway destination. Network modes require a canonical
user-configured HTTPS origin (HTTP only on loopback) and a Keychain bearer token.
Ask mode binds exact serialized bytes and SHA-256 to a final approval;
trusted-server mode displays the origin/evidence/screenshot scope and expiry.
The gateway route requires exact bearer authentication, treats AX/pixels as
untrusted evidence, exposes no tools, returns `{version,suggestion,actions:[]}`
only, and does not persist a conversation, task, run, or broker event.

The public semantic AX action vocabulary and Aggie approval coordinator compile,
but live native mutation remains disabled until gateway proposal ingestion,
element/state fingerprint binding, and fsync-backed pending/terminal receipts
are wired and audited. The current ad-hoc-signed QA bundle is compilation and
package evidence only; it has not been launched or TCC-tested and is not a
production signing/notarization artifact.

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
the primary surface toward voice. Android uses the reviewable v4 contract:
Single click starts a draft with visible `X — orb — ↑` controls (discard and the
single Send action); later orb taps never commit it. Those controls are separate
overlay windows beside the orb, so the transcript card above or below the orb is
never the disposition authority. Double-click cancels the current draft
and starts a fresh voice thread that does not use the current thread's replies,
and triple-click cancels voice and opens the demoted chat surface. A still
first-press hold is push-to-talk (release commits; a large move after the hold
confirms cancels capture and escapes into a drag). The one open chat/transcript
card follows the orb and flips wholly above or below it. Dragging into the
bottom removal target, or choosing Hide in the chat header/foreground
notification, stops the overlay service and removes all overlay windows. The
flag off keeps Android's legacy gesture contract. The browser flag uses the
same `X — mascot — ↑` draft controls and explicit-send rule; its flag-off mapping
and keyboard shortcuts remain unchanged. Contract:
`reference/openspec/changes/voice-first-orb-gestures/proposal.md`.

The overlay surface stays small: it shows the current intent/result and compact
run state, not a full scrollback manager. Browser text replies render in the
result stack above the command input; replies, errors, and voice state never
clear or replace the user's current input draft. Browser voice keeps that input
available, shows partial/final user transcript feedback above it, and streams
assistant text into the result stack above the input. The gateway still stores
durable session, branch, turn, transcript, provider-event, and agent-run
history. Realtime providers receive a bounded Moa-owned context pack at session
start so provider memory is not the product database. The gateway's chat and
cascaded voice paths assemble that pack through a canonical context-artifact
envelope with versioned cache identity, stable source ids, ranking rationale,
and secret-like-text redaction before any provider call. If the user wants
history, they ask Moa for it through the same intent surface instead of
browsing visible scrollback.

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
provider cannot call tools. The same tool loop carries a per-surface skill
registry (`gateway/lib/surface-skills.js`): `resolveTurnSurface` reads the
turn's source to decide which code-mode capabilities `cascadedExecuteCapabilities`
offers, so phone_* capabilities (`phone_open_app`, `phone_open_url`,
`phone_dial`, `phone_open_contact`) and browser_* capabilities
(`browser_agent_task`, `browser_open_tab`) are available cross-device from
every surface, matching the cross-device tool hub's own reach. Classic
(non-code-mode) fallback tools, `phone_action` and
`launch_background_browser_task`, sit next to the profile tools in the same
tool loop so the same phone/browser reach works even when the `execute`
code-mode tool is off. The `execute` tool is on by default
(`VOICE_EXECUTE_TOOL` defaults to enabled; set `VOICE_EXECUTE_TOOL=0` to
disable it), and `/health` reports `execute_tool: { enabled,
capability_count }`. Language switching is exclusively model-owned: the
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

Public web search follows a different boundary from code mode. On ordinary
Vertex reasoning calls the gateway offers the model provider's native Google
Search tool, so retrieval and grounding remain provider-visible. Providers
whose current gateway protocol cannot expose native search may receive a
bounded Exa `web_search` function when its gateway-side key is configured.
Search never becomes arbitrary QuickJS network access: code mode still sees
only registered `tools.moa.*` integration capabilities. Retrieved page text is
untrusted evidence, not instruction or execution authority, and answers are
prompted to cite the source URLs they use. Forced control-plane calls such as
context preflight remain function-only and do not receive search.

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

An off-by-default hybrid trial keeps the registry-selected `native_live`
implementer as the reasoning and spoken-response path while composing it with
an independent transcript implementer. With
`VOICE_TRANSCRIPT_SIDECAR=chirp`, every gateway-received PCM frame fans out to
both the selected duplex-audio provider and Chirp 3 streaming recognition. The
duplex provider reasons directly over audio and may emit bounded tool proposals;
Chirp partials alone drive the visible live transcript so two competing
transcript streams do not flicker in the client. On commit, a successful Chirp
final becomes the canonical transcript and the duplex provider's input
transcription is retained as comparison evidence; an unavailable, empty, or
failed sidecar falls back to the duplex provider without failing the
speech-to-speech turn. Cancel, turn replacement/barge-in, and socket close tear
down both upstream streams. Client `session_start`, `commit_turn`, `cancel_turn`,
touch/keyboard gestures, and local approval events remain authoritative control
signals rather than audio-derived model guesses. Contract:
`reference/openspec/changes/provider-agnostic-voice-agent-runtime/native-audio-transcript-sidecar-trial.md`.

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

### Streaming cascaded voice

```text
gateway LLM turn streams text deltas (Vertex SSE / OpenAI-compatible SSE)
  -> a pure sentence/clause chunker (Latin + Ethiopic + Arabic + CJK
     boundaries) slices deltas into speakable pieces as they arrive
  -> pipelined hosted TTS synthesizes each piece (bounded concurrency, at
     most 2 in flight) and emits PCM in strict chunk order
  -> assistant_audio_start fires on chunk 1, mid-LLM-stream; assistant_text
     (the full reply) follows once the stream ends; assistant_audio_done and
     turn_done close the turn
```

Cascaded voice turns stream by default (`VOICE_STREAMING`, unset or `1`). The
wire protocol keeps the event set used everywhere else: one
`assistant_audio_start`, N binary PCM16 frames, one `assistant_audio_done`,
one `turn_done`. Only the frame count and the ordering change for a
multi-chunk reply: `assistant_text` now arrives after the first binary frame
instead of before it, because both clients already read `assistant_text` and
`assistant_audio_start` independently of order, proven first by the Gemini
Live and loopback providers, which already stream many frames per turn.
`assistant_audio_start` carries an additive `streaming: true` flag, and
`turn_done` carries additive `first_audio_ms` and `tts_segments`; every other
`turn_done` field is unchanged. `VOICE_STREAMING=0` reproduces the exact
prior single-frame, text-before-audio sequence and is the slow rollback path:
the droplet needs a container recreate to pick up the env change, so a faster
in-process circuit breaker (below) covers the same failure class without an
operator.

A same-commit interruption guard makes streaming safe against barge-in: the
session server re-checks turn identity and non-terminal status at hook entry,
again immediately before every socket write, and again before
`assistant_audio_done`; a closed-turn write to the assistant audio stream is
dropped rather than reopening or truncating a finalized PCM file, mirroring
the 2026-07-06 crash-loop fix for the equivalent user-audio write. A streaming
fault trips a per-process circuit breaker after 3 failures, latching every
later turn in that process onto the non-streaming path with no operator
action, because the deploy gate's restore-check never drives a real voice
turn.

Each assistant PCM frame is preceded by an additive
`assistant_audio_segment` event containing its text bounds, byte count, and
PCM duration. Android and the browser correlate those bounds with their local
playback clocks and send a final `playback_progress` event before a cancel or
close. The gateway clamps that checkpoint to audio already emitted, persists
it on the incomplete turn, and supplies an endpoint-observed played prefix and
unheard suffix to the next durable context. This is presentation evidence, not
proof that a human heard the audio. Older clients safely ignore the additive
segment event.

The chunker (`gateway/lib/voice-chunker.js`) is pure and timer-free: sentence
enders (`. ! ? …` and Ethiopic `። ፧ ፨`) are the primary boundary, clause
enders (`, ; :` and Ethiopic `፣ ፤ ፥`) apply once the pending text is already
past a minimum length, and a hard split at the last whitespace applies past a
maximum length. The first chunk of a reply uses tighter thresholds so the
first sentence reaches TTS as fast as possible, and a bracketed
expressive-speech tag (`[sigh]`, `[style: ...]`) always stays with the prose
it modifies.

`VOICE_TTS_MAX_CHARS` (280) is untouched and keeps bounding every
non-streaming caller (browser-evidence speak caps, the profile default, and
the `VOICE_STREAMING=0` path). A separate `VOICE_STREAM_MAX_CHARS` (1600)
bounds only the streaming sanitizer; streamed speech is guaranteed to be a
prefix of the stored capped reply, not necessarily byte-identical near the
cap.

Provider internals sit behind a formal seam, `gateway/lib/voice-stages.js`
(`SttProvider`/`Reasoner`/`TtsProvider`, registry-driven `create(options)`
factories), with `streaming_tts` and `streaming_reasoning` capability flags
surfacing on `/health`. The outer contract does not move: `processTurn(turn,
hooks)`, `status()`, and `synthesizeAssistantSpeech` are unchanged, so the
session server, Android, browser, and the LiveKit worker's internal voice
hooks never see the stage seam.

Turn records stay additive-only. N TTS chunks still append into the same
single `${turnId}.assistant.pcm` file used today, and `streaming`,
`first_audio_ms`, and `tts_segments` are additive fields on the provider
result and canonical record; no migration is required, and rollback to the
previous ref or `VOICE_STREAMING=0` reproduces the prior record shape exactly.

Rollout is gateway-first: merging and pushing promotes through the existing
`Deploy VPS gateway` workflow and droplet auto-update timer, since old clients
already tolerate the multi-frame wire behavior. Live QA on both the phone and
the browser immediately after promotion is mandatory, not optional
observation, because the shipped Android APK and packaged extension exercise
the cascaded path only in its single-frame form in production; QA confirms
`/health` reports `streaming_tts: true` and voice-provider-events carry
`first_audio_ms`. Contract:
`reference/openspec/changes/streaming-cascaded-voice/proposal.md`.

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
extension-local state keyed by the stable browser session, current tab,
cue/voice-session ids, and latest status/result; it is not content-script-local
memory. Page URL/title may be used locally while coordinating explicitly invoked
page work, but the privacy migration scrubs them and device heartbeat never
includes them or the owner object. The browser voice path must not use browser
Web Speech APIs in production, and the extension must not hold raw
Gemini/OpenAI/Anthropic provider credentials.

Gateway-originated browser work uses the same ownership boundary. The gateway
stores `/v1/browser/tasks` records and Live/tool agents may enqueue bounded
browser work, but the Chrome extension claims those records only after the user
has granted current, versioned background-automation consent. It runs
allowlisted CDP methods locally through `chrome.debugger` and POSTs a receipt
back to the gateway. The gateway records that receipt against the task and
linked agent run; it does not execute browser CDP itself.

Browser-originated chat and describe turns carry the same gateway session and
branch identifiers as voice turns. The gateway context APIs expose bounded
recent voice turns, chat turns, provider events, active/completed runs, profile
status, and browser task receipts so a later voice session can recover what the
browser surface did without relying on provider memory.

The authenticated browser-turn contract exposes the separately addressable
`delegate`, `help`, `collaborate`, and `explain` roles through
`GET /v1/browser/roles` and accepts an explicit `role` on
`POST /v1/browser/turns`. The catalog puts Delegate first for new selector UI,
while an omitted role remains Explain/read-only for legacy-client safety. The
gateway stores the role identity, authority, and execution policy on the turn.
An explicit Delegate turn still cannot launch from role plus prose: it must
carry a validated `moa.browser-delegation.v1` envelope binding confirmation and
the exact user intent to a goal, current page and allowed origins, action and
approval classes, checkpoints, stop conditions, maximum steps, and completion
evidence. Without it the turn returns a non-executable confirmation proposal
and no task/run. A valid envelope is persisted on the turn, bounded
`/v1/browser/agent-tasks` task, and observable agent run; the planner blocks
out-of-origin, disallowed, and non-preauthorized actions. Help and Explain emit no action or task, and
Collaborate emits at most one non-executable, confirmation-required step
proposal. Role prose cannot change this typed authority. Browser voice
`session_start` does not yet consume this contract: provider-native/cascaded
voice turns remain a separate follow-up until committed transcripts and browser
evidence can enter the same browser-turn lifecycle without prompt-only routing.

### Privacy-first proactive browser assistance

Proactive help is a distinct local mode, not an alias for continuous/ambient
upload. It starts only after the user grants the current tab/document for at
most ten minutes. The content script samples bounded structural affordance
counts while the page is visible, rejects sensitive surfaces, and feeds a
deterministic packaged classifier. It does not read page body, title, selected
text, form values, pixels, accessibility data, or cross-tab history. At most one
generic card is created per grant. Observation, suppression, expiry, and
dismissal make no gateway request.

The on-page card is a non-authoritative preview in an untrusted DOM. Every
proactive page control requires trusted activation. Review may only open
`proactive-confirm.html`; page script/CSS cannot authorize a request or change
the canonical disclosure. The extension-owned confirmation shows the exact URL,
`POST`, JSON content type, authorization presence with its value hidden,
`redirect: error`, exact body and SHA-256 digest, Chief Moa retention boundary,
configured-provider processing warning, exclusions, and the independent
`enabled`/`disabled` background-connectivity state. Only its trusted Allow
activation can proceed.

The worker binds both transitions to the exact top-level tab/document/frame. It
revalidates document/frame and sensitivity before opening confirmation and again
after Allow, then verifies expiry, destination/body digests, and record identity.
It atomically consumes and removes the grant, marks the confirmation as inert
in-flight status, and prevents any second decision before sending at most one
`POST /v1/proactive/turns` body tagged `proactive_accept_v1` with redirects
blocked. It does not attach screen/page evidence, observed structural counts,
actions, tasks, workflows, broker instructions, or agent instructions.

The gateway endpoint enforces an exact body and packaged-prompt allowlist,
requires a configured exact bearer token even in local mode, then calls the
configured model provider directly under a text-only contract. Provider
requests use one fixed system message plus one allowlisted prompt, no tool
schema, hard output/response limits, and a timeout covering body consumption;
Vertex token exchange is timed and bounded. It does
not enter voice/browser routing, expose tools, start an agent/task/workflow,
publish a broker event, or persist a conversation/turn. Chief Moa's
non-persistence does not imply provider non-retention: the configured provider
still processes the packaged prompt under its own data policy. Any returned
action/proposal key—including null/deep fields—or a truncated bounded response
scan is refused as an unnegotiated protocol violation and creates only a
bounded, content-free, serialized local receipt.

The ordinary injected command composer remains light DOM and is not a
confidential surface: the host page can inspect or interfere with it. Sensitive
command entry belongs in the extension-owned side panel. The proactive preview
does not render gateway origin or background-consent state into the host DOM;
those facts appear only in `proactive-confirm.html`.

Navigation, reload, history/hash change, tab close, service-worker restart,
destination change, expiry, newly detected sensitivity, or entry into a normal
command, voice, ambient, or browser-agent workflow revokes the grant and pending
confirmation. Classification is one bounded event-driven traversal; a no-card
result stops observation rather than polling indefinitely. Contract:
`reference/openspec/changes/privacy-first-browser-proactive-helper`.

The browser has no passive gateway startup path. A fresh install does not save
or contact a packaged hosted destination. The privacy migration preserves an
existing user-saved destination locally while disabling legacy polling. A
separate current-version consent gates every background task, agent-task, and
tool-request claim plus device heartbeat; missing/unreadable consent fails
closed. When enabled, heartbeat contains operational device/surface
identity and the local manifest only—never active-owner or page metadata.

The extension is a stable packaged client, not a per-user deployment unit. Chrome
Manifest V3 forbids remotely hosted executable code in privileged extension
contexts, so user customizations travel through the engine as data: a
declarative UI spec by default, sandboxed iframe surfaces for richer generated
UI, and `userScripts` only for explicit opt-in page-acting code. The same
extension package should work against a self-hosted or hosted engine by changing
only the engine URL/session token.

### Background browser agent loop

```text
model tool call or user instruction
  -> gateway creates a browser agent-loop task (`browser_agent_task`) plus a
     linked non-blocking agent run
  -> extension claims the task, opens a background tab, never activates it
  -> loop: extension posts an observation -> gateway plans one bounded
     declarative action (model-planned, text-only context in v1; a
     deterministic keyless fallback when no reasoning provider is configured)
  -> extension validates the action locally and executes it
  -> on finish, extension posts a summary; gateway records a finish receipt
     on the task and the linked agent run
```

This is the background half of browser automation: an agent that can work on
pages the user does not see, extracted from the agee action-loop prior art and
run only through the extension's own local execution. The gateway proposes
exactly one action per step from a closed vocabulary (click, type, clear,
select, scroll, navigate, key, wait, screenshot, finish); the gateway never
emits code strings, so no CSS or JS ever reaches privileged extension code.
The extension validates every proposed action against its own local allowlist
before executing it; an unknown kind is a hard reject, not a best-effort
execute. The task's tab is never activated, so background work never steals
focus from the user. A settings toggle plus versioned consent,
`ageeBackgroundAutomationEnabled` (default off), gates the whole
background-automation poll, the tool-request poll, heartbeat, and the legacy
batch `browser_task` poll. Model context in this first version is
text-only (page title, url, a bounded element list, optional page text, and
at most the latest screenshot); step history older than the last 8 steps is
summarized to one line each so a long-running task stays inside the model's
context budget. Contract:
`reference/openspec/changes/per-surface-agent-skills/design.md`.

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
that spec to known CSS classes on the Aggie/Lion mark. The tier-A generated UI
slice is `/v1/ui/spec`: the gateway validates a per-user declarative surface and
the extension fetches, caches, and renders only known controls and components
(`button`, `text`, `toggle`, `select`, `card`, `list`, `stat`, `map`) in the
overlay. The `map` component is schematic bounded data (center, zoom, markers),
not remote map tiles or executable code. No generated JavaScript is executed in
privileged extension code. Richer generated UI remains declarative or sandboxed,
and page-acting code remains opt-in through the existing `userScripts`
boundary. Browser clients preserve the last-good runtime/spec when the gateway
is temporarily unavailable and mark the cached runtime/spec stale instead of
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
  -> unless the client made an explicit choice, a dedicated context-free model
     preflight is forced to call only context_management exactly once; its text
     is discarded and it returns a retrieval_query for recall
  -> double gate: the model may override the prior EXCEPT it may only choose
     incognito with the same explicit warrant
  -> the gateway resolves one immutable filing/scope result, assembles one
     canonical artifact for that scope, then starts a fresh answer request that
     does not offer context_management
  -> only after the answer succeeds, the exact plan is committed and the turn
     is filed on that same resolved branch; completed turn-id retries replay the
     stored response without another preflight or branch mint
  -> the decision is stored
     as a record + product event
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

The preflight receives only the bounded current user text and decision schema:
no prior messages, standing facts, screen evidence, recency, recall, runs, or
tasks. Failure, malformed output, an unsupported/duplicate tool, or a provider
without tools leaves the deterministic prior in force and never triggers a
preflight plain-answer fallback. Explicit client choices and local utility
replies skip the preflight. New and incognito answer artifacts are standing-only;
fork artifacts contain parent lineage only through the captured fork point.

Every non-incognito continued/fork turn gets per-query enrichment, assembled LLM-free at read
time within the existing char budgets, in priority order: (1) standing facts,
(2) thread recency scoped to the active branch with fork-point inheritance, and
(3) a bounded semantic recall block from `brain.recall` over rolling thread
summaries (`moa/memory/thread/*`) and intent memories, deduped against the
recency block. Rolling per-thread summaries are regenerated asynchronously after
the response is sent (never adding turn latency) on a turn-count cadence and when
the user moves off the thread, and indexed into gbrain for later recall. The
context decision, the thread store, and the enrichment blocks never fail a turn:
any error falls back to the resolved scope without injecting caller history into
a new or incognito answer.

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
Android or explicitly connected browser client
  -> heartbeats to the gateway with device id, surface type, session id, and
     local tool manifest (never browser page/owner metadata)
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

The hub also carries phone automations reachable from any surface (chat, voice,
or another device), serviced through code-mode `execute` capabilities and
classic fallback tools alike. Three Android broker tools advertise, execute,
and receipt through the same claim/validate/execute/receipt path as every
other cross-device tool: `url.open` (`{ url }`, ACTION_VIEW, http/https only)
opens a URL in the phone's browser; `phone.dial` (`{ number }`, ACTION_DIAL
`tel:`) only pre-fills the dialer, since the app holds no `CALL_PHONE`
permission and the user must press call; `contact.open` (`{ name }`) looks the
contact up through ContactsContract and opens its card, requires
`READ_CONTACTS`, and returns a clear "needs contacts permission" result
instead of crashing when that permission is missing.

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

- `Chief Moa`: the product/platform and family of permission-scoped user
  surfaces. It is not the assistant persona or a canonical chat session.
- `Aggie`: the canonical personal-agent identity and cross-surface
  session/routing/policy contract. `A.G.` is a display/spoken alias; historical
  `Agee` spellings are legacy compatibility names.
- `surface`: a platform-specific input/output and local-authority adapter such
  as Moa Browser, Android, macOS, Windows, iOS, CLI, or messaging. Surfaces
  advertise different capabilities; they do not pretend platform parity.
- `observation`: ephemeral, locally scoped evidence from a page, accessibility
  tree, voice, or explicitly captured screen. It is not intent or instruction,
  and remote retention requires an explicit policy/release boundary.
- `assistance_suggestion`: a visible, expiring proposal to help, derived from an
  observation. It cannot execute, become durable intent, create a task, or
  launch a run until the user accepts it.
- `project`: a durable bounded area of focus with goals, assets, participants,
  and history, orthogonal to sessions and threads. Nesting uses
  `parent_project_id`; there is no separate subproject type.
- `workstream`: a durable line of progress or goal that may cross projects.
  This replaces ambiguous product use of “flow”; `workflow` remains a reusable
  procedure/package.
- `device`: a registered Android device with local permissions and settings.
- `project`: a gateway-owned durable work object, independent of disposable
  agent sessions. Its editable brief records the real problem, desired outcome,
  current state, and next viable step; the local gateway console reads and
  updates that brief through authenticated project APIs.
- `device_client`: a connected Android, browser, or future desktop surface that
  heartbeats its online state and local tool manifest to the gateway.
- `session`: a coherent work session. The gateway owns one canonical shared
  default session per account (`GET /v1/sessions/default`); chat and voice turns
  that omit a session id resolve to it. Android may adopt it through its own
  lifecycle, while the browser extension adopts it only after an explicit
  connected action or current background-connectivity consent, never merely on
  service-worker startup. Threads inside the shared session stay separated by
  `branch`.
- `branch`: the wire/storage name for a user-facing conversation `thread`
  inside a session, initially `default`. A branch
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
- `agent_run`: one execution attempt linked to an intent, task, or internal work
  node by a gateway-selected execution machine, with lifecycle events and
  artifacts. A retry is a new run.
- `agent_fork`: a legacy name for a turn-linked async `agent_run` that can
  continue while later
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
- `voice_binding`: a derived, additive field on active companion/pet payloads
  that names the speech provider, provider voice id, legacy voice alias, style
  (preset-only until a bounded sanitizer produces `style.prompt`), and a
  `custom_voice` enrollment record. `agent_profile.voice` stays the runtime
  source of truth; applying a pet patches `agent_profile.voice` from
  `voice_binding.provider_voice_id`, and the gateway derives `voice_binding`
  from the companion profile patch plus provider readiness. Old pets default to
  the companion/profile voice with `custom_voice.status="not_configured"`.
  Custom voice enrollment is a gateway-owned, consent-gated lifecycle that
  mutates only gateway-side consent/provider records; it is never executable
  client authority.
  The website exposes the same catalog two ways: `/pets/` (studio: search,
  create, edit, generate) and `/pets/library/` (a browsable catalog with
  animated previews for picking a pre-designed pet); both go through the same
  token-guarded `/api/pets/*` Pages proxy and never hold a gateway token in
  browser JavaScript.
- `browser_agent_owner`: the single active browser tab/page/run that may listen,
  speak, and show browser-local task cues for a browser session; non-owner tabs
  can show passive status but must not capture voice or claim local cues.
- `browser_task`: a gateway-created browser work request that a Chrome extension
  client must claim, execute locally with allowlisted actions, and receipt.
- `browser_agent_task`: a gateway-created background agent-loop task
  (instruction, optional start url, status, step history, a linked
  `agent_run`) that a Chrome extension client claims, drives through
  observe/step/act in a non-activated background tab, and finishes with a
  status and summary. Unlike `browser_task`'s single claim/execute/receipt
  request, a `browser_agent_task` is a multi-step, model-planned loop bounded
  by `max_steps`.
- `work_task`: the user-facing durable desired outcome, linking broker event,
  project/workstream/thread context, runs, and status events. Internal work
  nodes are decomposition/transport, not peer user-facing tasks.
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
- `action_proposal`: structured server output asking a specific Surface to
  perform bounded platform-local work; it is inert until that Surface validates
  it.
- `approval`: the owning Surface's local user/policy decision for a non-trivial
  action.
- `receipt`: the owning Surface's local audit record for an executed, refused,
  deferred, or failed action; optional gateway sync never replaces local
  authority.
- `self_extension_artifact`: a persistent, inspectable customization or
  capability artifact proposed from user intent. Examples include
  `avatar_behavior`, `theme_spec`, `view_spec`, `workflow_spec`,
  `tool_binding_spec`, and `code_patch_spec`.
- `self_extension_variant`: a candidate artifact in a variant group so the user
  can try parallel looks or behaviors without losing older versions.
- `self_extension_runtime`: the bounded gateway projection of currently active
  artifacts that clients fetch and interpret. It is data, not privileged code.

Canonical promotion boundary and optional routing branches:

```text
local observation
  -> assistance_suggestion
  -> explicit user acceptance
  -> broker_event (intent)
  -> route_decision
       |-> direct answer
       |-> link/create work_task
       |-> select reusable workflow
       |-> explicitly launch agent_run (linked to intent, task, or work node)
                |-> artifact
                `-> action_proposal -> Surface-local approval + receipt
```

Use verbs that preserve these boundaries: continue/fork a thread, split a task,
spawn/retry a run, and invoke a workflow. Do not use “fork” for every kind of
parallel work or “flow” for both durable progress and a reusable procedure.

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
  cross-device tool-request queue. Its separate `POST /v1/proactive/turns`
  handler enforces the packaged browser prompt allowlist and calls the configured
  model directly without router/tool/agent/durable-work capabilities or turn
  persistence.
- `gateway/lib/proactive-turn.js`: exact proactive request/client validators,
  four packaged prompt allowlist, fixed no-tools system contract, bounded inert
  response shape, and deterministic no-provider fallbacks.
- `gateway/scripts/smoke-proactive-turn.js`: isolated-port/data-store acceptance
  smoke for the proactive endpoint's exact request schema, rejection matrix,
  bounded text response, and unchanged conversation/task/workflow/broker-event/
  agent-run stores (`npm run smoke:proactive-turn`).
- `gateway/lib/broker-router.js`: deterministic broker route selection for
  sessions, projects, active runs, workflows, and new forks.
- `gateway/lib/broker-launcher.js`: bounded broker context-pack construction,
  launcher-profile selection, explicit run activation, and context-pack
  persistence. Model output remains proposal-only unless the broker request
  explicitly asks to launch a run.
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
- `gateway/lib/ui-spec.js`: engine-served tier-A UI spec store and validator
  for declarative overlay surfaces, including bounded controls plus
  `card`/`list`/`stat`/schematic-`map` components. Smoke:
  `scripts/smoke-ui-spec.js` (`npm run smoke:ui-spec`).
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
- `gateway/lib/browser-agent-loop.js`: background browser agent-loop task
  store (`DATA_DIR/browser-agent-tasks/`), create/claim/step/finish logic,
  the linked `agent_run` create, and the deterministic keyless step-planning
  fallback; behind `/v1/browser/agent-tasks*`. Smoke:
  `scripts/smoke-browser-agent-loop.js` (`npm run smoke:browser-agent-loop`).
- `gateway/lib/surface-skills.js`: `resolveTurnSurface` and the per-surface
  code-mode/classic tool registry (phone_* and browser_* capabilities,
  `phone_action`/`launch_background_browser_task` fallback tools). Smoke:
  `scripts/smoke-surface-skills.js` (`npm run smoke:surface-skills`).
- `gateway/lib/voice-session-server.js`: WebSocket PCM voice
  transport, turn storage, transcript events, and assistant audio events.
- `gateway/lib/voice-providers.js`: Swappable streaming voice
  provider package boundary, currently loopback and Gemini Live.
- `apple_surfaces/Sources/MoaMac/main.swift`: menu-bar lifecycle, global
  Control-Space registration, and floating command-panel ownership.
- `apple_surfaces/Sources/MoaMacCore/GatewayChat.swift`: bounded canonical
  macOS chat request and inert reply decoding.
- `apple_surfaces/Sources/MoaMacShell/GatewayChatShell.swift`: Keychain-backed
  gateway connection state and redirect-rejecting ephemeral chat transport.
- `apple_surfaces/Sources/MoaMacUI/CommandPaletteView.swift`: compact typed
  companion surface; it does not own Accessibility or capture authority.
- `android_app/deploy/ota`: Android APK OTA artifact build and
  main-machine sync scripts.
- `browser_extension/extension`: thin browser client for command,
  voice, page context, settings, engine-served UI spec rendering, and
  engine-routed browser actions, including the background agent-loop poll
  (`pollBrowserAgentTasks`) behind versioned, default-off consent and a local,
  explicit-grant proactive helper whose observe/dismiss path has no network and
  whose final authorization is isolated in extension-owned
  `proactive-confirm.html`. Its accepted request uses only the gateway's strict
  `POST /v1/proactive/turns` text capability. UI spec smoke:
  `browser_extension/scripts/smoke-ui-spec.mjs` (`npm run smoke:ui-spec`).
  Agent-loop smoke:
  `browser_extension/scripts/smoke-agent-loop.mjs`
  (`npm run smoke:agent-loop`).
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

## Source-Size Guardrail

Owned production files have a 2,000-line limit. Files already above that limit
are explicit architecture debt with exact non-growth ceilings in
`scripts/source-size-policy.js`; every extraction lowers or removes its ceiling.
The repository-wide production total is reported as a trend toward the 60,000
line milestone and 10,000-line ultimate goal, not as a hard ceiling that would
forbid adding a new bounded module. The active
`decompose-oversized-source-files` change owns the extraction backlog.

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
