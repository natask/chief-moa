# Android invocation and minimal voice program

Date captured: 2026-08-02. This is the durable program note for the regenerated
requirements from one production voice turn. It records provenance, decisions,
ticket routing, and delivery order. Normative product behavior lives in
`reference/openspec/changes/configure-android-invocation-and-minimal-voice-surface`.

## Source and provenance

- Session/conversation ID: `shared-usr_74223d7809682c30`
- Turn ID: `turn_cea65f02-1c3c-44b4-aa83-ce5dadddb56d`
- Derived artifact: explicit re-transcription of retained source audio
- Re-transcribed at: `2026-08-02T13:27:45Z`
- Capture scope: the supplied re-transcription, not an account-wide history scan
- Authority: current user product and implementation direction, subject to the
  repository's platform, credential, Git, verification, and promotion safety
  boundaries

The re-transcription was regenerated because the earlier transcript was not
trusted to preserve the user's full direction. This note does not copy audio or
provider credentials into Git. Repetitions and self-corrections were resolved
only where the turn reached a stable product outcome; conflicting gesture
descriptions remain explicit experiments.

## Regenerated requirements

1. Standardize development around eventual sequenced integration into master,
   but allow a task-specific worktree and do not leave completed work stranded.
2. Inventory current work and deploy verified, compatible candidates that have
   not reached their target, without bypassing preview or active-work safety.
3. Restore exact Copy inside messages, including Android, without duplicate
   compact controls.
4. Keep the mascot as the Send or conversational turn-handoff control. Add
   Cancel and one Pause/Resume control around it in the ordinary Companion UI.
5. Ensure every transparent or unrendered overlay coordinate is touch-through;
   no horizontal or vertical strip may become untouchable merely because the
   overlay is running.
6. Make the browser mascot visible in the loaded extension and verify the
   package/reload state rather than assuming source presence equals deployment.
7. Expose Android launcher shortcuts for Settings, Dictation, Assistant, and
   Hands-free.
8. Let the user configure supported invocation triggers in the full app and
   investigate context-sensitive sequences without claiming control of
   OS-reserved triggers.
9. Add a selectable Minimal ring presentation: a subtle polished edge signal
   that changes with capture/assistant phase and visibly responds to speech
   intensity.
10. Preserve Pause/Resume, Cancel/Stop, and Send/turn handoff in Minimal mode,
    with accessible fallback controls. Treat the proposed edge mappings as an
    experiment until physical-phone QA settles them.
11. Prioritize first-useful-feedback latency and finish the existing measured
    prewarm work rather than starting an unbounded speculative-reasoning path.
12. Let the user compare/switch configured model and voice profiles. Show
    unavailable choices, but keep all raw provider credentials in the gateway.
13. Use deliberate visual iteration for the ring and compact controls. Record
    the actual critique model and evidence; do not claim a model version that is
    not available.

## Decision table

| Topic | Decision | State | Owner |
| --- | --- | --- | --- |
| Launcher icon | Literal Dictation by default | confirmed, preserve | new Android OpenSpec |
| System Assistant/voice command | Reasoning Assistant by default | confirmed, preserve | new Android OpenSpec |
| Hands-free | Explicit bounded re-arm behavior | confirmed | new Android OpenSpec + recording visibility |
| Launcher long-press | Settings, Dictation, Assistant, Hands-free supported subset | confirmed direction; platform-bounded | new Android OpenSpec |
| Trigger mapping | Configure triggers Android actually exposes; reset defaults | confirmed direction | new Android OpenSpec |
| Context-sensitive trigger sequences | Investigate before assigning behavior | exploratory | new Android OpenSpec follow-up |
| Companion Send | Mascot owns Send/turn handoff | confirmed | new Android OpenSpec |
| Companion Pause/Cancel | Adjacent Pause/Resume and Cancel | confirmed; supersedes older prohibition | new Android OpenSpec + voice drafts |
| Message Copy | One exact Copy inside each populated message | confirmed | Android change; browser parity routed |
| Minimal UI | Selectable thin edge ring | confirmed direction | new Android OpenSpec |
| Ring intensity | Bounded mic-level feedback from hardware state | confirmed direction | new Android OpenSpec + recording visibility |
| Ring visual tokens | Polished, subtle, glossy; iterate from evidence | design exploration | new Android OpenSpec |
| Inward left | Pause/Resume | candidate only | edge experiment |
| Inward right | Send/turn handoff | candidate only | edge experiment |
| Outward either edge | Cancel/Stop | candidate only | edge experiment |
| Edge Copy | No binding selected | unresolved | do not implement |
| Browser mascot absent | Verify loaded artifact/reload before changing design | confirmed diagnosis path | overlay companion / extension refresh |
| Latency | Measure and prewarm non-billable connections | confirmed existing direction | voice-latency-prewarm |
| Provider switch | Gateway-catalog profile selection | confirmed | provider-agnostic runtime + Android UI |
| Provider keys in Android | Prohibited | invariant | gateway credential boundary |
| Direct concurrent master edits | Not yet authorized | current repo policy | manage-agent-worktree-closure |

## Supersession map

- This program supersedes `voice-first-orb-gestures` and the Android core map
  only where they forbid adjacent Pause/Resume and Cancel in Companion mode.
- It supersedes `quiet-companion-controls` only where that change limits the
  compact companion to Copy and voice-reply on/off.
- It does not restore the historical X/Send review rail. Send remains the
  mascot; the adjacent controls are Pause/Resume and Cancel.
- It does not supersede bounded single-line ribbons, one overlay owner,
  separate-window touch pass-through, launcher Dictation, system Assistant,
  provider-neutral voice, gateway-owned credentials, or History/Settings in the
  full app.
- It does not settle edge gestures. Those remain off by default until the
  experiment produces an explicit decision.

## Program lanes and order

1. Spec reconciliation and pure state tables.
2. Android invocation coordinator, shortcuts, and settings.
3. Gateway voice-draft prerequisite.
4. Companion Pause/Resume, Cancel, mascot Send/handoff, and per-message Copy.
5. Minimal ring without edge gestures.
6. Edge-gesture experiment and physical accessibility/navigation QA.
7. Android gateway-provider selector.
8. Independent browser mascot/copy loaded-artifact verification.
9. Gateway latency measurement and prewarm.
10. Exact-candidate integration, preview, physical-phone QA, guarded
    publication, install, and smoke.

Independent Android, gateway, browser, workflow/docs, and verification/deploy
lanes may run in parallel only while their owned paths are disjoint. Shared
specs, shared source files, integration, and promotion run in sequence.

## Current Git and worktree authority

The user's preferred end state is direct, sequenced work on `master`. The
current repository contract still requires each concurrent or risky unit to use
an isolated branch attached to its task-specific worktree. A completed unit is
verified and committed there; the coordinator integrates candidates in
sequence. Master moves only through `scripts/release/push-master.sh`, never a
direct `git push <branch>:master`. Worktrees close only after unique work is
committed, integrated, and durably recorded.

Changing this policy requires proof under `manage-agent-worktree-closure` that
shared-master edits cannot mix candidates, race QA, or publish unverified state.
This Android program does not grant that proof or alter Git authority.

## Verification and delivery order

For each implementation unit:

1. Run the narrow focused test.
2. Run `node scripts/source-size-policy.js`.
3. For Android, run
   `cd android_app && ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew lintDebug assembleDebug testDebugUnitTest`.
4. For gateway prerequisites, run `cd gateway && npm run check`.
5. For browser follow-ups, run
   `cd browser_extension && npm run verify && npm run smoke`.
6. Commit the coherent unit with a Conventional Commit.
7. Create the exact-candidate preview or release artifact. Android uses the
   continuity signer and a device-reachable preview.
8. Prove rollback, predecessor compatibility, and that no recording, voice
   turn, upload, agent run, queue job, migration, or active session is stranded.
9. Integrate through the guarded master path.
10. Publish only when the active-promotion gate passes, then record publication,
    installation, and physical smoke separately.

This documentation-only program unit creates no deployable artifact and must
not be promoted as though the Android behavior already exists.
