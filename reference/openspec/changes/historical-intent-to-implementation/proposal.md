# Historical Intent To Implementation

## Status

Proposed for product and architecture alignment. This change does not authorize
implementation or the execution of work inferred from historical messages.

## Why

The user records product ideas, corrections, worries, and implementation
requests through the mobile agent over time. Moa already retains several forms
of that history, but it does not offer a bounded way to answer:

- what did I ask for during the last X turns or days;
- which statements are durable product intent versus discussion or status;
- which intents are already implemented, partially implemented, contradicted,
  or still missing; and
- which missing intents can be converted into reviewable architecture and
  implementation tickets without treating old model output as authority.

Today this requires chat archaeology. Raw record-mode audio notes are an
additional blind spot because they are intentionally stored without STT and do
not participate in message-history search.

## User Outcome

The user can request a scan over an explicit historical window and receive an
evidence-backed intent review. After the user approves the resolved intent and
architecture, Moa can materialize narrow OpenSpec tasks and queue implementation
through the existing worker proposal/claim/receipt path.

## Invariant

Historical user speech and text are evidence of intent, not standing authority
to edit code, execute device actions, or deploy. Model and assistant messages
are context, not user requirements. No inferred task advances beyond a proposal
without current user review.

## Scope

- Add a queryable, cursor-based history export over typed chat, voice turns,
  brokered user intents, and optionally transcribed audio notes.
- Preserve source, time, session/thread, speaker, completion, and artifact
  provenance for every imported item.
- Resolve the window into atomic intent candidates without smoothing away the
  user's language, contradictions, or uncertainty.
- Compare approved candidates with OpenSpec, durable project state, commits,
  run evidence, verification artifacts, and deployment records.
- Produce a durable review artifact and, only after alignment, bounded OpenSpec
  tasks that can enter the existing agent-run workflow.

## Non-Goals

- No continuous background mining in the first slice.
- No automatic code edits, run launch, commit, push, or deployment from an old
  note.
- No inference that an assistant reply proves implementation.
- No provider conversation memory as the source of truth.
- No mandatory transcription of record-mode audio at capture time.

## Current Evidence And Gaps

Repository inspection on 2026-07-14 establishes that:

- `GET /v1/history/messages` merges voice-turn, typed-chat, and broker-event
  records and supports token-protected text search.
- Canonical voice records can include transcript, assistant text, audio refs,
  classification, session/thread identifiers, and linked agent-run refs.
- `GET /v1/audio-notes` exposes separately retained raw notes, intentionally
  captured without STT, LLM, TTS, or agent routing.
- History retrieval is limited to the newest 200 matching items and has no
  cursor or first-class time/turn window.
- Audio notes and browser-turn records are not part of the unified history
  payload. Audio notes have no searchable text unless a later, explicit
  transcription step is introduced.
- Work-history contracts describe snapshots, diffs, verification, deployments,
  and feedback, but their full product-event implementation remains incomplete.
- The production gateway health endpoint is reachable. Actual production
  history could not be audited from this checkout because no gateway bearer
  token was present; capture completeness therefore remains unverified.

## Success Criteria

- A scan can deterministically cover the last N items or an inclusive time
  range without silently truncating at 200 records.
- Every intent candidate links back to immutable source evidence and identifies
  whether it came from user text, a voice transcript, or an explicitly generated
  audio-note transcript.
- The review distinguishes `new`, `already_satisfied`, `partially_satisfied`,
  `superseded`, `contradicted`, `unclear`, and `not_actionable`.
- Claims of implementation require repo/run/verification evidence, not semantic
  similarity alone.
- Only user-approved candidates produce implementation tickets, and normal
  verification, commit, preview, and promotion gates remain unchanged.
