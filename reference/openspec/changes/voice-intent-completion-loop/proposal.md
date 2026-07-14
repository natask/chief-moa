# Voice Intent Completion Loop

## Status

Proposed for product and architecture alignment. This change authorizes a
durable plan, not product implementation, workflow execution, deployment, or
promotion.

## Why

Chief Moa already contains voice implementations, deterministic smokes, paid
provider evaluations, Android and browser QA instructions, work-graph records,
and several Fabro workflows. The product intent is nevertheless not managed to
completion. Evidence is distributed across OpenSpec checkboxes, command output,
dated evaluation notes, manual observations, commits, and deployment records.
A workflow can finish after its commands run while the actual outcome remains
unmeasured on the phone or unhelpful to the user.

The missing product capability is a durable intent-to-evidence loop. One
versioned objective must define what fluent and useful voice means, derive the
required evaluations for every applicable surface and service, retain their
evidence, identify gaps, drive bounded repair work, and refuse to call the
objective complete until the same candidate has passed the whole acceptance
contract.

## User Outcome

The user can state an outcome such as "voice is fluent and useful everywhere"
once, inspect the exact completion contract, and see the system move that
intent through evaluation, diagnosis, repair, re-evaluation, preview,
promotion, and post-promotion smoke. At every point the user can tell what is
proven, failed, blocked, stale, or not yet measured.

## Invariant

OpenSpec defines the accepted outcome. Fabro coordinates work toward it. The
gateway work graph stores execution and evidence state. None of those layers
may replace missing real-surface evidence with a code check, infer success from
a workflow exit, or grant model output authority to execute device-local
actions or promote an unsafe release.

## Scope

- Define a versioned voice objective and acceptance matrix covering fluency,
  usefulness, continuity, safety, observability, and operational delivery.
- Bind every evaluation result to the objective revision, candidate release,
  surface, configuration/profile, evaluator version, and evidence artifact.
- Add a Fabro orchestration shape that fans out independent gateway, provider,
  Android, browser, usefulness, and operations lanes, then joins them through
  an evidence audit and repair/re-evaluation loop.
- Reuse the existing gateway work graph and artifact store as the durable run
  and evidence substrate.
- Produce an honest completion projection with `passed`, `failed`, `blocked`,
  `not_measured`, and `stale` states.
- Require preview, rollback, compatibility, no-interruption, backup/restore
  where applicable, promotion, and promoted-target smoke evidence before an
  operational objective can complete.

## Non-Goals

- No new voice provider, transport, observability vendor, or evaluation
  framework in the first slice.
- No continuous autonomous code modification or production self-optimization.
- No claim that a build, deterministic fixture, provider socket, or server
  audio write proves an end user heard a useful response.
- No raw provider credentials in Android or the browser.
- No replacement of the existing OpenSpec voice contracts, Fabro engine,
  gateway work graph, or active-promotion safety gate.

## Success Criteria

- One objective revision expands deterministically into a visible acceptance
  matrix with an owner, evaluator, evidence kind, and freshness policy for
  every required cell.
- A single candidate release can be traced through all required evaluations.
- Deterministic, live-provider, real-device, real-browser, usefulness, and
  operational results remain distinct and cannot substitute for one another.
- A failed or missing cell creates a bounded diagnosis/repair proposal and
  returns only the affected and invalidated cells to evaluation.
- The loop stops only at fully evidenced completion, an explicit user decision,
  or a durable blocker with a named missing authority or external condition.
- The user can ask what remains and receive an evidence-backed answer rather
  than a checklist summary.

## Relationship To Existing Changes

- `provider-agnostic-voice-agent-runtime` remains the product voice contract and
  supplies most evaluation requirements.
- `streaming-cascaded-voice` supplies latency, long-response, interruption, and
  rollout acceptance checks.
- `open-voice-reliability-control-plane` supplies evidence honesty,
  endpoint-observed playout, anti-gaming, and candidate comparison rules.
- `historical-intent-to-implementation` governs recovering intent from older
  turns; this change governs carrying an already-approved current intent to
  completion.
- `postgres-work-graph-artifact-store` remains the durable work/evidence store.
