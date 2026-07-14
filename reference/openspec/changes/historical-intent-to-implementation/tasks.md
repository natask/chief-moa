# Tasks

No implementation task is authorized until the proposal and design are aligned
with the user.

## 0. Capture Audit And Alignment

- [ ] 0.1 With user-authorized gateway credentials, run a read-only production
  audit reporting counts, time coverage, source coverage, missing transcripts,
  incomplete turns, and pagination/truncation risk without copying raw content
  into logs.
- [ ] 0.2 Decide the first supported window semantics: last N user-authored
  items, an inclusive date range, or both.
- [ ] 0.3 Decide whether raw record-mode audio notes are excluded by default or
  offered through explicit derived transcription.
- [ ] 0.4 Align on the on-demand review architecture and candidate decision
  vocabulary.

Acceptance: the user can see what was and was not captured, and unresolved
choices are recorded before source changes begin.

## 1. Complete Read-Only History Export

- [ ] 1.1 Specify and implement stable snapshot pagination, source filters,
  speaker filtering, last-N/time windows, and completeness metadata.
- [ ] 1.2 Include all agreed user-authored mobile sources without duplicating a
  turn that also produced a broker event.
- [ ] 1.3 Add authorization, bounds, corruption, and greater-than-200-record
  coverage.

Acceptance: a seeded window can be exported completely and deterministically,
and missing/unreadable evidence is visible.

## 2. Evidence Manifest And Draft Review

- [ ] 2.1 Persist immutable evidence manifests in the existing artifact store.
- [ ] 2.2 Add versioned intent resolution with provenance, contradictions,
  confidence, and unresolved questions.
- [ ] 2.3 Add implementation audit states backed by OpenSpec, git, run,
  verification, and deployment refs.

Acceptance: rerunning analysis preserves the original manifest and creates a
new review revision; every candidate is traceable to user-authored evidence.

## 3. User Alignment Surface

- [ ] 3.1 Add gateway decision APIs with revision binding and idempotency.
- [ ] 3.2 Add a full-app Android review surface; keep only compact status and a
  handoff in the overlay.
- [ ] 3.3 Prove old or hidden candidate sets cannot be bulk-approved.

Acceptance: candidates can be approved, edited, deferred, or rejected without
launching work.

## 4. Approved Intent Materialization

- [ ] 4.1 Convert only approved candidates into narrow OpenSpec tasks with one
  observable acceptance check each.
- [ ] 4.2 Queue implementation through existing worker proposal/claim/receipt
  contracts and link task/run evidence back to the review candidate.
- [ ] 4.3 Prove scans and reviews never edit code or deploy, and prove duplicate
  approval retries do not duplicate tasks or runs.

Acceptance: an approved candidate becomes a durable, reviewable ticket and a
worker proposal while normal verification, commit, preview, promotion, and
smoke gates remain intact.

## 5. Optional Audio-Note Transcription

- [ ] 5.1 Complete a separate consent, retention, language, cost, and deletion
  review.
- [ ] 5.2 If approved, create derived transcript artifacts without modifying
  raw audio notes or routing capture through the voice-agent path.
- [ ] 5.3 Report untranscribed and failed notes in scan completeness.

Acceptance: audio-note inclusion is explicit, attributable, retryable, and does
not change record mode's storage-only capture contract.
