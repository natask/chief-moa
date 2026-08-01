# Initial intent register — 2026-08-01

This register is the first synthesis of the project-linked history audit. It is
an alignment artifact, not a replacement master product document. Stable
accepted outcomes still belong in `CORE_PRODUCT_INTENT.md`; architecture and
ticket changes follow only after candidate alignment.

## Recovered product spine

The highest-confidence objective is not another chat client or another task
tracker. Ag is the operating system for the user's work:

```text
immutable user evidence
  -> visible, correctable routing
  -> durable objective and applicability
  -> bounded tasks with named owners and dependencies
  -> agent runs and exact artifacts
  -> independent verification
  -> preview / user acceptance where needed
  -> release and exact-surface smoke
  -> observed outcome, blocker, or next action
```

The same durable work follows the user across Surfaces. Each Surface keeps its
own context, permission, approval, local execution, and receipt authority.
Compact surfaces show the current interaction and urgent control; full
workspaces show intentions, threads, agents, plans, evidence, artifacts,
history, settings, and release state.

## Candidate groups

| Candidate | Proposed applicability | Current audit state | Main gap |
| --- | --- | --- | --- |
| One personal companion and one durable work/history plane | universal product invariant | partially satisfied | Backend primitives exist; ordinary Surface work does not expose one canonical portfolio. |
| Every meaningful input remains source-linked and recoverable | universal product invariant | partially satisfied | Entire and gateway history are fragmented; production completeness and retained-media policy are unproved. |
| Intent-to-finished-work lifecycle with owner, evidence, exact candidate, and outcome | universal product invariant | partially satisfied | Intent, work, run, artifact, and release primitives are not one visible ordinary-product loop. |
| Proposal/evidence never silently becomes action authority | universal product invariant | partially satisfied | Strong contracts exist; browser/Android surface-program and connector wiring remain incomplete. |
| Compact current-turn surface plus deep workspace | cross-surface default | partially satisfied | Android/browser are furthest along; Mac differs; Windows/iOS are scaffolds; controls still conflict. |
| Immediate transcript/result/progress feedback without layout jump | cross-surface default | partially satisfied | Code exists, but loaded-browser and physical-phone behavior remains unproved and has recent regressions. |
| Context captured at submission and preserved across later navigation | cross-surface default | partially satisfied | Browser send-time evidence is implemented; complete cross-surface artifact/context binding is not. |
| Background work continues while the foreground companion remains responsive | cross-surface default | partially satisfied | Run stores/routing exist; user-facing switchboard, steering, dependencies, and material notifications are absent. |
| Browser reads, acts, annotates, runs reviewed page programs, and delegates in background | surface-specific: browser | partially satisfied | Anchored UI, full delegation envelope, purchase checkpoint, workspace, and loaded QA remain open. |
| Android provides literal launcher dictation, Assistant voice, local actions, and History-first full app | surface-specific: Android | partially satisfied | Pause/resume, capture visibility/delete, reliable resend, thread selection, OTA truth, and physical QA remain open. |
| Mac is a native companion independent of the browser, with an explicit browser bridge | surface-specific: macOS | partially satisfied | Candidate exists without signed/install/TCC proof; compact versus workspace shape and bridge remain open. |
| Hosted accounts, user-bound devices, owned data, privacy controls, and assisted self-hosting | universal product invariant | partially satisfied | Production remains single-bearer/single-owner with missing object ownership, export/delete, and privacy policy. |
| Parallel implementation converges automatically to one obvious integrated truth | universal development invariant | partially satisfied | Isolation and safety rules exist; CI-disabled master integration, unified release status, and automatic closure are not operational. |
| Companion identity/persona/voice/appearance/motion is one reviewable package | cross-surface default | partially satisfied | Gateway/browser/Android/website fragments exist; canonical Ag naming and Mac/Windows parity do not. |

## Decisions that remain visible rather than guessed

1. Compact controls and expansion: latest history includes one-line streaming,
   bounded click expansion, Copy, pause/resume, cancel/send/branch requests,
   and earlier hover scrollback/five-line directions. The current one-to-three
   line candidate is an implementation probe, not proof that every control and
   history behavior is settled.
2. Gesture and branch semantics: single/current, double/new, hold/PTT,
   triple/cancel, and explicit buttons conflict across current authority and
   recent feedback. Run a usability comparison before assigning hidden triple
   behavior or universal fresh-thread behavior.
3. Active thread ownership: decide whether every Surface follows one global
   active thread or remembers its own last thread.
4. Incognito: decide whether it is no-write only with standing facts, or strict
   no-read/no-write.
5. Raw audio: reconcile recoverability and quality evaluation with off-by-default
   retention, immediate deletion, backup expiry, and explicit consent.
6. Editing: distinguish correction, edit-and-regenerate-as-fork, preferred
   assistant answer, re-transcription, and literal/corrected/structured writing.
7. Release integration while GitHub Actions is disabled: choose an equivalent
   exact-candidate local/self-hosted runner rather than ad hoc exceptions.
8. Android native/status-area mode, hands-free driving, foot-pedal invocation,
   and desktop companion shape remain explicit experiments.

## First runnable alignment examples

1. **Work workspace:** show three real historical candidates—active, waiting for
   user, and satisfied—with source evidence, applicability, owner, next action,
   exact artifact, and acceptance state. Let the user correct one classification
   without launching work.
2. **Compact surface matrix:** render the same seeded turn on Android, browser,
   and Mac with two control variants. Exercise stream, expand, pause, copy,
   branch/cancel, drag, pass-through, large text, and companion state on real
   surfaces.
3. **Situated browser loop:** on a disposable page, propose a restyle and
   anchored annotation, approve, apply, survive scroll, stale on replacement,
   undo, and show effect receipts.
4. **Cross-surface handoff:** begin browser work, steer the same intent/thread
   from Android or Mac, then resume in browser with the same evidence, run, and
   stop state.
5. **Feedback-to-candidate loop:** capture a user-approved short interaction
   recording against an exact release, create a source-linked intent, produce an
   isolated harmless candidate, show verification and artifact digest, and keep
   install/promotion explicit.

The first implementation priority after alignment is the Work workspace. It is
the missing product surface that makes every other lane legible and lets the
user approve which historical candidates should become actual work.
