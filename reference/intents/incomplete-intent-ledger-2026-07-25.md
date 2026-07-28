# Incomplete intention ledger

Updated: 2026-07-25  
Scope: material intentions expressed in the Chief MOA / agent-management conversation through this date.  
Status vocabulary: `proposed`, `draft`, `active`, `blocked`, `candidate`, `awaiting_verification`, `awaiting_merge`, `awaiting_deployment`, `complete`.

This is a reconstruction, not a claim that Chief MOA already maintains this
ledger automatically. Items are complete only when the requested artifact or
behavior has independent evidence and, where requested, has been merged and
deployed. The root should route work to the named owner or resume the existing
branch before creating a duplicate owner.

**Current-runtime owner snapshot:** at reconstruction time, only the root,
this reconstruction owner, and the independent ledger verifier were live.
Every product/research “current owner” below is historical ownership or an
existing branch unless the item explicitly says otherwise. `Draft` may mean
ready and unassigned; it does not mean a live worker is making progress.

## Selected near-term priorities

### 2026-07-27 release-candidate catalog slice

- **Stable ID:** `intent:chief-moa:release-candidate-catalog`
- **Status:** `candidate`.
- **Outcome:** immutable paginated published-bundle discovery with
  series/parallel lineage and exact device selection independent of channel
  heads.
- **Evidence:** migration 004, the shared catalog fixture, and release-control
  service/HTTP tests.
- **Boundary:** read/select/receipt/feedback only for devices; no publication,
  promotion, deployment, or channel movement.
- **Next gate:** independent review and Postgres migration/restore smoke before
  merge or deployment.

This table is an ordering aid, not a complete inventory. The numbered sections
below are authoritative and include additional runnable and longer-horizon
intents.

| Order | Intent | Status | Can run now under serialized concurrency? | Next gate |
|---:|---|---|---|---|
| 1 | `intent:chief-moa:global-intent-authority` | awaiting_verification | Yes | Reverify PR #63 corrections |
| 2 | `intent:chief-moa:codex-launcher-adapter` | awaiting_verification | Yes, after or with authority contract integration | Reverify PR #62 corrections against PR #63 |
| 3 | `intent:chief-moa:agent-switchboard-direct-binding` | draft | Yes, after authority API is accepted | Specify and implement directory resolution and conversation binding |
| 4 | `intent:chief-moa:fd-exhaustion-diagnosis` | draft | Yes | Measure PIDs, limits, descriptor ownership, and lifecycle |
| 5 | `intent:chief-moa:amharic-english-retry-evaluation` | draft | Yes | Assign/resume an owner and run repeated same-audio trials |
| 6 | `intent:chief-moa:wrong-script-policy` | candidate | Yes, after retry evidence informs policy | Independently verify candidate `62343c58` |
| 7 | `intent:chief-moa:audio-history-library` | awaiting_verification | Yes | Assign/resume verifier for PR #60 |
| 8 | `intent:chief-moa:short-repetition-production` | awaiting_verification | Yes | Run post-deploy behavioral smoke and independent verification |
| 9 | `intent:chief-moa:mac-clicky-surface` | awaiting_deployment | Yes | Post-merge verification and production/device delivery |
| 10 | `intent:chief-moa:dbos-adoption-decision` | draft | Yes | Run bounded DBOS spike and compare with current Postgres design |
| 11 | `intent:chief-moa:terminology-falsification` | draft | Yes, serialized | Assign and restart neutral tournament without fan-out |
| 12 | `intent:chief-moa:llm-inference-hardware-learning` | draft | Yes | Assign/resume learning owner |
| 13 | `intent:chief-moa:intent-systems-paper` | proposed | Yes, after canonical claims stabilize | Create paper outline and source-backed related-work pass |

## 1. Hosted global intent authority

- **Stable ID:** `intent:chief-moa:global-intent-authority`
- **Type:** design, implementation, verification, merge, deployment, ongoing operational objective.
- **Exact user outcome:** one hosted, self-hostable, global authority into which local and remote agents persist intents, identities, configurations, ownership, runs, telemetry, recaps, ancestry, artifacts, liveness, notifications, and recovery state. Start with one logical database and one entry point. Represent personal/business/company/project separation logically and preserve reversible future physical partitioning.
- **Source theme:** “the contract owner that I truly need is the intent management system”; “even if I’m running a local agent, it should persist into this central global intent management system.”
- **Scope:** Chief MOA gateway authority and schema. It does not itself execute tools or store raw credentials.
- **Current owner:** prior `/root/global_intent_system_owner`; branch `feat/global-intent-authority-20260725`.
- **Status:** `awaiting_verification`.
- **Evidence:** PR [#63](https://github.com/natask/chief-moa/pull/63); branch head `7d21e02e`; `reference/openspec/changes/chief-moa-persistent-intent-plane/global-authority-contract.md` on that branch. Baseline intent-plane PR [#58](https://github.com/natask/chief-moa/pull/58), merge `ffb62dc1ac0f97fea3ed3e38dac436365d5facf8`, is merged and was reported deployed.
- **Blockers:** the first independent review found delayed-heartbeat replay instability, terminal-agent resurrection, and incomplete credential filtering. Corrections exist at `7d21e02e` but no independent passing report is recorded.
- **Dependencies:** deployment infrastructure; launcher adapters; a later execution substrate.
- **Next bounded action:** have a sibling verifier test PR #63’s corrected lifecycle, replay, credential, authorization, and migration behavior; then merge and deploy only if it passes.
- **Acceptance criteria:** authoritative stable IDs; logical workspace/project placement; versioned agent specs; run/lease/heartbeat state; event ledger; idempotency; terminal-state fencing; credential-safe APIs; recovery projection; authorization boundaries; tests.
- **Completion criteria:** independent verification passes, PR #63 merges, production deployment succeeds, and production API smoke tests demonstrate create/register/progress/recover/explain behavior.
- **Risk/authority:** high—hosted security, secrets, identity, and cross-project isolation. No destructive migration without an approved rollback.
- **Serialized:** yes.

## 2. Local Codex launcher adapter

- **Stable ID:** `intent:chief-moa:codex-launcher-adapter`
- **Type:** implementation, verification, merge, deployment.
- **Exact user outcome:** a local Codex launch must register a durable agent and run in the hosted intent plane, update status/progress/completion, preserve stable identity and provenance, recover after local/session failure, and notify the user.
- **Source theme:** launched agents currently disappear with sessions; agents must be first-class and accessible across services.
- **Scope:** adapter between Codex/local launch behavior and Chief MOA APIs, not a replacement runtime.
- **Current owner:** prior `codex_intent_launcher_adapter_owner`; branch `feat/codex-intent-launcher-adapter-20260725`.
- **Status:** `awaiting_verification`.
- **Evidence:** PR [#62](https://github.com/natask/chief-moa/pull/62), branch head `51b70d1c`.
- **Blockers:** initial review found repeated-run lifecycle, retry idempotency, notification identity, policy ambiguity, and credential-handling defects. Corrections have not yet received a recorded independent pass. Integration with PR #63 remains unproven.
- **Dependencies:** `intent:chief-moa:global-intent-authority`.
- **Next bounded action:** independently test repeated launches, retries, crashes, notifications, credential redaction, and compatibility with PR #63.
- **Acceptance criteria:** stable agent identity across runs; one run record per invocation; idempotent retries; explicit status; context/artifact links; no stored credentials; honest recovery behavior.
- **Completion criteria:** verification passes, PR merges, adapter is installed in the intended local launcher path, and a real launch survives session loss while remaining inspectable in production.
- **Risk/authority:** high—local execution and credentials. Adapter may only receive explicitly granted capabilities.
- **Serialized:** yes, after authority integration is fixed.

## 3. Agent Launcher / Switchboard and direct agent connection

- **Stable ID:** `intent:chief-moa:agent-switchboard-direct-binding`
- **Type:** design and implementation.
- **Exact user outcome:** use one conversational surface to semantically find, launch, connect to, continue, manage, or transfer a durable agent. It must list and inspect all agents and disclose who launched each agent, why, when, its present status, and its work. For every incoming message it decides explicitly whether to continue the current binding, connect to another existing agent, route through a better-informed owner, or launch a new agent. The user says “connect me to the agent handling Amharic transcription” and then speaks directly to that agent without finding a tab or relaying through the root. A launch records model, prompt, tools, capabilities, execution environment/surface, grants, budgets, recap policy, artifacts, notification policy, and whether a human or another agent launched it. Human-launched versus agent-launched provenance and authority must remain distinguishable.
- **Source theme:** session and tab management is the problem; launcher and session continuation are the same surface; phone-local capabilities may determine placement.
- **Scope:** user-facing semantic addressing, Agent Directory, conversation binding, launch specification, capability grants, and placement. Ancestry is provenance, not an access hierarchy.
- **Current owner:** none active; partially covered by the global authority contract and PRs #62/#63.
- **Status:** `draft`.
- **Evidence:** conversation-level design; PR #63’s global contract; existing canonical intent runtime documents under `reference/openspec/changes/canonical-intent-runtime/`.
- **Blockers:** no accepted API for directory resolution, ambiguity handling, binding/transfer, or enforceable device capability grants; terminology itself is not finalized.
- **Dependencies:** global authority, launcher adapter, capability broker/device runtimes, terminology outcome.
- **Next bounded action:** write a bounded OpenSpec for `resolve -> connect | launch -> bind -> continue`, including ambiguous matches, consent, grant enforcement, device placement, and conversation handoff.
- **Acceptance criteria:** natural-language lookup; complete agent list/inspection; direct binding to an addressable agent; launch if no safe match; explicit per-message route/connect/continue/new-launch decision; explicit ambiguity handling; who/why/when and human-vs-agent launch provenance; versioned agent spec; enforceable grants; inspectable binding and transfer history.
- **Completion criteria:** independently verified implementation works from at least two surfaces and reconnects to the same durable identity after a session/process restart.
- **Risk/authority:** critical—semantic misrouting can expose data or mutate the wrong surface. Destructive or privileged operations require explicit grants.
- **Serialized:** yes, once authority semantics settle.

## 4. Reconciler and persistent run lifecycle

- **Stable ID:** `intent:chief-moa:persistent-run-reconciler`
- **Type:** design and implementation.
- **Exact user outcome:** a deterministic service periodically identifies intents that should be making progress, detects absent or stalled runs, safely initiates/resumes work, and pings the user. It sends a compact context packet rather than the entire history.
- **Source theme:** “looks at the task, and checks if there’s an ongoing agent”; aggressive context pruning; full telemetry plus recap.
- **Scope:** run objects, leases, fencing tokens, heartbeats, retry/backoff, budgets, context packets, and completion notifications.
- **Current owner:** none active; PR #63 adds some authority primitives but not the complete executor/reconciler.
- **Status:** `draft`.
- **Evidence:** `global-authority-contract.md` on PR #63; baseline APIs from merged PR #58.
- **Blockers:** execution substrate and scheduler choice are unresolved; terminal fencing must pass verification.
- **Dependencies:** global authority; DBOS/adoption decision; launcher adapters.
- **Next bounded action:** specify the run state machine and implement a single fenced reconciliation loop against one intent and one local/hosted launcher.
- **Acceptance criteria:** at-most-one active lease per fenced attempt; crash-safe retries; no resurrection after terminal state; bounded concurrency/backpressure; compact cited context; observable notification delivery.
- **Completion criteria:** chaos/replay tests pass independently and a killed worker is safely recovered without duplicate external effects.
- **Risk/authority:** critical—duplicate actions and runaway cost.
- **Serialized:** yes.

## 5. DBOS and durable execution substrate decision

- **Stable ID:** `intent:chief-moa:dbos-adoption-decision`
- **Type:** landscape research, technical evaluation, adoption decision.
- **Exact user outcome:** examine DBOS directly and decide whether to adopt it, fork/use a component, or reject it for agent durability and execution, based on evidence rather than analogy.
- **Source theme:** “fucker look at fucking DBOS”; database-as-operating-system/durable execution discussion.
- **Scope:** DBOS workflow semantics, queues, recovery, transactions, idempotency, cancellation, self-hosting, licensing, Python/TypeScript fit, observability, and boundary with Chief MOA’s intent domain.
- **Current owner:** prior `/root/dbos_agent_runtime_evaluation`; no durable final report was located.
- **Status:** `draft`.
- **Evidence:** `reference/openspec/changes/self-hostable-event-substrate/{proposal.md,design.md,adoption-research.md,tasks.md}`. Those documents treat DBOS/Absurd as candidates for step-level execution and leave task 4.1 unchecked. `reference/openspec/changes/production-grade-hosted-product/design.md` explicitly defers DBOS there.
- **Blockers:** no bounded executable spike or independent adjudication is recorded; current docs contain a provisional position, not the requested focused decision.
- **Dependencies:** persistent run/reconciler requirements.
- **Next bounded action:** implement the same crash/retry/cancel workflow in DBOS and the current minimal Postgres/Graphile approach; measure behavior and integration burden.
- **Acceptance criteria:** primary-source license/hosting verification; working crash recovery; idempotency and cancellation evidence; operational footprint; exact mapping of DBOS concepts to intent/run/artifact/provenance objects.
- **Completion criteria:** an independently verified adopt/fork/component/reject decision with a reproducible spike and migration boundary.
- **Risk/authority:** medium; no production adoption without rollback and data-ownership review.
- **Serialized:** yes.

## 6. File-descriptor exhaustion diagnosis

- **Stable ID:** `intent:chief-moa:fd-exhaustion-diagnosis`
- **Type:** diagnosis and operational remediation.
- **Exact user outcome:** determine how many physical Codex processes/sessions run, whether logical agents share a host/helper, how many descriptors each owns, whether the limit is per-process/per-user/system-wide, whether descriptors leak after completion, and whether VM/remote execution is warranted.
- **Source theme:** repeated `Too many open files (os error 24)` and stream disconnects.
- **Scope:** macOS process tree, `RLIMIT_NOFILE`, `kern.maxfiles*`, descriptor classes, growth/return-to-baseline experiment, orphan cleanup, concurrency/backpressure.
- **Current owner:** none active; the previous diagnostic could not spawn commands.
- **Status:** `draft` (runnable and currently unassigned).
- **Evidence:** identical unified-exec `os error 24` failures were reported across root and delegated agents; logical registry counts did not expose PIDs or FD counts. No `ps`/`lsof` table exists.
- **Blockers:** none for initial read-only measurement; this runtime can currently execute commands. A controlled restart or process cleanup may require separate authority after targets are proven.
- **Dependencies:** access to the host process table and permission to restart/stop confirmed orphan processes if required.
- **Next bounded action:** from an unaffected shell, capture PID/PPID/command, per-PID FD counts/types, limits, and baseline→1→2→4→8 agent lifecycle measurements.
- **Acceptance criteria:** identify the exact exhausted boundary and descriptor owner; distinguish leak from legitimate peak concurrency; reproduce; define cleanup/backpressure and justified limits.
- **Completion criteria:** independent reproduction confirms the cause, the repair returns near baseline after completed agents, and a bounded concurrency soak no longer disconnects streams.
- **Risk/authority:** high operational risk. Do not blindly raise limits or kill broad process groups.
- **Serialized:** yes; diagnostics should precede renewed parallel fan-out.

## 7. Terminology falsification tournament

- **Stable ID:** `intent:chief-moa:terminology-falsification`
- **Type:** neutral generation, evaluation, falsification, adjudication.
- **Exact user outcome:** evaluate all proposed terms—Agent Launcher, Agent Switchboard, Intent Manager/Plane/Router, Agent Directory, Conversation Binding, Run, Run Ledger, Context Packet, Reconciler, Artifact Store, Agent Specification, Capability Grant, Execution Surface—and competing terms from first principles. Use clean agents: candidate generation, blinded per-term evaluation, separate falsification, and fresh down-selection.
- **Source theme:** user rejected bias toward their preferred term and asked for falsification and pruning.
- **Scope:** taxonomy and product/system vocabulary, not system implementation.
- **Current owner:** none active.
- **Status:** `draft` (runnable serialized and currently unassigned).
- **Evidence:** conversation records the neutral-tournament protocol and candidate families. The attempted multi-agent evaluation wave disconnected; no durable adjudicated artifact was found.
- **Blockers:** no current blocker under serialized execution. The earlier
  unbounded fan-out failed during FD/stream instability and remains a
  historical failure mode and concurrency risk.
- **Dependencies:** serialized evaluation policy; stable taxonomy of system layers.
- **Next bounded action:** persist a layer-neutral definition sheet, then run evaluators sequentially with hidden candidate identities and one independent adjudicator.
- **Acceptance criteria:** at least three serious candidates per layer; consistent rubric; evaluator independence; falsification conditions; rejected-term ledger; ambiguity and audience tests.
- **Completion criteria:** independently adjudicated terminology document is accepted and referenced by the canonical design; no term is selected merely because it was incumbent.
- **Risk/authority:** low and reversible.
- **Serialized:** yes.

## 8. Amharic-English configuration and repeated-candidate evaluation

- **Stable ID:** `intent:chief-moa:amharic-english-retry-evaluation`
- **Type:** research/evaluation and prompt/configuration tuning.
- **Exact user outcome:** use the same consented audio repeatedly to determine whether prompt/language configuration or X retries reliably produces correct Amharic-English transcription, and whether a deterministic metric can choose the best candidate. Prefer improving first-pass/retry reliability over only rejecting bad output afterward.
- **Source theme:** Auto language plus a bilingual technical prompt; test the same audio five times; select among candidates.
- **Scope:** Chirp 3 configurations (`auto`, `am-ET`, supported bilingual forms), bilingual prompt variants, five identical trials where permitted, WER/CER, script validity, English-term preservation, confidence/agreement, latency, and cost. Policy is user/workspace-specific, not global.
- **Current owner:** prior `amharic_wrong_script_owner`; follow-up evaluation was reported running but no durable final retry-selection report is recorded.
- **Status:** `draft` (durable program exists; no live owner is currently registered).
- **Evidence:** `reference/openspec/changes/provider-agnostic-voice-agent-runtime/chirp-amharic-english-live-eval-20260713.{md,json}`. Existing results show `["en-US","am-ET"]` produced Hindi on the regression sample, while `am-ET`+prompt and `auto`+prompt avoided that script in the bounded corpus. The existing document does not prove five-way candidate selection.
- **Blockers:** consented representative audio/reference transcripts, provider cost, and possible provider determinism.
- **Dependencies:** language-profile policy; evaluation harness.
- **Next bounded action:** run the requested repeated same-audio matrix; compare first pass, retry-on-invalid, consensus/medoid, confidence, and judge-assisted ranking against reference text.
- **Acceptance criteria:** per-configuration trial table with WER/CER/wrong-script rate/English preservation/latency/cost; quantify candidate diversity; prove or falsify retry benefit; define stopping and selection rule.
- **Completion criteria:** independent verification reproduces the chosen policy on held-out Amharic, English, and code-switched samples; production config and monitoring are updated and deployed.
- **Risk/authority:** audio privacy and provider cost; use only consented/synthetic fixtures and sanitized reports.
- **Serialized:** yes.

## 9. User-scoped wrong-script protection

- **Stable ID:** `intent:chief-moa:wrong-script-policy`
- **Type:** implementation, verification, merge, deployment.
- **Exact user outcome:** when a transcription contains scripts outside a user/workspace’s declared languages, automatically flag it and retry or surface a visible error rather than allowing corrupted Bengali/Devanagari text into reasoning/history. Do not impose Nat’s Amharic-English policy on other users.
- **Source theme:** Bengali/Hindi characters; deterministic script check should be personalized and used as a reliability signal.
- **Scope:** configurable language/script policy, fail-visible validation, sanitized diagnostics, and integration with retry policy.
- **Current owner:** prior wrong-script owner; candidate branch `repair/voice-modes-server-size`.
- **Status:** `candidate`.
- **Evidence:** candidate commit `62343c58` (`fix(voice): reject wrong-script Amharic transcripts`); earlier owner reported focused tests passed. No PR, independent pass, merge, or deployment is recorded.
- **Blockers:** candidate may encode an overly user-specific assumption; retry behavior and held-out accuracy are not resolved; branch contains broader “voice modes/server size” context requiring scope review.
- **Dependencies:** retry evaluation and language profile schema.
- **Next bounded action:** independently review `62343c58` for user scoping, false positives, privacy, and integration with retry/fallback; revise before opening a focused PR.
- **Acceptance criteria:** per-user allowed language/script policy; visible structured `wrong_script` result; bounded retry; sanitized metrics only; no silent storage; fixtures for Ethiopic, Latin, mixed valid text, Bengali, and Devanagari.
- **Completion criteria:** independent verification, focused PR merge, deployment, and production replay of the sanitized regression sample.
- **Risk/authority:** medium—false rejection can lose speech; never log rejected raw speech without explicit retention consent.
- **Serialized:** yes.

## 10. Unified audio history/library

- **Stable ID:** `intent:chief-moa:audio-history-library`
- **Type:** product design, implementation, verification, merge, deployment.
- **Exact user outcome:** one visible Chief MOA history surface, especially in the browser extension/API, containing every retained audio item with playback, transcript, provenance, retranscription versions, and the ability to rerun the same pipeline/model. Preserve chunking/long-audio handling.
- **Source theme:** “single place where I see all the audio”; extension history entry point; listen, inspect, regenerate.
- **Scope:** unified projection over voice turns/audio notes, authenticated browser-friendly playback, Range support, transcript revisions/jobs, extension UI, retention/privacy.
- **Current owner:** prior `audio_history_implementation_owner`; branch `feat/audio-history-extension-20260725`.
- **Status:** `awaiting_verification` (candidate PR exists; no live owner is currently registered).
- **Evidence:** PR [#60](https://github.com/natask/chief-moa/pull/60). Remote head was reported `20f5a135`; local branch evidence later showed correction `74beecb6` (`fix: enforce read-only audio history boundary`), so branch/remote synchronization must be checked. Prior artifact: `reference/scratch/audio-history/audio-history-owner-2026-07-25.md` (reported on the owner branch).
- **Blockers:** independent review reported five material security/correctness issues; exact corrected-head verification is not recorded. API/web auth and shared gateway token safety were identified as major gaps.
- **Dependencies:** authenticated gateway identity, audio retention policy, STT retry/revision model.
- **Next bounded action:** synchronize the correction branch, enumerate the five review findings in the PR, and have a sibling verifier test auth, ownership boundaries, playback, history projection, and revisions. Separately investigate Chirp’s current synchronous, streaming, and batch long-audio limits, paid/API modes and flags, chunking requirements, and cost before choosing the retranscription path.
- **Acceptance criteria:** visible extension entry; per-user authorized listing; secure playback; transcript/provenance/revision display; bounded retranscription job; explicit retention/deletion policy; documented provider/model limits and paid/API long-audio options; tested chunked and supported unchunked behavior; long-audio behavior.
- **Completion criteria:** independent review passes, PR merges, deployed extension/gateway version is reachable, and a real retained audio item can be found, played, and retranscribed with version history.
- **Risk/authority:** critical privacy/security. Audio must never become globally readable or accessible through a shared client token.
- **Serialized:** yes.

## 11. Browser streaming transcript staircase

- **Stable ID:** `intent:chief-moa:streaming-transcript-staircase`
- **Type:** diagnosis, implementation, verification, merge, deployment.
- **Exact user outcome:** prevent cumulative streaming finals (`A`, `A+B`, `A+B+C`) from being appended as repeated staircase text, while retaining correct final transcription.
- **Source theme:** highly repeated transcription blocks compared with Branch Continue behavior.
- **Current owner:** prior `chief_moa_transcript_duplication_diagnosis`.
- **Status:** `awaiting_verification`.
- **Evidence:** root cause reported in gateway streaming STT assembly; PRs [#54](https://github.com/natask/chief-moa/pull/54) and [#57](https://github.com/natask/chief-moa/pull/57), commits `1fa23572` and `870ba350`; current production exact commit was later reported as `0c4b3899`, which contains these ancestors. Earlier successful deployment runs were `30174520828`, `30174910349`, receipt `drct_aa3a44743ea6`.
- **Blocker:** merge/deploy ancestry is proven, but a current-production behavioral staircase smoke result is not recorded in this ledger.
- **Next bounded action:** independently run the sanitized cumulative-final staircase against current production.
- **Completion criteria:** exact production revision contains the fix and a production-facing behavioral smoke proves the staircase does not recur.
- **Residual risk:** telemetry should continue to detect recurrence.

## 12. Preserve legitimate short repetitions in production

- **Stable ID:** `intent:chief-moa:short-repetition-production`
- **Type:** implementation, verification, deployment.
- **Exact user outcome:** cumulative deduplication must not delete deliberate repeated short phrases such as “very good, very good.”
- **Source theme:** independent verifier found the suffix check collapsed legitimate two-word repeats.
- **Current owner:** prior `short_repetition_repair_owner`.
- **Status:** `awaiting_verification`.
- **Evidence:** PR [#59](https://github.com/natask/chief-moa/pull/59) merged as `0c4b3899befb72794573972a7e71e60abd6629d1`; feature commit `50fadb64`.
- **Blockers:** deployment run `30177161885` reportedly succeeded and verified exact production commit `0c4b3899`; no production behavioral smoke evidence for literal repeated phrases is recorded.
- **Dependencies:** deployment pipeline health.
- **Next bounded action:** independently confirm production revision `0c4b3899` and run sanitized production staircase plus legitimate-repeat behavioral smoke cases.
- **Acceptance criteria:** cumulative finals dedupe; `go | go | very good | very good` preserves literal repetitions; no regression in partial/final assembly.
- **Completion criteria:** independent post-merge pass and production deployment/smoke evidence.
- **Risk/authority:** low-to-medium; incorrect assembly corrupts user-authored text.
- **Serialized:** yes.

## 13. Mac Clicky-inspired Chief MOA surface

- **Stable ID:** `intent:chief-moa:mac-clicky-surface`
- **Type:** product research, implementation, verification, deployment.
- **Exact user outcome:** use Chief MOA as the common voice/development interface on Mac with a Clicky-inspired notch/Dynamic-Island presentation, live transcription and waveform, visible execution feedback, optional assistant voice response, copy/insert, history, and the same Chief MOA backend rather than a separate product.
- **Source theme:** “why build a different system”; improve the Mac interface; transcription flows through the island.
- **Current owner:** prior `mac_clicky_surface_owner`.
- **Status:** `awaiting_deployment`.
- **Evidence:** research `reference/research/clicky-chief-moa-product-audit-20260725.md`; PR [#61](https://github.com/natask/chief-moa/pull/61) merged as `7f0f4e2cf4ba00a38bbabfac9620ddba12157354`.
- **Blockers:** no recorded independent post-merge approval or production/device delivery. The audit says true island presentation, assistant playback, and a complete Mac history/run UI remain gaps; PR #61’s exact coverage must not be overstated.
- **Dependencies:** audio history, agent status APIs, signed Mac delivery.
- **Next bounded action:** independently map PR #61 to the audit requirements, device-test the shipped slice, then specify the next missing bounded slice (likely island shell/assistant playback/history link).
- **Acceptance criteria:** native-feeling summon; low-latency partial/final text; waveform; clear run state; playback/copy/insert; history link; Chief MOA remains authority.
- **Completion criteria:** all agreed surface requirements pass independent Mac hardware testing and the signed build is deployed to the intended device/channel.
- **Risk/authority:** microphone/accessibility permissions and local application control.
- **Serialized:** yes.

## 14. Versioned knowledge artifacts independent of chat

- **Stable ID:** `intent:chief-moa:versioned-knowledge-work`
- **Type:** durable note/artifact design.
- **Exact user outcome:** thoughts and final products must live outside chat as searchable, versioned artifacts; preserve full telemetry for observability but maintain a curated evolving text/audio/video/code artifact with agent/intent provenance and Git-like change history.
- **Source theme:** “I don’t want what I’m generating to be living in some chat session.”
- **Current owner:** prior `persist_intention_os_insight`.
- **Status:** `complete` for the design artifact; implementation remains covered by global authority/artifact-store intents.
- **Evidence:** `reference/knowledge/versioned-knowledge-work.md` and `reference/knowledge/INDEX.md` on merged PRs [#55](https://github.com/natask/chief-moa/pull/55) and [#56](https://github.com/natask/chief-moa/pull/56), final merge `b198723264431451c5c581d03134c599c7f1ecda`.
- **Completion boundary:** the requested durable written direction is merged. Automated extraction/versioning is not complete and must not be inferred from this document.

## 15. Artifact store and text-first artifact lifecycle

- **Stable ID:** `intent:chief-moa:artifact-lifecycle`
- **Type:** design and implementation.
- **Exact user outcome:** agents create and update durable artifacts—initially text, later audio/video/code—with revisions, provenance, current canonical state, and links to supporting run telemetry.
- **Source theme:** books/documents and artifacts change over time; commits track the agent that changed them.
- **Current owner:** none active.
- **Status:** `draft`.
- **Evidence:** `reference/openspec/changes/postgres-work-graph-artifact-store/{proposal.md,design.md,tasks.md}`; versioned knowledge document; PR #63 global contract.
- **Blockers:** authoritative schema and storage split are not yet accepted; unclear content-addressing/version/merge policy.
- **Dependencies:** global authority, access control, object storage, Git integration.
- **Next bounded action:** implement one text-artifact vertical slice: create, revise with optimistic concurrency, link intent/run/agent, show diff, and restore an earlier version.
- **Acceptance criteria:** immutable revision history; mutable canonical pointer; provenance; authorization; conflict behavior; exportable plain text.
- **Completion criteria:** independent tests demonstrate concurrent writers, diff/restore, provenance, and export; deployed UI/API can manage a real evolving document.
- **Risk/authority:** medium; preserve user edits and avoid destructive overwrite.
- **Serialized:** yes.

## 16. LLM inference and hardware first-principles notebook

- **Stable ID:** `intent:research:llm-inference-hardware-learning`
- **Type:** learning, research, falsification, durable written artifact.
- **Exact user outcome:** rebuild a precise understanding of vanilla decoder-only transformers, attention/QKV, residuals, sampling, KV cache, prefill/decode, batching, memory/compute/energy, and then falsify the hypothesis that prefill and autoregressive decode warrant separate chips/systems. Compare speculative/Medusa and diffusion/recurrent alternatives and use accurate external visualizations.
- **Source theme:** extended hardware monologue; user explicitly said current mental model was not right and visualizations were not useful.
- **Current owner:** none active.
- **Status:** `draft` as a durable, runnable program; no live owner is currently registered.
- **Evidence:** `reference/research/llm-inference-hardware-notebook/README.md`, chapters `01`–`04`, `thesis-map.md`, `questions-and-experiments.md`, `sources.md`, `visuals/README.md`, and diagnostic `diagnostics/nat-mental-model-2026-07-25.md`.
- **Blockers:** no evidence that the user completed the exercises or that hardware claims were validated with measured workloads; later architecture changes can alter conclusions.
- **Dependencies:** access to representative models/serving traces and hardware measurements.
- **Next bounded action:** work through the forward-pass diagnostic with the user, then run one quantitative prefill/decode roofline and KV-transfer case with explicit model/batch/context/SLO assumptions.
- **Acceptance criteria:** user can derive Q/K/V attention and per-layer cache shape; hypotheses are stated with falsifiers; comparisons include monolithic, disaggregated, speculative, diffusion/recurrent cases; vendor claims are distinguished from measurements.
- **Completion criteria:** independently reviewed paper-quality thesis or explicit rejection, backed by reproducible calculations/experiments—not merely a completed notebook.
- **Risk/authority:** research uncertainty; avoid turning a serving trace into a universal hardware law.
- **Serialized:** yes.

## 17. Research paper on intention-oriented agent systems

- **Stable ID:** `intent:research:intention-oriented-computing-paper`
- **Type:** landscape research and paper.
- **Exact user outcome:** write a real paper extending work on tab/session management, memory, autonomous knowledge graphs, durable agents, semantic addressing, context compaction, and intention management; quote/source relevant researchers and explain the systems contribution.
- **Source theme:** “You can write a paper on this”; millions of tabs intersect with persistent intentions and first-class agents.
- **Current owner:** none active.
- **Status:** `proposed`.
- **Evidence:** Chief MOA research materials under `/Users/natnaelkahssay/projs/plans/moa/research/`; `reference/research/open-source-intent-control-plane-landscape-20260725.md`; global authority contract; versioned knowledge artifact. No canonical paper manuscript was located.
- **Blockers:** research question and contribution boundary are not frozen; terminology tournament and core architecture remain unsettled.
- **Dependencies:** landscape research, stable taxonomy, implemented system/evaluation evidence.
- **Next bounded action:** create a paper charter with falsifiable thesis, related-work categories, contribution claims, and evidence plan; do not begin promotional prose before claim validation.
- **Acceptance criteria:** primary-source related work; explicit distinction from workflow engines, memory systems, chat/session managers, agent harnesses, tab managers, and knowledge graphs; falsifiable evaluation.
- **Completion criteria:** independently reviewed manuscript with citations, system design, prototype evidence, limitations, and reproducible evaluation.
- **Risk/authority:** citation accuracy and novelty claims.
- **Serialized:** yes.

## 18. Automatic thought/intention extraction and routing

- **Stable ID:** `intent:chief-moa:thought-intent-extraction`
- **Type:** design, research, implementation.
- **Exact user outcome:** accept long, topic-switching speech; automatically identify notes, memories, questions, research needs, implementation requests, papers, insights, retrospective evaluations, and forks; connect them to existing knowledge and intents or create new ones without losing raw audio/transcript.
- **Source theme:** “when I think like this, there are intents”; knowledge graph managed by an LLM; seamless topic changes.
- **Current owner:** none active.
- **Status:** `proposed`.
- **Evidence:** planning research in `/Users/natnaelkahssay/projs/plans/moa/research/`; canonical intent runtime and versioned knowledge artifacts. No independently evaluated extractor is evidenced.
- **Blockers:** intent boundary ambiguity, over-generation, privacy, undo/merge/split semantics, and lack of labeled evaluation data.
- **Dependencies:** audio history, artifact lifecycle, global intent authority, switchboard.
- **Next bounded action:** define an editable extraction schema and create a small consented gold corpus from sanitized transcripts covering continue/fork/note/memory/research/action/no-op decisions.
- **Acceptance criteria:** every extraction cites source spans; confidence and alternatives are visible; user can merge/split/delete/reclassify; no action executes solely from an uncertain extraction.
- **Completion criteria:** independent evaluation meets agreed precision/recall and undo safety, then the deployed pipeline persists approved objects and routes them correctly.
- **Risk/authority:** high—private reflections and incorrect inferred intent. Default to reversible suggestions.
- **Serialized:** yes.

## 19. Daily intent/time-management loop

- **Stable ID:** `intent:chief-moa:daily-intent-loop`
- **Type:** ongoing product and operational objective.
- **Exact user outcome:** receive progress/status across durable projects; state what the user must do next; accept physical-world updates; plan and retrospect by hour/day/week/month/year; keep intentions advancing without manual project/session management.
- **Source theme:** “every day, what’s my goal for today?” and “a system that gives me an update on each one.”
- **Current owner:** prior branch `feat/daily-intent-loop-20260725`; no current active owner.
- **Status:** `draft`.
- **Evidence:** local branch exists at `7707d728`; canonical intent/runtime and durable delivery OpenSpecs. No demonstrated end-to-end daily loop was located.
- **Blockers:** depends on reliable intent state, notifications, user action capture, prioritization policy, and cross-surface delivery.
- **Dependencies:** global intent authority, reconciler, switchboard, notifications, artifact/status telemetry.
- **Next bounded action:** define one daily briefing/recap contract generated from authoritative intent records with citations and explicit user-action requests.
- **Acceptance criteria:** shows active/stalled/completed/blocked; differentiates agent actions from user actions; records plan and retrospective; every claim links to evidence.
- **Completion criteria:** deployed daily loop runs on schedule for a trial period, users can correct it, and independent review confirms no dropped or fabricated status.
- **Risk/authority:** personal-data privacy and notification fatigue.
- **Serialized:** yes after authority exists.

## 20. Cross-device capability grants and execution placement

- **Stable ID:** `intent:chief-moa:capability-placement`
- **Type:** architecture and implementation.
- **Exact user outcome:** an agent may be launched from one surface but execute on a phone, laptop, browser, or hosted worker based on required capabilities, with fine-grained application/data permissions and settings the user can inspect and revoke.
- **Source theme:** an agent launched from a laptop may need phone capabilities and application read/write access.
- **Current owner:** none active.
- **Status:** `proposed`.
- **Evidence:** global authority design distinguishes requested capabilities from runtime execution; existing platform surfaces exist in `apple_surfaces/`, `android_app/`, and `browser_extension/`. No common grant broker is evidenced.
- **Blockers:** platform-specific authorization models, device identity/attestation, secrets, offline behavior, revocation, and destructive-action confirmation.
- **Dependencies:** agent specifications, global authority, device runtimes, switchboard.
- **Next bounded action:** specify one end-to-end capability (`calendar.read` or another non-destructive example) across request, device grant, placement, execution, audit, expiry, and revocation.
- **Acceptance criteria:** requested capability is distinct from an enforceable grant; least privilege; device-bound credentials; revocation; audit; offline/expired behavior; no database field alone confers access.
- **Completion criteria:** independently verified cross-device demonstration with revocation and negative authorization tests.
- **Risk/authority:** critical security and privacy.
- **Serialized:** yes.

## 21. Chief MOA browser control, local files, and Tweeks/CDP parity

- **Stable ID:** `intent:chief-moa:browser-local-control`
- **Type:** product design, security architecture, implementation, verification, deployment.
- **Exact user outcome:** make the Chief MOA browser/extension the common browser-control surface with the practical capabilities currently associated with Tweeks and Chrome DevTools Protocol, including explicit user-authorized local-file access, rather than requiring a separate unfamiliar tool.
- **Source theme:** “Why can’t I have local file access?”; clone/provide the useful Tweeks MCP/CDP machinery through Chief MOA.
- **Scope:** tab inspection/control, stable element selection, console/network diagnostics, userscripts where authorized, downloads/uploads, and narrowly scoped local-file access. It is not blanket filesystem access from arbitrary pages.
- **Current owner:** none live; related worktrees/branches include `chief-moa-native-browser-control`, `chief-moa-integrate-browser-userscripts`, and browser steering/command-routing branches.
- **Status:** `draft`.
- **Evidence:** existing native-browser-control and userscript worktrees; `reference/openspec/changes/extension-gateway-roundtrip/`; no independently verified Tweeks-parity matrix or secure local-file delivery is recorded.
- **Blockers:** Chrome extension permission boundaries, native messaging/host installation, path scoping, user consent, and threat modeling.
- **Dependencies:** capability grants, launcher/switchboard, signed local helper.
- **Next bounded action:** build a capability-parity matrix against the concrete Tweeks operations the user uses, then implement one safe read-only local-file selection/read flow through a native host.
- **Acceptance criteria:** explicit path/user selection; least privilege; revocation; audit; no arbitrary page-origin file access; tested CDP/console/network/tab primitives; clear unsupported-capability reporting.
- **Completion criteria:** independent security review and device test pass; deployed extension/native helper performs the agreed parity set.
- **Risk/authority:** critical local-data and browser-session access.
- **Serialized:** yes.

## 22. iPhone/iOS Chief MOA surface

- **Stable ID:** `intent:chief-moa:ios-cross-device-surface`
- **Type:** product implementation, device verification, deployment.
- **Exact user outcome:** Chief MOA works across devices, including iPhone, with voice capture, durable audio/transcript history, agent launch/connect/status, and appropriate iOS-local capabilities; AirPods/device switching should remain usable.
- **Source theme:** iPhone is the missing surface; user may obtain hardware or ask an iPhone user to test.
- **Scope:** iOS client/surface, microphone/background constraints, notifications, history, switchboard, capability grants, and cross-device continuity.
- **Current owner:** none live.
- **Status:** `proposed`.
- **Evidence:** `apple_surfaces/` contains Mac work; no production iPhone artifact or hardware evidence was located.
- **Blockers:** iPhone hardware/test access, signing/provisioning, App Store/background-audio restrictions, and product scope.
- **Dependencies:** global authority, audio history, switchboard, capability placement.
- **Next bounded action:** audit the existing Apple code for iOS viability and define the smallest TestFlight/device slice: sign in, capture, persist transcript/audio, list intents, connect to one agent.
- **Acceptance criteria:** real-device capture and playback; authenticated cross-device history; agent status/connect; permission/revocation behavior; no unsupported background-operation claim.
- **Completion criteria:** independently tested signed iOS build distributed through the chosen channel and proven against the hosted authority.
- **Risk/authority:** microphone, notification, and device-data privacy.
- **Serialized:** yes.

## 23. Speech coaching and speaking autocomplete

- **Stable ID:** `intent:chief-moa:speech-coaching`
- **Type:** research, product design, implementation.
- **Exact user outcome:** analyze speaking without interrupting thought, then surface the highest-leverage recurring improvements: precise replacement words/phrases, vague references, structure, and fluency. Optionally offer live factual/phrase assistance or a short post-session coaching cycle.
- **Source theme:** speech pathology, “speech autocomplete,” and reviewing a 15-minute speaking segment for highest-leverage changes.
- **Scope:** user-controlled analysis of retained audio/transcripts, coaching rubric, privacy, live versus post-session assistance, and measurable improvement.
- **Current owner:** none live.
- **Status:** `draft`.
- **Evidence:** `reference/research/spoken-communication-improvement/{README.md,baseline-rubric.md,first-exercise.md,chief-moa-acceptance-test.md}`.
- **Blockers:** safe claims around pathology, distraction risk, personalized evaluation data, and UI timing.
- **Dependencies:** audio history, consent/retention, Mac/iOS surfaces.
- **Next bounded action:** run the existing rubric on one consented segment and produce at most three cited, recurring, actionable suggestions; measure whether they help on a later sample.
- **Acceptance criteria:** every suggestion cites transcript/audio spans; prioritizes recurring high-leverage patterns; user controls live/post-session mode; avoids medical diagnosis; improvement is measurable.
- **Completion criteria:** independently evaluated coaching loop demonstrates repeatable benefit and is deployed behind explicit consent.
- **Risk/authority:** sensitive biometric/voice data and medical-adjacent interpretation.
- **Serialized:** yes.

## 24. Agent-native runtime, VM, or operating environment

- **Stable ID:** `intent:research:agent-native-runtime`
- **Type:** systems research and possible infrastructure implementation.
- **Exact user outcome:** determine whether a VM/remote Linux environment or a more agent-native operating environment should run many durable agents with resource isolation, supervision, bounded concurrency, and recovery rather than overloading one Mac application/runtime.
- **Source theme:** FD exhaustion may expose operating-system/runtime limits; desire for “an operating system that is well operational for agents.”
- **Scope:** process isolation, descriptors, memory/CPU limits, cgroups/VMs, durable queues, worker pools, secrets, local-device capability bridge, observability, and backpressure. It is not yet authorization to build a new general-purpose OS.
- **Current owner:** none live.
- **Status:** `proposed` research candidate.
- **Evidence:** FD discussion; no measured host diagnosis or architecture decision yet.
- **Blockers:** root cause of FD exhaustion is unknown; a VM will not fix a leak.
- **Dependencies:** FD diagnosis, global authority, execution-substrate decision.
- **Next bounded action:** after FD measurement, compare three bounded deployments—fixed local host, Linux VM worker, hosted worker—using the same concurrency/recovery workload.
- **Acceptance criteria:** measured isolation, cleanup, capacity, latency, cost, secret/device-access boundaries, and operational complexity; distinguish durable intents from simultaneously running processes.
- **Completion criteria:** independently reviewed deployment decision and a reproducible worker image if VM/hosted execution wins.
- **Risk/authority:** high infrastructure and secret exposure; no broad migration before measurement.
- **Serialized:** yes.

## 25. Public audio/video/podcast publishing pipeline

- **Stable ID:** `intent:candidate:public-media-publishing`
- **Type:** candidate artifact/publishing workflow; unconfirmed external-action intent.
- **Exact user outcome:** potentially turn selected spoken thoughts or agent interactions into edited, bingeable audio/video/text and publish them to channels such as YouTube, podcast platforms, Instagram, LinkedIn, TikTok, or Twitch.
- **Source theme:** user considered making videos/podcasts, live streaming, splicing existing audio, and becoming more public.
- **Scope:** private capture, review, editing, channel formatting, approval, and publishing. No autonomous publishing authority is inferred.
- **Current owner:** none live.
- **Status:** `proposed`.
- **Evidence:** conversation only; no canonical implementation or publishing authorization was located.
- **Blockers:** current intent may be exploratory; content selection, privacy, third-party rights, account credentials, brand/editorial policy, and explicit approval are unresolved.
- **Dependencies:** audio/video history, artifact lifecycle, user approval surface.
- **Next bounded action:** ask for confirmation before implementation; if confirmed, build a local-only draft/export flow with mandatory per-item approval and no account posting.
- **Acceptance criteria:** source provenance; private-by-default drafts; editing/redaction; platform-specific exports; explicit final approval per publication; credential isolation.
- **Completion criteria:** only after explicit authority, independently verified draft/export/publish workflow and confirmed publication receipts.
- **Risk/authority:** critical reputational/privacy risk; external publishing is never implied by exploratory speech.
- **Serialized:** yes.

## 26. Release and unfinished-work closure umbrella

- **Stable ID:** `intent:chief-moa:unfinished-work-release-closure`
- **Type:** inventory, implementation coordination, verification, merge, deployment.
- **Exact user outcome:** reconstruct ongoing and uncommitted Chief MOA work, finish legitimate started changes, get them independently verified, merge them into master, deploy requested surfaces, and provide a final state rather than leaving abandoned worktrees/sessions.
- **Source theme:** explicit request to launch an agent to finish all uncommitted/ongoing work into master and deploy it.
- **Scope:** umbrella release program only. It must not indiscriminately merge dirty or experimental work; each child change retains its own acceptance, safety, and authority gates.
- **Current owner:** none live; historical cleanup owner status is not durably evidenced.
- **Status:** `draft`.
- **Evidence:** many Chief MOA worktrees and open PRs remain; canonical working tree is dirty with unrelated user changes; this ledger identifies known branches and gates.
- **Blockers:** no authoritative worktree/PR inventory adjudicating keep/finish/archive/abandon; some changes may belong to the user or be obsolete.
- **Dependencies:** FD diagnosis, this verified ledger, per-intent owners/verifiers, release pipeline.
- **Next bounded action:** perform a read-only inventory of every Chief MOA worktree, branch, open PR, dirty file, CI/deploy state, and owning intent; propose keep/finish/archive decisions without deleting anything.
- **Acceptance criteria:** no unowned work; no duplicate changes; every retained change has acceptance criteria and sibling verification; unrelated user changes preserved; deployments include receipts and smoke tests.
- **Completion criteria:** user-approved retained work is merged and deployed, rejected/obsolete work is documented (and only removed with authority), master is releasable, and this ledger reflects final evidence.
- **Risk/authority:** high. Never merge, overwrite, delete, or deploy broad dirty work without exact scope and verification.
- **Serialized:** yes; use bounded releases rather than one omnibus merge.

## Explicitly not promoted to autonomous work without a new user decision

The conversation also contained personal reflections about dating, family,
career, relationships, public identity, joining Etched, social media/podcasts,
speech improvement, and company formation. Internal speech-coaching research
and a private-by-default media pipeline are tracked above as product/candidate
intents. That does not authorize medical diagnosis, contacting people,
publishing content, applying to companies, buying devices, scheduling events,
or making relationship decisions. The thought-extraction system may propose
reversible notes or intents from exploratory material, but external actions
still require a clear current request and appropriate authority.

## Operational policy for this ledger

1. Route to an existing owner/branch before creating another agent.
2. Run the FD diagnosis before returning to high parallel fan-out.
3. Under serialization, advance one implementation or evaluation gate at a
   time; independent verification is a separate sibling assignment.
4. A merge is not a deployment. A candidate commit is not a verified fix. A
   design artifact is not an implemented system.
5. Update this ledger when evidence changes. Preserve earlier states in Git.
6. Do not mark deployment complete without a production revision and a
   production-facing smoke result.
