# Design: Historical Intent To Implementation

## Intent Resolution

Primary intent: recover recent mobile-agent notes and turn the still-relevant
ones into actual product work.

Constraints and follow-ups:

1. First establish whether the source material was durably captured.
2. Preserve distinctions among ideas, corrections, decisions, requests, and
   worries instead of treating each utterance as a ticket.
3. Architect and align before implementation.
4. Reuse the gateway conversation and work-history authorities.
5. Keep execution and deployment behind the existing proposal, approval,
   receipt, verification, and promotion boundaries.

Open product choice: whether raw record-mode audio notes should be included by
default. The recommended first slice excludes them unless the user explicitly
requests transcription, because record mode currently promises storage without
provider processing.

The first accepted evidence source is the project-linked Entire corpus. It is a
development-history source, not the canonical end-user conversation store. Its
coverage is bounded to sessions captured in this repository and its linked
worktrees. The production gateway export remains necessary before the product
can claim account-wide or cross-device completeness.

## Considered Shapes

### A. On-demand bounded review (recommended)

The user requests “last 50 notes” or “since July 1.” The gateway exports the
complete bounded evidence set, an intent resolver creates a draft review, and
the user approves or corrects it before tickets exist.

Tradeoffs: clearest consent and provenance, easy to retry and compare, minimal
new runtime machinery. It does not proactively remind the user of old ideas.

### B. Continuous background intent mining

Every captured turn updates an intent index and may propose tasks immediately.

Tradeoffs: faster recall, but creates noisy standing interpretations, raises
retention/consent questions, and risks converting exploratory speech into a
backlog. It is premature until the on-demand review's precision is measured.

### C. Client-side export into an execution session

Android downloads recent history and passes it directly to a coding agent.

Tradeoffs: quick prototype, but duplicates canonical state on the phone,
bypasses gateway work-history linkage, makes completeness hard to prove, and
blurs the Android/gateway/execution boundary. Rejected.

## Selected Architecture

Use an on-demand `historical_intent_review` workflow owned by the gateway and
materialized as a durable artifact. The workflow has four explicit phases:

```text
bounded history query
  -> immutable evidence manifest
  -> draft intent resolution and implementation audit
  -> current-user alignment
  -> approved OpenSpec tasks / queued worker proposals
```

Before that gateway workflow is wired, the repository provides a read-only
local inventory command:

```sh
node scripts/intent-history/audit-entire-history.mjs \
  --kind direct-user --format json
```

The command parses materialized Claude/Codex Entire schemas, recovers missing
full transcripts from `refs/heads/entire/*`, labels known wrappers, removes
exact content duplicates, hashes evidence, applies deterministic topic tags,
and emits no raw excerpt unless `--include-excerpts` is explicit. It is triage,
not semantic alignment, and it cannot accept a candidate or launch work.

The evidence manifest is created before model analysis so completeness can be
checked independently. The resolver may summarize evidence but cannot rewrite
or delete it. Alignment produces a new revision rather than mutating the draft.

## Ownership And Canonical State

| Component | Responsibility | State owned |
| --- | --- | --- |
| Android/mobile surface | Ask for a scan, choose the window, show compact review state, collect approval/corrections | UI draft only |
| Gateway history reader | Page across canonical user-authored records and optional audio-note transcripts | Conversation/audio-note records remain canonical |
| Evidence manifest builder | Freeze source IDs, hashes, timestamps, speaker, session/thread, capture status, and query boundary | `historical_intent_evidence` artifact |
| Intent resolver | Separate goals, solutions, worries, corrections, contradictions, and unknowns; cluster related evidence | Versioned draft `historical_intent_review` artifact |
| Implementation auditor | Compare candidates with OpenSpec, project briefs, commits, diffs, runs, verification, and deployment evidence | Audit findings inside the review artifact |
| User alignment surface | Accept, reject, edit, defer, or request more evidence per candidate | Append-only review decisions |
| Workflow/worker lane | Convert approved candidates into narrow OpenSpec tasks and proposed/queued runs | Existing task, run, artifact, and receipt records |

The review artifact belongs with the gateway work-history/artifact store, not in
provider memory. Architecture decisions and approved task definitions are also
written to the repository OpenSpec so another coding session can resume them.

## Contracts

### Bounded history query

Extend the authenticated history read contract with:

- `source`: one or more of `voice`, `chat`, `broker`, `browser`, `audio_note`;
- exactly one stable window: `last_n`, or `from`/`to` plus cursor;
- `speaker=user` as the default for intent extraction;
- stable ascending ordering and an opaque cursor;
- `snapshot_at`, `has_more`, counts by source, and excluded/unreadable counts.

Assistant text may be returned as adjacent context but is never classified as a
user intent. Incomplete voice turns remain evidence and retain their incomplete
flag. A missing transcript is reported, not silently discarded.

### Optional audio-note transcription

Raw audio stays canonical and unchanged. If explicitly requested, the gateway
creates a derived transcript artifact containing audio-note ID and hash,
transcriber/version, language hints, timestamps, confidence/quality state, and
the resulting text. Failure leaves the audio note available and marks the item
`untranscribed`; it does not make the scan appear complete.

### Intent candidate

Each candidate includes:

- stable candidate and review revision IDs;
- short title and objective using the user's language;
- kind: `goal | request | decision | correction | concern | idea | question`;
- source evidence refs and short attributed excerpts;
- confidence and unresolved questions;
- relationships: duplicates, refines, contradicts, or supersedes;
- audit state: `new | already_satisfied | partially_satisfied | superseded |
  contradicted | unclear | not_actionable`;
- implementation evidence refs and missing acceptance evidence;
- applicability scope: `universal_product_invariant |
  cross_surface_default | surface_specific | experiment | concern_or_question`;
- explicit Surface exceptions and their rationale;
- proposed architecture/ticket refs only when applicable.

Applicability is independently aligned from candidate meaning. A user can agree
that a statement was correctly recovered while correcting which Surfaces it
governs. Cross-surface defaults are inherited unless a named platform exception
is recorded. Experiments remain prototypes and cannot silently become stable
product rules.

### Alignment decision

For each candidate the user can `approve_for_design`, `approve_for_ticketing`,
`edit`, `defer`, or `reject`. Bulk approval is allowed only over an explicit set
of candidate IDs and a visible review revision. A later source scan never
inherits approval automatically.

## Implementation Audit Rules

- `already_satisfied` requires an accepted spec or durable project decision,
  matching committed code where code is required, and the relevant verification
  evidence. Deployment-dependent outcomes also require a deployment record and
  post-promotion smoke evidence.
- A matching commit without verification is `partially_satisfied`.
- A matching assistant promise, transcript, or queued run is not implementation.
- Conflicting user statements remain separate until ordering and intent are
  resolved from timestamps and current-user alignment.
- The auditor may propose a likely match but records uncertainty rather than
  forcing a binary result.

## Failure And Trust Behavior

- Authentication or scope failure returns no history.
- Cursor drift is prevented by binding all pages to `snapshot_at`; expired
  snapshots restart visibly.
- Missing/corrupt records appear in manifest counts and lower completeness.
- Resolver failure preserves the manifest and can be retried with a new review
  revision.
- No review endpoint launches a harness or executes a local action.
- Ticket materialization is idempotent by review revision and candidate ID.
- Provider keys and raw credentials never enter Android or review artifacts.

## Rollout

1. Read-only capture audit and cursor-based export, with no model analysis.
2. Deterministic manifest plus draft intent review stored as an artifact.
3. Repo/work-history auditor with evidence-backed status classifications.
4. Android compact review/approval handoff to the full app.
5. Approved-candidate ticket materialization and worker proposals.
6. Optional audio-note transcription after a separate consent/retention review.

Continuous background mining remains out of scope until review precision,
rejection rate, privacy behavior, and artifact growth are measured.

## Proposed File Map

| File or component | Change | Why separate |
| --- | --- | --- |
| `gateway/lib/context-history.js` or extracted history reader | Cursor/time/source/speaker query over canonical records | Retrieval completeness is independent of model analysis |
| Gateway history dispatcher | Authenticated query contract | Keeps transport and auth at the gateway boundary |
| New gateway historical-intent module | Manifest, review revisions, decisions, idempotency | One owner for the workflow state machine |
| Existing work-history/artifact adapter | Persist evidence and review artifacts | Avoid another store |
| Broker/worker workflow package | Audit repo evidence and materialize approved tickets | Execution remains worker-owned |
| Android full-app history/review surface | Window selection and candidate decisions | Deep review stays out of the overlay |
| OpenSpec change/tasks | Durable accepted behavior and implementation slices | Decisions must survive chat sessions |

Exact source files should be selected only after alignment and a narrow ticket
for each rollout slice.

## Verification Strategy

- Seed more than 200 mixed-source records and prove complete, stable pagination
  for last-N and time-window scans.
- Prove anonymous, wrong-token, and cross-scope reads fail closed.
- Prove assistant messages never become candidates without user evidence.
- Prove incomplete/untranscribed/corrupt items are counted in completeness.
- Prove contradictory and superseding statements retain both source refs.
- Prove feedback from one Surface remains surface-specific until applicability
  is aligned, and prove an accepted cross-surface default carries explicit
  platform exceptions.
- Prove a promise or queued run is not marked implemented; a committed,
  verified, deployed result can be.
- Prove review retries and ticket materialization are idempotent.
- Prove no scan, review, or approval executes code or promotes a deployment.
