# Core product intent

## Purpose

This is the master record of the stable product direction for Ag. Append new
stable intent here. Correct this file when the direction changes. Keep detailed
designs and implementation tickets in OpenSpec, then link them from this file.

Do not mark an outcome done because a design or code path exists. Mark it done
only when the repo holds verification evidence for the current build. Physical
Android and loaded-browser behavior still need device evidence.

Status terms:

- `done`: implemented and verified for the stated scope.
- `partial`: useful parts exist, but the user outcome is incomplete.
- `missing`: no working implementation is present.
- `unknown`: the repo cannot prove the current installed or hosted state.

## Product contract

Ag is one personal agent across browser, Android, and desktop surfaces. The
gateway owns durable sessions, model routing, account data, agent runs, and
stored artifacts. Each Surface owns its UI, local context, permissions, local
actions, and receipts.

The agent should answer questions, create things, automate work, and finish
bounded tasks. It should retain the user's context across pages and devices.
The user should always be able to see, steer, stop, or resume active work.

Model output remains a proposal. Page content and screen context remain
evidence. The owning Surface checks current state and local policy before each
effect. Purchases, credentials, destructive changes, and external submissions
require an explicit checkpoint unless the user granted a narrower safe policy
for that exact task.

## Browser

The browser Surface should:

- Read the current page and answer questions from bounded DOM and visual
  evidence.
- Open, close, activate, reload, and organize tabs.
- Complete multi-step browser tasks in the background while the user continues
  other work where the browser allows it.
- Use Chrome DevTools Protocol when a visible execution profile grants the
  required domains and methods.
- Run inspectable page-scoped JavaScript or TypeScript programs. Never run
  generated code as privileged extension source.
- Change page HTML and styles, add interactive UI, and keep approved site or
  page programs available on later visits.
- Draw anchored annotations and animated UI over a page. The UI should stay
  attached to the right content while the user scrolls. It should fail visibly
  when navigation or page replacement makes the evidence stale.
- Keep conversation and task state across page changes. Keep page mutations and
  drawings scoped to the page or site that owns them.
- Show durable plans, progress, approvals, artifacts, results, and session
  history in a clean side-panel workspace.
- Support read-only help, collaboration, and bounded delegation without
  silently increasing authority.

Relevant work:

- `browser-situated-agent-experience`
- `define-surface-program-runtime`
- `extension-ui-self-extension`
- `cross-surface-session-history`

## Accounts, data, privacy, and self-hosting

The hosted product should use normal account sign-in. Android and browser
clients should register as user-bound devices instead of asking the user to
copy a long-lived gateway token.

Android currently has a temporary build-time bootstrap for direct distribution.
A trusted local build may pass `MOA_ANDROID_BUNDLED_GATEWAY_TOKEN`; the APK uses
that value only when the user has not saved a token. The repository stores no
literal token. This shared bearer is broad and extractable from the APK, so it
is deployment continuity only. It is not account sign-in, device identity, or
user isolation. The temporary OTA-only bootstrap makes the current Android
manifest and latest APK routes public so an installed tokenless app can acquire
that build. This also makes the token-bearing APK a public, extractable
artifact. Version-pinned reads, OTA mutations, and every non-OTA gateway route
remain authenticated. This is an explicitly temporary, high-risk single-user
compromise. Scoped per-user authentication and device credentials must replace
it.

Every database row, object, session, agent run, transcript, audio file,
screenshot, and artifact should have a tenant and owner. Every read and write
should enforce that ownership. Storage paths and signed object access should
also remain user-scoped.

Raw audio and screenshots should be off by default. The product should explain
which features lose value when the user keeps them off. The user should control
retention by data class and should be able to inspect, export, and delete stored
data. Required security and reliability events may use a separate minimal
retention policy. The privacy policy should state what Ag captures, why it
captures it, where it stores it, how long it keeps it, and who can access it.

The user should be able to ask Ag to self-host the full gateway and storage
stack. Ag should prepare the infrastructure plan, create reviewable provider
actions, verify the result, register the user's devices, and provide backup and
restore instructions. Provider credentials should stay in the gateway or the
user's chosen secret store.

Relevant work:

- `production-grade-hosted-product`
- `remote-hosted-gateway`
- `recording-visibility-and-control`
- `self-hostable-event-substrate`

## Surface experience

The browser, Android, and desktop products should share one design language and
one session model. They do not need identical layouts.

The compact overlay should stay small and fast. It should show current capture,
the current result, progress, approval, stop, and a short path into the full
workspace. History, session switching, settings, storage controls, and deep
inspection belong in the full app or browser side panel.

User messages should use one deliberate dark bubble treatment across states.
Remove bars and controls that do not earn their space. Put History and Settings
in the workspace navigation. Keep exact copy actions in retained history and
avoid duplicate copy controls in the compact surface.

The current gesture direction is:

- A single click starts capture or finishes and sends to the current session.
- A double click starts capture or finishes and sends to a new session.
- A hold supports push-to-talk in the current session.
- A clear cancel gesture stops capture without sending.
- Editing a retained user transcript or assistant response should be direct and
  should preserve the original revision for audit and voice-quality evaluation.

The exact role of triple click and steering into a different existing session
is still open. Do not assign hidden behavior until it passes usability tests.

Relevant work:

- `define-android-core-product-map`
- `cross-surface-session-history`
- `overlay-companion-ribbons`
- `quiet-companion-controls`

## Voice and latency

The voice runtime should accept interchangeable speech-to-text, speech-to-
speech, reasoning, and text-to-speech providers behind one stable client
protocol. A provider change should not require a new Android or browser event
model.

Optimize the full path for the first useful feedback:

1. Stream microphone audio while the user speaks.
2. Reconcile interim transcripts continuously.
3. Show provisional text without storing or routing it as final user intent.
4. Finalize and send immediately on release or companion click.
5. Stream model text as soon as it is stable enough to show.
6. Stream text-to-speech audio and keep displayed text aligned with spoken
   progress.

Measure at least time to first interim transcript, final transcript, first model
text, first audio, and completed turn. Break the measurements down by client,
network, speech provider, model, and TTS provider. Keep warm connections where
the provider permits it. Bound queues and cancel stale generations.

The display rate should be configurable and based on reading tests. Do not lock
in 30 words per second without evidence.

Build a repeatable quality loop from consented audio, corrected transcripts,
and response revisions. Test noise reduction, gain control, segmentation,
language hints, and bounded speed changes against the same corpus. Keep the raw
sample only when the user enabled that retention class.

Relevant work:

- `provider-agnostic-voice-agent-runtime`
- `streaming-cascaded-voice`
- `voice-latency-prewarm`
- `voice-stt-tts-accuracy-loop`

## Development system

Split work by intent and Surface. Give each implementation ticket one visible
acceptance check. Run shared-file changes in sequence. Let independent changes
run in parallel.

Use one canonical QA and release path for each candidate. Do not run several
copies of the full product only because several agents edit code. Share
dependency caches and immutable build inputs. Prefer remote or ephemeral build
workers when local projects and worktrees consume too much disk or memory.

Delete a task worktree only after its unique work is committed, integrated, and
recorded. Keep no idle worktree as task state.

The user's preferred end state is direct, sequenced work on `master`. The live
repo contract currently requires isolated fix work and moves `master` only
through `scripts/release/push-master.sh`. Keep that safety rule until a new
workflow proves that shared-master edits cannot mix candidates, race QA, or
publish unverified state.

Relevant work:

- `manage-agent-worktree-closure`
- `persistent-release-control-plane`
- `unify-deployment-plane`

## Documentation system

Keep this file as the stable product index. Keep `ARCHITECTURE.md` as the live
system boundary. Keep OpenSpec changes as scoped behavior and implementation
work. Keep dated audits and research as evidence. Mark replaced documents with
their successor before archiving them. Do not leave several files claiming to
be the current product or architecture authority.

The first cleanup pass should inventory incoming links, mark clear successors,
and archive only files whose useful facts already exist in a current authority.
Do not delete uncertain user knowledge.

## Verified state on 2026-07-29

| Area | Status | Repo evidence and remaining gap |
| --- | --- | --- |
| Browser page questions | `done` | Focused tests prove bounded whole-page semantic evidence, a separate viewport element index, and current-viewport visual evidence. Loaded-extension QA remains part of each release. |
| Browser tab and CDP control | `partial` | Tab control and bounded CDP paths exist. The general execution-profile and page-program runtime remains open. |
| Anchored page UI | `missing` | The product design exists. Stable anchors, scroll reprojection, and stale-anchor tests remain open. |
| Generated page programs | `partial` | A tested scoped userscript runtime can execute and persist exact source and hashes. Agent delivery and production runtime wiring remain open. |
| Delegated browser work | `partial` | Command routing and bounded background actions exist. The full workspace, completion evidence, and scope-change behavior remain open. |
| Purchase-grade browser approval | `missing` | Buy and pay language currently maps to generic click and type actions. A final checkout or payment checkpoint is required before purchase automation is safe. |
| Shared conversation history | `done` | The gateway projection and Android/browser history views are implemented and verified for their stated slice. Session switching and editing remain follow-on work. |
| Hosted sign-in and user isolation | `missing` | Production uses one shared gateway token. Owner-only Better Auth and RLS scaffolding exist, but general accounts, device sign-in, user-scoped voice tickets, and end-to-end isolation are not deployed. |
| Per-user GCS storage | `missing` | Production uses one shared bucket namespace. Object keys and metadata do not yet enforce a user or tenant boundary. |
| Media retention controls | `partial` | Incognito cleanup and some video deletion exist. Audio, screenshot, and telemetry controls, export, deletion, and user-facing retention policy remain open. |
| Privacy policy | `missing` | The repo and production site do not provide the required hosted-data privacy policy. |
| Agent-assisted self-hosting | `partial` | Container, VPS, backup, restore, and setup docs exist. The conversational provisioning tool and end-to-end user flow remain open. |
| Android core runtime | `partial` | Overlay, history-first app, actions, receipts, sessions, and OTA paths exist. Physical-phone QA remains open. The two visible apps are likely the intentional legacy `ai.moa.assistant` and current `ag.companion` packages. |
| Android account onboarding | `partial` | Short-lived device enrollment exists. Public current-manifest/latest-APK reads can deliver a build-only bundled legacy token to an installed tokenless app, and a saved user token overrides it. The public APK makes the broad shared bearer extractable. This high-risk single-user bootstrap must yield to scoped per-user auth. |
| Cross-surface UI consistency | `partial` | Shared interaction direction exists. Current installed visuals, bubble consistency, and workspace cleanup need visual QA and implementation. |
| Provider-neutral voice | `done` | Production runs streaming Chirp 3 STT, gateway reasoning, and streaming Gemini TTS behind the provider registry. A user-facing provider comparison flow remains follow-on work. |
| Instant voice response | `partial` | Partial STT, streamed reasoning/TTS, and stage timings exist. Prewarm and one client-observed metric from microphone start through first transcript, text, audio receipt, and playout remain open. |
| Editable transcripts and replies | `missing` | Retained history can be copied. Revision-preserving edit controls and their evaluation loop are not complete. |
| Recording visibility | `missing` | The product does not yet provide the persistent capture indicator and immediate review/delete controls required for retained voice. |
| Worktree cleanup | `partial` | A safe audit/archive tool and closure contract exist. The current registry still holds many unique, dirty, or idle worktrees, and remote worker integration remains open. |
| Documentation cleanup | `partial` | Authority files exist, but dated ledgers and overlapping architecture material still need successor labels and link cleanup. |

## Current order of work

1. Prove and finish the browser read, act, anchored-UI, and delegated-task loop.
2. Replace copied gateway tokens with account sign-in and user-bound device
   registration. Enforce user ownership through database and object storage.
3. Fix and physically verify the Android install and core UI, including the
   duplicate-app report.
4. Measure and reduce end-to-end voice latency on browser and Android. Add the
   correction-based voice-quality loop.
5. Finish the shared workspace, session controls, Settings, History, and visual
   system across surfaces.
6. Prove agent-assisted self-hosting with isolated preview, backup, restore,
   device registration, and rollback evidence.
7. Consolidate documentation and adopt one remote-capable QA and release plane.

## Open decisions

- Define triple-click behavior and steering into a different existing session.
- Choose the final side-panel navigation and the compact overlay controls.
- Set default and maximum retention for each data class.
- Set measured text reveal and speech playback rates.
- Decide when direct shared-`master` development is safe enough to replace
  isolated candidates.

## Change log

### 2026-07-30

- Recorded the temporary Android build-time gateway-token bootstrap and kept
  scoped per-user authentication as the required replacement.

### 2026-07-29

- Created the living core intent file from the user's repeated product
  direction.
- Added browser reading, CDP automation, page programs, anchored UI, accounts,
  user-owned storage, privacy controls, self-hosting, cross-surface UI, session
  gestures, voice quality, development workflow, and documentation cleanup.
- Added full-pipeline voice latency and first-useful-feedback requirements.
