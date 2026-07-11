# Peter/Natstack Merge Ledger: Intent Runtime 2026-07-11

## Run objective

Deliver a coherent, user-visible Chief Moa slice that turns voice capture into
durable, navigable intent state: explicit send, foreground pause, durable park
and resume, cancel, new-root versus continuation, temporary transactional
preference intents that return to their parent, project rehydration, and owned
voice/LLM trace correlation.

## Non-goals

- Build or adopt a generic observability platform.
- Replace the current voice provider pipeline.
- Treat operational telemetry as canonical conversation or intent state.
- Promote a live target without preview, rollback, no-interruption,
  compatibility, backup/restore, and smoke evidence.
- Turn the separate company hypothesis into implementation scope.

## Live-application constraints

- The active gateway at `https://api.agee.app` is live.
- No slice may edit the worktree backing a running application.
- Preview state, storage, URLs, queues, and workers must be isolated.
- Recordings, voice turns, uploads, agent runs, and active sessions must not be
  interrupted or stranded.
- Persisted-state changes must be additive and old/new compatible.

## Base and staging

- Original base ref: `f08e48923026019c648e3296f91efae742f86c52`
- Rebased integration base: `caba6a1` (`feat: add Apple Aggie surface authority seam`)
- Staging branch: `agent/intent-runtime-20260711-v2`
- Staging worktree:
  `/Users/natnaelkahssay/projs/chief-moa-worktrees/intent-runtime-20260711-v2`
- Original staging is retained unchanged at
  `/Users/natnaelkahssay/projs/chief-moa-worktrees/intent-runtime-20260711` as
  rollback and comparison evidence.
- Active source worktree remains untouched.

## Verification contract

- Gateway: `cd gateway && npm run check`
- Browser extension: `cd browser_extension && npm run verify && npm run smoke`
- Android: `cd android_app && ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew assembleDebug`
- OpenSpec: run the matching strict validator when available; otherwise inspect
  the complete change and record the missing validator.
- Runtime: isolated gateway smoke plus manual gesture QA closest to the changed
  behavior.

## Slice ledger

| Slice | Branch | Worktree | Ownership | State |
|---|---|---|---|---|
| S0 contract | staging | staging worktree | contracts, OpenSpec, architecture, ledger | contracted |
| S1 intent domain | `agent/intent-domain-20260711` | `chief-moa-worktrees/intent-domain-20260711` | new event-backed intent module/tests | implementing |
| S2 voice drafts | `agent/voice-drafts-20260711` | `chief-moa-worktrees/voice-drafts-20260711` | new draft store/tests/smoke | implementing |
| S3 Android | `agent/android-draft-controls-20260711` | `chief-moa-worktrees/android-draft-controls-20260711` | Android capture state/gestures/tests | implementing |
| S4 browser | `agent/browser-draft-controls-20260711` | `chief-moa-worktrees/browser-draft-controls-20260711` | extension capture state/gestures/tests | implementing |
| S5 context/protocol | `agent/context-protocol-20260711` | `chief-moa-worktrees/context-protocol-20260711` | repaired M3 context + repaired M5 protocol | audit |
| S6 gateway integration | `agent/intent-gateway-integration-20260711` | `chief-moa-worktrees/intent-gateway-integration-20260711` | HTTP/WS admission, routes, intent/trace bridges | contracted |
| S7 verification | staging | staging worktree | integration gates, runtime QA, release evidence | pending |

## Research passes

- Intent/thread/work-graph topology: complete. The event substrate is the
  canonical persistence boundary; thread, project/repo binding, work task,
  work node, run, and artifact remain distinct projections with no intent
  aggregate or focus stack.
- Android/browser gesture topology: complete. Send exists; foreground pause,
  durable park/resume, directional outcomes, and parent-return do not. System
  cancellation can incorrectly take a send path on both surfaces.
- Gateway profile/telemetry topology: complete. Profile changes and receipts
  exist; product events remain canonical and semantic telemetry remains a
  bounded, loss-tolerant projection.
- Existing branch/worktree reuse audit: complete. M3 context artifacts and M5
  Aggie protocol are unique and reusable; M3 remains blocked until context is
  selected before answering. The Android resolver-only branch adds no required
  behavior and will not be merged.
- Live deployment and state-safety audit: pending integration.
- Local reference-product resolution: complete. The forgotten software-factory
  reference is Superset (`/projs/superset`), with Emdash (`/projs/emdash`) as
  the direct local/YC competitor. Superlog and StarSling resolve the agentic
  observability and self-driving CI references. These are recorded as separate
  adapter/evidence nodes from canonical voice transactions and intent state.
- Voice telemetry reuse validation: complete. LiveKit Agents is the closest
  unified voice timeline but its Insights store is cloud-only; Pipecat is the
  strongest inspected OSS pipeline instrumentation reference; Langfuse and
  Phoenix are suitable optional trace/eval projections. None of the inspected
  mature/open packages supplies the complete owned audio + transaction + trace
  + agent-brief outcome as one self-hosted product.

## Baseline evidence

- Gateway: `npm ci`, then `npm run check` -> 187 pass, 0 fail, 1 skip.
- Browser extension: `npm run verify && npm run smoke` -> pass.
- Android: `ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew assembleDebug`
  -> BUILD SUCCESSFUL.
- The first gateway check failure was missing worktree-local dependencies, not
  a source failure. The lockfile install reported two existing high-severity
  audit findings; no forced dependency rewrite was attempted.

## Blocking findings converted to contracts

1. Explicit new/incognito turns currently assemble caller-thread context before
   their filing decision; clean-slate and privacy claims therefore fail closed.
2. Broker routing/launch currently occurs before the broker event is durable.
3. `cancel_turn` preserves an incomplete canonical turn and is not a content
   discard operation.
4. `audio_note` is a storage-only recording and cannot be relabeled as a
   resumable voice input draft.
5. Android `ACTION_CANCEL` and browser `pointercancel` can commit a confirmed
   hold; OS cancellation must always discard/no-execute.

## Merge and audit history

- 2026-07-11: created isolated staging worktree from `f08e489`.
- 2026-07-11: recorded scope, non-goals, live constraints, and verification
  before implementation.
- 2026-07-11: reran all three baseline surface gates in the isolated staging
  worktree.
- 2026-07-11: completed Tier-2 topology audits and started two Tier-3 contracts:
  product-events-backed intent runtime and a distinct voice-draft lifecycle.
- 2026-07-11: the active source advanced by 19 commits during the isolated run.
  Created `agent/intent-runtime-20260711-v2` at `caba6a1` and cherry-picked only
  the two run contract/OpenSpec commits. A wholesale context-lane cherry-pick
  conflicted with the newer M3/M5/Apple/Windows/companion work and was aborted
  cleanly.
- 2026-07-11: manually ported only the three independently audited context
  repairs still absent at `caba6a1`: clean-slate answer-message admission,
  a strict 500-entry decision-stash bound, and exhaustive executable-authority
  field rejection. The newer full surface/device authority comparison was
  retained unchanged. Focused protocol tests pass 13/13 and context preflight
  tests pass 9/9. A first full check proved its 22 failures were exclusively
  missing worktree-local dependencies in child smoke processes; `npm ci` then
  installed the lockfile in this isolated worktree (reporting the same two
  existing high-severity audit findings), and `npm run check` passed 237,
  failed 0, skipped 1. No live state was used or mutated.
- 2026-07-11: contracted the serial gateway integration lane, including exact
  route-before-work ordering, transactional profile focus, zero-provider draft
  controls, bounded PCM coalescing, retryable failed SEND claims, and capability
  advertisement only after the full path is active. The worktree will be
  created only after the audited intent/store slices are merged into staging.
- 2026-07-11: resolved and recorded the user's forgotten product references
  from local source plus current official YC pages in
  `research/reference-product-graph.md`; no external product was installed,
  configured, or given repository/user data.
- 2026-07-11: recorded the validated voice transaction/telemetry/evaluation
  category model and current reuse map in `research/voice-telemetry-stack.md`.
  This prevents OTel or an LLM trace backend from becoming a competing canonical
  conversation/audio store.
- 2026-07-11: inspected the committed Superset architecture without modifying
  its dirty local checkout and recorded reusable product-completeness patterns
  in `research/superset-stack-lessons.md`: module boundaries, local/hosted state
  separation, state-isolated previews, releases, upstream-fork lifecycle, and
  operational documentation. Explicitly rejected its workspace/task schema as
  Chief Moa's canonical intent model.
- 2026-07-11: consolidated the user's rapid spoken statements into
  `research/spoken-intent-map.md`, with ten bounded product nodes and explicit
  authority edges. This keeps capture, intent, canonical voice history,
  telemetry, agent-generated operations knowledge, software-factory execution,
  CI optimization, instrumentation, trace/eval backends, and infrastructure
  dashboards related without collapsing them into “observability.”
- 2026-07-11: intent focused repair passed 16/16, but the main orchestrator then
  reproduced a real-adapter race with two independent runtimes over JSONL: both
  commands fulfilled and persisted stream versions `[1,2,2]`. Added repair
  contract 3 requiring an explicit compare-and-append contract shared by JSON
  and PostgreSQL. The intent slice remains BLOCK and uncommitted until the real
  substrate test is green and independently audited.
