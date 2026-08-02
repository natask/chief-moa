## Context

The source is production session `shared-usr_74223d7809682c30`, turn
`turn_cea65f02-1c3c-44b4-aa83-ce5dadddb56d`, explicitly retranscribed at
`2026-08-02T13:27:45Z`. The regenerated direction combines stable product
corrections with exploratory gesture narration. This design freezes the stable
requirements and keeps contradictory edge mappings behind a measured
experiment.

Current Android behavior already provides one process-local overlay owner,
launcher Dictation, system-Assistant Assistant, a bounded hands-free loop,
provider-neutral sockets, diagonal ribbons, and touch-pass-through between
separate windows. It exposes only one launcher shortcut, Control center. The
durable `voice_draft` pause/resume contract is accepted. The current tree holds
a substantial gateway store, smokes, and Android/browser protocol domains, but
the active task ledger is stale and the complete advertised WebSocket-to-Send
path is not established by current source routing evidence. Implementation must
audit and finish that exact path rather than recreating the store blindly.

The active contracts conflict with the new direction:

- `voice-first-orb-gestures` removed X/Send side controls and says gesture owns
  disposition;
- `quiet-companion-controls` allows only Copy and voice-reply beside the
  companion;
- the new direction asks for mascot-owned Send/turn handoff, adjacent
  Pause/Resume and Cancel, and per-message Copy.

This change is the later authority for that narrow conflict. It does not reopen
the bounded-ribbon, single-owner, local-action, or provider-credential
boundaries.

## Goals / Non-Goals

**Goals:**

- Give Dictation, Assistant, and Hands-free stable typed identities.
- Expose launcher shortcuts and user-configurable mappings for triggers Android
  actually delegates to Ag.
- Offer Companion and Minimal ring presentation without changing turn filing or
  provider protocol.
- Make Pause/Resume, Cancel, Send/turn handoff, and exact Copy explicit and
  non-duplicated.
- Keep all unrendered overlay coordinates touch-pass-through.
- Preserve gateway provider and credential authority.
- Create a safe evidence path for edge-swipe and visual experiments.

**Non-Goals:**

- No raw provider keys in Android.
- No wake word, arbitrary hardware-chord interception, general Android gesture
  takeover, or promise that a launcher exposes every requested shortcut.
- No automatic implementation of context-sensitive trigger sequences.
- No new voice provider, latency algorithm, browser mascot implementation, or
  browser UI in this change.
- No full-screen transparent touch window.
- No claim that a design critique, APK build, OTA publication, phone install,
  and phone smoke are the same state.

## Decisions

### Decision: Separate invocation behavior from presentation and delivery

Use three independent typed axes:

| Axis | Values in this change | Authority |
| --- | --- | --- |
| Invocation behavior | Dictation, Assistant, Hands-free | Android entry router; gateway enforces admitted turn kind |
| Presentation | Companion, Minimal ring | Android UI only |
| Delivery policy | Ask, Note, Coach and response modality | Existing gateway profile/mode authority |

This prevents a Minimal ring selection from changing session, provider, or
retention behavior, and prevents “Hands-free” from becoming an alias for Note
or Coach.

Alternative: one user-visible mode enum combining all values. Rejected because
it would couple UI shape, capture lifecycle, reasoning, and storage policy.

### Decision: Preserve safe defaults and add typed entry routing

The no-preference map remains:

| Entry | Default behavior | Presentation |
| --- | --- | --- |
| Launcher icon | Dictation | saved presentation |
| Android Assistant / voice command | Assistant | saved presentation |
| Launcher shortcut: Dictation | Dictation | saved presentation |
| Launcher shortcut: Assistant | Assistant | saved presentation |
| Launcher shortcut: Hands-free | Hands-free | saved presentation |
| Launcher shortcut: Settings | full app | no capture |

All entries converge on one invocation coordinator and one overlay owner.
Mappings store only known enum values and reset atomically. OS- or launcher-
owned triggers that never reach Ag cannot be configured by pretending.

Alternative: replace current launcher behavior immediately. Rejected because
literal launcher Dictation is established and safe, and migration needs a
visible user choice.

### Decision: Supersede the compact control prohibition, not the whole gesture map

The accepted Companion control table is:

| Phase | Mascot | Pause/Resume | Cancel | Message Copy |
| --- | --- | --- | --- | --- |
| Idle | start current-thread capture | unavailable | unavailable | copies exact populated message |
| Capturing draft | Send once | Pause | discard without send | finalized messages only |
| Paused draft | Send once | Resume same draft | discard without send | finalized messages only |
| Thinking | start steering user turn | unavailable | cancel current conversational generation | retained messages remain copyable |
| Assistant speaking | stop old playback and start steering user turn | pause/resume local playback | stop/cancel conversational turn | exact visible finalized reply |
| Error/recovery | retry only through named recovery action | unavailable | clear owned recovery state | retained messages remain copyable |

There is no adjacent Send button; the mascot owns Send/turn handoff. The two
side controls are Pause/Resume and Cancel. This differs from the historical
X/Send review rail and is why supersession is narrow.

Alternative: retain gesture-only disposition. Rejected by the later explicit
request for visible pause and cancel controls. Alternative: restore X and Send.
Rejected because Send belongs on the mascot and duplicate Send increases error
risk.

### Decision: Depend on and converge the pre-execution voice-draft boundary

Capture Pause/Resume must not emulate pause by ending a canonical turn.
Implementation waits for `voice_drafts_v1`: microphone bytes remain in a
revisioned pre-execution draft, and only Send admits one ordinary turn. Old
gateways keep legacy capture with pause controls disabled.

The existing store and client protocol sources are inputs to this work, not
proof that the deployed capability is active. The implementation ticket begins
with a source/test/deployment convergence audit and adds only the missing
integration and evidence.

Assistant playback pause is local presentation state. It must not claim the
provider paused, and it does not pause detached agent work.

### Decision: Build Minimal ring from bounded windows

Use four thin, independently attached edge windows coordinated by one local
presentation owner. Do not attach a transparent full-display root. Windows
with no rendered edge/control detach or shrink to their visible bounds. This
preserves the existing rule that transparent gaps are not Ag touch regions.

The ring consumes a smoothed, bounded, content-free microphone-level signal.
State color/motion derives from hardware capture plus normalized local voice
phase, not transcript tokens or provider prose. Visual variants should be
reviewed from deterministic screenshots/video by the configured Claude design
harness requested by the user; evidence must record the actual available model
ID and must not claim “Claude 5” if that identifier is unavailable.

Alternative: one border drawable in a full-screen overlay. Rejected because the
window would risk swallowing the same Y-axis/transparent coordinates the user
reported as untouchable.

### Decision: Keep edge swipes experimental

The retranscription contains changing assignments for inward and outward
swipes, including pause, copy-and-halt, stop, send, and conversational turn
handoff. The only coherent candidate worth testing is:

| Candidate gesture | Candidate result | Status |
| --- | --- | --- |
| Inward from left owned edge | Pause/Resume | experiment |
| Inward from right owned edge | Send or conversational turn handoff | experiment |
| Outward from either owned edge | Cancel/Stop | experiment |
| Any edge gesture for Copy | none | unresolved; not implemented |

A pure resolver receives phase, origin edge, displacement, velocity, direction,
and accessibility/navigation state. Ambiguous movement is inert. The experiment
must coexist with Android Back navigation, expose a kill switch, and retain
visible/accessibility fallbacks.

Alternative: freeze the last spoken mapping as stable. Rejected because the
source turn self-corrects repeatedly and does not settle Copy semantics.

### Decision: Provider selection is a gateway profile choice

Android reads catalog labels, stable IDs, readiness, and capabilities. It may
request a versioned profile update and wait for the returned version. An
unconfigured provider remains visible but disabled. Ambiguous transcription
such as “ChatGPT and graph” does not become a hard-coded product label; the
gateway catalog supplies exact OpenAI, Anthropic, Gemini, xAI, or other names.

Credential setup, where needed, uses a gateway-owned short-lived URL or account
action. Android receives status and a reference, never the credential value.

### Decision: Route adjacent work to existing owners

- Missing browser mascot: verify/package/reload under
  `overlay-companion-ribbons` and extension deployment; do not rebuild it here.
- Browser and full-history Copy parity: reconcile under
  `overlay-companion-ribbons`, `quiet-companion-controls`, and
  `cross-surface-session-history`.
- Latency: implement measurement and provider prewarm under
  `voice-latency-prewarm`.
- Provider implementations and comparison: use
  `provider-agnostic-voice-agent-runtime`.
- Recording indicator and review/delete: use
  `recording-visibility-and-control`; Minimal ring must consume its real
  mic-hardware-open state.

### Decision: Current worktree policy remains in force

The user prefers direct, sequenced work on `master`, but the current repository
authority has not proven concurrent shared-master safety. Each implementation
unit therefore uses an isolated branch attached to a specific worktree, owns
disjoint paths, verifies, and commits before coordinator integration. Shared
files run in sequence. Only `scripts/release/push-master.sh` may move master.
No agent directly pushes a branch to master, merges from an unverified dirty
worktree, or treats an idle worktree as task state.

This decision records current authority; changing it belongs to
`manage-agent-worktree-closure`, not this Android product change.

## Risks / Trade-offs

- [Edge windows conflict with Back/navigation] -> keep gestures off by default,
  use bounded owned strips, test all navigation modes, and preserve fallbacks.
- [Visible controls enlarge the compact surface] -> render only phase-relevant
  Pause/Resume and Cancel, keep Send on the mascot, and keep History/Settings in
  the full app.
- [Pause is mistaken for provider cancellation] -> separate draft pause, local
  playback pause, and gateway cancellation in state and receipts.
- [A ring looks active while the mic is closed] -> drive recording indication
  from hardware ownership, with normalized phase as secondary presentation.
- [Launcher shortcut limits vary] -> query platform support and expose the
  supported subset without changing the typed router.
- [Provider choice strands a turn] -> pin the profile at admission and apply a
  confirmed change to the next turn.
- [Old client/new gateway drift] -> additive capability negotiation and legacy
  behavior when `voice_drafts_v1` or profile options are missing.

## Migration Plan

1. Land spec reconciliation and pure typed domains with no behavior change.
2. Add shortcuts and routing while retaining existing defaults.
3. Add full-app trigger and presentation settings behind migration-safe prefs.
4. Land and deploy gateway voice-draft support additively; prove old-client/new-
   gateway compatibility and backup/restore.
5. Add Companion Pause/Resume, Cancel, mascot Send/handoff, and message Copy.
6. Add Minimal ring behind a setting, initially without edge gestures.
7. Run deterministic visual iteration and physical-phone touch/navigation QA.
8. Offer the edge map only in an explicit experimental setting after the pure
   resolver passes.
9. Build a continuity-signed device-reachable Android preview from the exact
   commit. Verify package, signer, digest, rollback, and no active capture is
   interrupted.
10. Publish through `scripts/deploy.sh android` only after the active-promotion
    gate passes. Record published, installed, and smoked as separate receipts.

Rollback disables experimental gestures and Minimal presentation first, then
returns to Companion presentation and the prior shortcut map. Additive gateway
draft state must remain predecessor-readable or be durably parked before code
rollback.

## Open Questions

- Which exact launcher shortcuts and ordering does the user's launcher expose?
- Should Companion controls be persistent during capture only or also appear
  during thinking/speaking?
- Does assistant playback Resume continue buffered audio or request a suffix
  retry after the local queue was released?
- Does the right-edge candidate mean Send during capture and handoff during
  assistant speech, or should those remain separate gestures?
- Which measured ring colors, thickness, motion, and level response pass light,
  dark, reduced-motion, and accessibility QA?
- Which exact provider labels did “ChatGPT and graph” intend? The catalog can be
  implemented without resolving this transcription ambiguity.
