---
title: Clicky, OpenClicky, and Chief MOA macOS product audit
date: 2026-07-25
status: research-complete
scope: product, architecture, and license audit; no implementation or deployment
chief_moa_baseline:
  ref: origin/master
  commit: 196f38657791c5e24f4c5fb2de5de309880823f0
clicky_open_source:
  repository: https://github.com/farzaa/clicky
  commit: a80fa80721a8aebe51a170a7780705024ebc6e46
openclicky:
  repository: https://github.com/jasonkneen/openclicky
  commit: b0b4855ceb223ef0b0a57997cc0803cbd482f336
installed_heyclicky:
  path: /Applications/Clicky.app
  display_name: HeyClicky
  bundle_id: com.humansongs.clicky
  version: 1.0.38
  build: 47
  embedded_source_marker: 61a9a3d2
  signing_team: 2UDAY4J48G
  signed_at: 2026-07-14T15:11:13-07:00
confidence: high
---

# Executive finding

“Clicky” is not one current open-source product.

1. **Original Clicky** is Farza Majeed’s native Swift macOS menu-bar/cursor companion. Its public repository is an MIT-licensed April 2026 snapshot. The maintainer explicitly says that snapshot remains open source while “all the new stuff” is private. [README at the audited commit](https://github.com/farzaa/clicky/blob/a80fa80721a8aebe51a170a7780705024ebc6e46/README.md)
2. **HeyClicky** is the actively shipped, proprietary successor at [heyclicky.com](https://www.heyclicky.com/). The locally installed signed build is `HeyClicky` 1.0.38 (47), bundle `com.humansongs.clicky`, and contains a substantially newer notch, dictation, history, Codex-agent, integration, cron, and text-composer product. Its binary is not the public MIT snapshot.
3. **OpenClicky** is Jason Kneen’s independent MIT-licensed continuation/fork, not the official current HeyClicky source. It adds local configuration, agent spawning, computer use, image galleries, integrations, and an external local bridge. [OpenClicky README](https://github.com/jasonkneen/openclicky/blob/b0b4855ceb223ef0b0a57997cc0803cbd482f336/README.md)

**Decision:** keep Chief MOA as the only common control plane and backend. Adopt MIT code patterns selectively from the two public repositories; borrow interaction concepts from current HeyClicky through clean-room reimplementation; build the notch/island presentation and canonical audio-history integration in Chief MOA. Do not introduce a Clicky backend, fork HeyClicky’s product identity, or ship its private binary resources.

# Product landscape and release lineage

| Product | Identity and status | Source status | Relevant release evidence |
|---|---|---|---|
| Original Clicky | Native macOS menu-bar teacher next to the cursor; push-to-talk, screen screenshot, live STT, LLM, spoken reply, pointer overlay | Public MIT snapshot, upstream stopped publishing new product work there | Public head `a80fa80`, 2026-04-27; GitHub has no tagged Releases |
| HeyClicky | Official current commercial successor; voice talk plus agents and current notch-centered UI | New work is private; download is signed proprietary app | Installed 1.0.38 (47), Developer ID Farzain Majeed, signed 2026-07-14; Sparkle feed points to `farzaa/clicky-releases` |
| OpenClicky | Independent open-source continuation by Jason Kneen | Public MIT | Audited head `b0b4855`, 2026-07-18; repository currently has no GitHub Releases |
| Chief MOA | Existing multi-surface assistant/control plane with gateway-owned voice, sessions, intents, runs, receipts, and worker-pull | Project-owned | `origin/master` `196f3865`, 2026-07-25 |

The official site describes HeyClicky as a Mac-only screen-aware voice companion that can teach, point, and run agents. It distinguishes “talk” from metered “agents.” It says screenshots are taken only on hotkey and not stored, while basic text summaries are retained. [Official product and FAQ](https://www.heyclicky.com/) Its privacy policy says screenshots and voice are captured locally then sent through its backend proxy to third-party providers including Anthropic, OpenAI, Deepgram, and Cerebras. [Privacy policy](https://www.heyclicky.com/privacy-policy)

# Exact interaction audit

## Original public Clicky

The public source implements this loop:

1. A menu-bar-only `LSUIElement` app registers a listen-only `CGEvent` tap.
2. Holding `Control+Option` begins `AVAudioEngine` capture and shows a cursor-adjacent waveform overlay.
3. Audio streams to AssemblyAI (with OpenAI upload and Apple Speech fallbacks); transcript updates arrive live.
4. On release, Clicky requests a final transcript and captures the relevant display through ScreenCaptureKit.
5. Transcript plus screenshot goes to Claude; response text streams over SSE.
6. ElevenLabs speaks the response.
7. `[POINT:x,y:label:screenN]` response tags animate a blue pointer across displays.
8. The transient overlay fades after the turn.

Primary source: [architecture and key files](https://github.com/farzaa/clicky/blob/a80fa80721a8aebe51a170a7780705024ebc6e46/AGENTS.md), [global push-to-talk monitor](https://github.com/farzaa/clicky/blob/a80fa80721a8aebe51a170a7780705024ebc6e46/leanring-buddy/GlobalPushToTalkShortcutMonitor.swift), and [streaming transcription provider](https://github.com/farzaa/clicky/blob/a80fa80721a8aebe51a170a7780705024ebc6e46/leanring-buddy/AssemblyAIStreamingTranscriptionProvider.swift).

The public snapshot has live transcript state and waveform presentation but no canonical, cross-device conversation/audio history. Audio is streamed or buffered for provider upload; ordinary push-to-talk audio is not a durable user library. It has no evidence of a general transcript copy/paste workflow beyond normal response presentation, and no Dynamic-Island/notch product shell. Its defining visual is the cursor overlay, not the notch.

## Current installed HeyClicky

Static inspection of the signed local app establishes these private-product surfaces without decompiling or copying implementation:

- notch root/presenter and home, history, agents, threads, crons, settings, activity, handoff, integration, dictation clipboard/dictionary, text input, and text response surfaces;
- live listening waveform bars, thinking dots, speaking equalizer bars, and agent activity/timeline states;
- response copy control and a dictation clipboard surface;
- inline voice recording waveform for agent follow-ups;
- Codex thread/run history, file-diff artifacts, removal from history, follow-up composer, scheduled-agent summaries, and agent integration badges;
- microphone, speech recognition, screen recording, and Accessibility-related behavior;
- typed attachments and text composition in the notch;
- a packaged Codex runtime and private hosted proxy/account layer.

This is strong evidence of the current UI/capability shape, but not legal evidence that any private source, assets, sounds, prompts, or bundled runtime may be copied. Static symbol names also do not prove every surface is enabled for every account.

The installed app’s declared permissions are microphone, speech recognition, and screen recording. Its current official FAQ additionally discloses text-only Accessibility information about app/tab names for nudges. Cross-device continuity is account/backend-based, not demonstrated as a native Android/iOS client; the official product currently says Mac-only with Windows planned.

## OpenClicky

OpenClicky preserves the cursor/menu-bar interaction and extends it with local secrets, web/image work, local shell/files, child workers, Codex-style agent sessions, structured integrations, computer-use fallback, screen tours, and a loopback-only control bridge. It offers useful MIT implementation references for cursor choreography, overlay windows, local agent status, and extensibility. It is not proof of current official HeyClicky behavior, and importing it wholesale would duplicate Chief MOA’s gateway, agent runtime, routing, secrets, and history responsibilities.

# Capability matrix

Legend: **Yes** verified; **Partial** present but not canonical/complete; **No** absent; **Unknown** insufficient evidence.

| Capability | Original Clicky OSS | Current HeyClicky | OpenClicky | Chief MOA `origin/master` | Direction |
|---|---|---|---|---|---|
| Native Mac menu-bar app | Yes | Yes | Yes | Yes (`MoaMac`) | Keep |
| Notch/Dynamic-Island shell | No | Yes | Partial/overlay-oriented | Partial: panel positions below physical notch | Build in `MoaMac` |
| Global invocation | Hold `Ctrl+Option` | Configurable voice hotkey | Yes | `Ctrl+Space`, fallback `Opt+Space`; latched capture | Keep Chief semantics, make configurable later |
| Live waveform | Yes | Yes | Yes | No visible amplitude waveform | Build local visualization only |
| Live transcript | Yes | Yes | Yes | Yes, gateway partial/final events | Surface existing events |
| Capture lifecycle | Hold/release/cancel/transient | Dictation/talk/agent variants | Hold/release | summon starts, repeat commits, Escape cancels | Preserve deterministic Chief lifecycle |
| Copy response | Not established | Yes | Yes | Not established in compact Mac panel | Add inert copy |
| Paste/dictation into focused app | No general workflow | Evidenced by dictation clipboard surface; exact automation unknown | Has action tooling | Not in current `MoaMac`; surface action protocol exists elsewhere | Add later as approval-scoped Mac action |
| Spoken assistant response | ElevenLabs | Yes, multiple voice modes | Yes | Gateway can stream assistant PCM; `MoaMac` does not play it yet | Wire existing stream |
| Voice routes to chat vs agent | No in OSS snapshot | Yes | Yes | Yes, gateway voice router classifications and agent-run launch | Keep gateway authority |
| Agent project/run management | No | Yes, Codex threads/runs/artifacts/crons | Yes | Yes: runs, worker-pull, work graph, intent runtime | Present canonical state in notch |
| Screenshot/screen awareness | On each hotkey turn | Explicit hotkey; screenshots not retained | Yes | Separate explicit privacy grant; ordinary voice sends none | Keep separate approval |
| Local Mac actions | Pointer guidance only | Yes via agents/integrations; exact boundary private | Yes, structured routes plus computer use | Mac adapter/actions are staged and approval-scoped | Build on surface protocol, not model text execution |
| Audio persistence | No ordinary canonical archive | Official policy says voice is sent; retention unclear | Meeting recording exists; ordinary turn archive not canonical | Gateway stores voice-turn audio references/blobs | Make mandatory canonical turn attachment |
| Transcript/history persistence | Conversation state only | Text summaries and notch history | Local histories | Canonical session projection across voice/chat/browser; Mac UI pending | Extend projection to Mac and audio metadata |
| Cross-device history | No | No demonstrated non-Mac client | No | Browser + Android share gateway projection | Chief advantage; extend to Mac |
| Intent plane | No | Private agent/task product, not a common open contract | Local agent sessions | Canonical event-sourced intent runtime | Keep as sole authority |
| Extensibility | Provider interfaces and Worker | Private integrations/skills | Skills, MCP/integrations, local bridge | Surface skills, broker, intent/workflow, worker-pull | Reuse Chief primitives |

# License and reuse assessment

## Safe to adopt, with attribution

- Source in `farzaa/clicky` at the audited commit is MIT. Chief MOA may use, modify, distribute, sublicense, and commercially ship substantial portions if it preserves the copyright and MIT permission notice. [MIT license](https://github.com/farzaa/clicky/blob/a80fa80721a8aebe51a170a7780705024ebc6e46/LICENSE)
- Source in `jasonkneen/openclicky` at the audited commit is MIT under Jason Kneen’s copyright; derived upstream portions may carry upstream notices. Preserve both applicable notices and identify copied files in `THIRD_PARTY_NOTICES.md`. [OpenClicky license](https://github.com/jasonkneen/openclicky/blob/b0b4855ceb223ef0b0a57997cc0803cbd482f336/LICENSE)
- General interaction ideas—push-to-talk, a compact notch island, waveform, live transcript, state animation—may be independently implemented. Avoid copying distinctive artwork, exact animation choreography, product text, and brand trade dress.

## Do not copy without separate permission

- The current HeyClicky 1.0.38 executable/source, private notch implementation, hosted API behavior, prompts, sounds, images, onboarding/paywall videos, voice samples, app icon, branded cursor/character assets, credentials/config, analytics identifiers, and packaged Codex runtime.
- The installed bundle’s visible `LICENSE` applies only to vendored Nous Research Hermes skills; its `ATTRIBUTION.md` expressly scopes that license to those skill files. It is not a license for HeyClicky itself.
- `Clicky`/`HeyClicky` branding, logos, and confusingly similar product presentation. Name the Chief MOA surface Moa/Aggie and describe Clicky only as inspiration/prior art.

## Technical reuse warning

Whole-fork adoption is the wrong architecture even where legally allowed. Both public Clicky variants own provider selection, proxying, conversation state, routing, or local worker behavior that Chief MOA already centralizes. Import only isolated, reviewable native UI/capture patterns; adapt them to Chief protocols. Do not retain upstream network endpoints or provider keys.

# Chief MOA baseline and gap analysis

Chief MOA already contains the correct backend and most of the hard state machinery:

- `MoaMac` is a menu-bar accessory app with one borderless floating panel, global Carbon hotkey, notch-aware placement policy, launch/summon-to-capture, repeat-summon commit, and Escape cancel.
- `GatewayVoice` sends bounded PCM16 frames over `WS /v1/voice/sessions` and decodes partial/final transcripts.
- The gateway streams STT, persists voice-turn records and audio references/blobs, classifies voice into chat/control/agent paths, and can stream assistant audio.
- The canonical session-message projection deduplicates voice/chat/browser records and links agent runs, tasks, proposals, and receipts. Its current inference handles browser and Android but must explicitly recognize `moa-macos`.
- Browser and Android already use the gateway as the shared history/control boundary.
- Agent runs, worker registration/claim/heartbeat/result, work graph, intent runtime/workflow, and event substrate already implement the common execution and intention plane.

The missing product slice is presentation and one persistence invariant, not a backend:

1. `MoaMac` still looks like a 480×320 command palette below the notch, not an island that expands through capture/answer/run states.
2. It displays transcript text but no live amplitude waveform.
3. It does not consume/play assistant audio events.
4. It does not present shared history, intent/run progress, or artifacts.
5. It lacks copy and approval-scoped focused-app insertion.
6. Current history work persists audio conditionally; the stated direction requires **every accepted spoken turn** to create a canonical history record with an audio attachment or an explicit retention-failure/tombstone state.

# Adopt / borrow / build

| Choice | Scope | Rationale |
|---|---|---|
| Adopt | Chief gateway voice session, STT events, audio blob store, session projection, intent runtime, agent runs, worker-pull, surface-skill/action authority | Already matches the common-control-plane direction |
| Adopt selectively | MIT panel/overlay lifecycle, amplitude sampling/view patterns, cursor overlay patterns, provider-neutral capture details from public Clicky/OpenClicky | Saves native Mac work without importing a backend |
| Borrow clean-room | HeyClicky’s notch state grammar: listening waveform, thinking dots, speaking equalizer, agent activity, response copy, compact history/run tabs | Current implementation is private |
| Build | Chief-branded notch/island geometry, canonical turn/archive contract, Mac history/run client, assistant audio playback, approval-scoped Mac actions | These must fit Chief’s authority and persistence model |
| Reject | Separate Clicky proxy/backend, private asset extraction, whole OpenClicky runtime fork, model-emitted commands executed directly | Duplicates authority and creates security/history splits |

# Proposed UX sequence

1. **Idle:** a small Chief MOA island hugs the built-in notch; external/notchless displays use a top-center pill. It shows connection and active-intent state without taking focus.
2. **Invoke:** press the existing summon shortcut. The island expands; microphone ownership and target intent/thread are visible. No screen capture occurs.
3. **Capture:** a local amplitude waveform animates while gateway `transcript_partial` text appears live beneath it. The client streams PCM and simultaneously maintains the turn identity used for archival.
4. **Commit/cancel:** repeat summon or release commits according to the configured interaction mode; Escape cancels. A canceled turn is still represented as canceled if any audio was accepted, subject to explicit incognito semantics.
5. **Finalize:** gateway emits final transcript and confirms canonical history/audio attachment state. The UI never claims “saved” before that receipt.
6. **Disposition:** gateway returns one typed disposition:
   - `answer`: stream text and optional voice;
   - `agent_run`: show run card, project/intent link, progress, stop, and artifacts;
   - `surface_action_proposal`: show target, scope, effect, and approval;
   - `control`: show deterministic setting/intent result.
7. **Respond:** play assistant PCM when voice delivery is enabled; render inert text with Copy. A follow-up summon steers the same turn/run where supported.
8. **History:** expand into recent canonical messages. Every voice item shows transcript, audio playback/download availability, source device, completion state, linked intent/run, and retention receipt/error.
9. **Cross-surface continuation:** browser and Android read the same message/intent/run IDs. No client creates a private competing conversation database.

# Component boundaries

| Component | Owns | Must not own |
|---|---|---|
| `MoaMac` capture adapter | mic permission, PCM capture, local amplitude samples, commit/cancel gesture | STT provider credentials, routing, canonical history |
| Notch presentation coordinator | geometry, island phases, transcript/run/history rendering, copy | interpreting model text as executable commands |
| Gateway voice session | admission, streaming STT, turn lifecycle, assistant text/audio events | Mac UI geometry or local TCC decisions |
| Canonical turn/archive service | atomic turn record, transcript revisions/final, audio blob/ref, hashes, retention status, source/device metadata | provider-specific UI |
| Voice router / intent workflow | answer vs control vs agent vs action-proposal disposition; intent links | direct unapproved Mac mutations |
| Agent runs + worker-pull | durable queued/running/terminal state, progress, artifacts, cancel | client-local shadow jobs |
| Surface action adapter | capability declaration, local validation, approval, execution, receipt | global routing or unsandboxed generic command strings |
| Session/history projection | deduplicated cross-surface read model including audio metadata and Mac source | raw credentials, screenshots, Accessibility trees |

# Smallest implementation plan

## Slice 0 — contract and invariant

1. Specify `voice_turn_archive.v1`: one accepted turn ID, audio blob/ref and hash, transcript partial/final revisions, completion/cancel/error state, retention receipt, source surface/device, session/thread/intent/run links.
2. Make failure explicit: `persisted`, `incognito_not_retained`, `empty_capture`, or `retention_failed`; never silently drop accepted audio.
3. Extend canonical session messages to recognize `moa-macos` and return bounded audio attachment metadata/authorized playback URL.

Acceptance: a seeded Mac voice turn appears once in canonical history with exact final transcript and verifiable audio status.

## Slice 1 — island capture

1. Refactor the existing panel into a compact notch/notchless shell using the current `PanelLayoutPolicy`.
2. Expose normalized local audio level samples from capture; render waveform plus existing gateway partial/final transcript.
3. Preserve current launch/summon/commit/Escape semantics and privacy boundary.

Acceptance: one summon produces one visible island, live waveform, live transcript, and deterministic commit/cancel on built-in and external displays.

## Slice 2 — answer and history

1. Decode and play existing assistant audio events with stop/interruption.
2. Add inert response text and Copy.
3. Add a small recent-history expansion backed only by the canonical projection, including audio playback and persistence receipt.

Acceptance: restart/reopen shows the same turn once, with playable retained user audio and transcript; voice reply can be interrupted.

## Slice 3 — agents and intentions

1. Render gateway disposition and linked intent/run.
2. Subscribe/poll canonical run events for queued/running/blocked/completed, artifacts, and cancel.
3. Add follow-up/steering without creating a separate Mac job store.

Acceptance: a spoken agent request links to one canonical intent/run, survives Mac restart, and is visible from browser/Android history.

## Slice 4 — scoped Mac actions

1. Add capability-specific proposals (initially Copy and focused-field Insert).
2. Require local validation and approval for mutations; persist receipts.
3. Keep screen/AX observation separately granted and never implied by voice capture.

Acceptance: no response string directly causes an action; every mutation has a proposal, approval decision, and receipt.

# Risks, unknowns, and blockers

- Current HeyClicky is private. The installed build supports a high-confidence surface inventory but not source-level implementation claims or reuse rights.
- Official documentation does not define HeyClicky’s ordinary voice-audio retention duration. Its FAQ confirms text summaries and says screenshots are not stored; do not infer that audio is retained or deleted.
- “Mac-only” means HeyClicky supplies no demonstrated Android/iOS cross-device model to adopt. Chief MOA’s existing shared gateway is the stronger foundation.
- Chief MOA’s mandatory “every spoken audio persists” direction needs explicit incognito, deletion, encryption, quota, and retention policy decisions. The implementation should persist status even when policy forbids retaining bytes.
- The isolated follow-up word “Amharic” is ambiguous. It may mean multilingual STT/history fidelity, but it is not treated as a requirement without clarification. If confirmed, add Amharic fixtures and exact-script transcript preservation to Slice 0/1 acceptance.
- Static binary inspection cannot establish feature availability by plan/account or exact end-to-end behavior. A consented interactive product test would improve that evidence but is not needed to make the architecture decision.

# Sources and evidence ledger

## Public sources

- [Original Clicky repository](https://github.com/farzaa/clicky)
- [Original Clicky README and private-new-work notice](https://github.com/farzaa/clicky/blob/a80fa80721a8aebe51a170a7780705024ebc6e46/README.md)
- [Original Clicky architecture](https://github.com/farzaa/clicky/blob/a80fa80721a8aebe51a170a7780705024ebc6e46/AGENTS.md)
- [Original Clicky MIT license](https://github.com/farzaa/clicky/blob/a80fa80721a8aebe51a170a7780705024ebc6e46/LICENSE)
- [Official HeyClicky product/FAQ](https://www.heyclicky.com/)
- [Official HeyClicky privacy policy](https://www.heyclicky.com/privacy-policy)
- [OpenClicky repository](https://github.com/jasonkneen/openclicky)
- [OpenClicky audited README](https://github.com/jasonkneen/openclicky/blob/b0b4855ceb223ef0b0a57997cc0803cbd482f336/README.md)
- [OpenClicky MIT license](https://github.com/jasonkneen/openclicky/blob/b0b4855ceb223ef0b0a57997cc0803cbd482f336/LICENSE)

## Local evidence

- `/Applications/Clicky.app/Contents/Info.plist`
- `/Applications/Clicky.app/Contents/Resources/ClickyBuildInfo.plist`
- `/Applications/Clicky.app/Contents/Resources/LICENSE`
- `/Applications/Clicky.app/Contents/Resources/ATTRIBUTION.md`
- Developer ID signature and sealed binary symbol inventory, inspected 2026-07-25
- Chief MOA `origin/master` at `196f38657791c5e24f4c5fb2de5de309880823f0`, especially:
  - `apple_surfaces/Sources/MoaMac/main.swift`
  - `apple_surfaces/Sources/MoaMacCore/GatewayVoice.swift`
  - `apple_surfaces/Sources/MoaMacCore/PanelLayoutPolicy.swift`
  - `gateway/lib/voice-session-server.js`
  - `gateway/lib/voice-turn-audio.js`
  - `gateway/lib/session-messages.js`
  - `gateway/lib/voice-router.js`
  - `gateway/lib/intent-runtime.js`
  - `gateway/lib/worker-pull.js`
  - `reference/openspec/changes/macos-clicky-parity-surface/`
  - `reference/openspec/changes/cross-surface-session-history/`

