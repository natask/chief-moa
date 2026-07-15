# Tasks

Every implementation unit has one observable acceptance check. This proposal is
not authorized for implementation until product/architecture alignment.

## 0. Reconcile Current State

- [ ] 0.1 Build a claims ledger for raw audio notes, streaming transcription,
  language handling, voice-first gestures, Android history, and agent dispatch;
  mark each `verified`, `implemented-unverified`, `specified`, or `missing`.
- [ ] 0.2 Reconcile stale task checkboxes whose implementation is already in
  source and link exact verification evidence instead of reimplementing them.
- [ ] 0.3 Isolate or resolve the current unrelated dirty browser documentation
  before any capture implementation commit.
- Acceptance: one page names the real first missing behavior and no shipped
  behavior is represented as a new implementation ticket.

## 1. Gateway Capture Block

- [ ] 1.1 Define bounded capture-block, transcript-revision, processing-event,
  retention, and dispatch schemas.
- [ ] 1.2 Create a block idempotently from a stored audio note without invoking
  STT in the audio upload transaction.
- [ ] 1.3 Add async transcription claim/result/failure/retry behavior using the
  existing provider registry and explicit input-language profile.
- [ ] 1.4 Add token-protected create/list/detail/retry/revision/delete-or-tombstone
  routes and product events.
- [ ] 1.5 Add deterministic smoke coverage for byte retention, successful STT,
  provider failure, retry, duplicate requests, and deletion policy.
- Acceptance: stored audio survives a forced STT failure and the same block later
  reaches `transcribed` through an idempotent retry.
- Verification: `cd gateway && npm run check` plus the focused capture smoke.

## 2. Android Capture And Notebook

- [ ] 2.1 Replace the record-mode receipt-only result with a capture-block state
  client while retaining local failed-upload bytes.
- [ ] 2.2 Add a compact overlay capture tray for consecutive independent blocks.
- [ ] 2.3 Add notebook list/detail UI with replay, literal transcript, edit,
  copy/share, retry, retention/delete, and revision provenance.
- [ ] 2.4 Add a reversible bottom-center drag-to-hide target for the orb.
- [ ] 2.5 Add unit coverage for capture state and drag-to-hide decisions.
- Acceptance: three hold/release gestures create three separately copyable
  blocks and dragging to Hide removes only the orb surface.
- Verification: Android unit tests, `assembleDebug`, and physical-phone QA.

## 3. Writing Skill Candidates

- [ ] 3.1 Define versioned named writing-skill profiles and bounded rewrite
  requests over a selected block revision.
- [ ] 3.2 Store every result as a derived revision with parent, skill version,
  and model evidence; never mutate the literal transcript.
- [ ] 3.3 Add overlay/notebook selection between literal, user-edited, and named
  skill candidates.
- Acceptance: applying and undoing a writing skill leaves the literal transcript
  byte-for-byte unchanged.
- Verification: gateway smoke plus Android state tests and phone QA.

## 4. Android Voice-First IME

- [ ] 4.1 Add an `InputMethodService`, manifest declaration, metadata, settings
  entry, and keyboard-switch affordance.
- [ ] 4.2 Add a fail-closed sensitive-editor classifier and prove no record,
  upload, cache, prior-candidate display, or rewrite occurs in password fields.
- [ ] 4.3 Reuse capture-block creation for voice input and bind returned candidates
  to the active editor session.
- [ ] 4.4 Commit selected text through `InputConnection.commitText(...)`; handle
  cancel, focus change, punctuation, delete, enter/action, and offline states.
- [ ] 4.5 Add English, Amharic, and mixed-language selection using explicit
  gateway language state without silent global profile mutation.
- Acceptance: voice text inserts into two ordinary apps, refuses a password
  field, and never types through accessibility.
- Verification: Android unit/build checks and physical-phone IME QA.

## 5. Explicit Agent Dispatch

- [ ] 5.1 Add `dispatch` actions from one or more selected capture revisions to
  existing async agent-run creation.
- [ ] 5.2 Require explicit single-agent or multi-agent routing selection and show
  the resulting run IDs, statuses, and dispatch receipts.
- [ ] 5.3 Prove repeated capture alone starts zero agent runs.
- Acceptance: three blocks can be captured without runs, then one selected block
  can launch a visible async run through an explicit action.
- Verification: gateway agent-run smoke plus Android phone QA.

## 6. Finish And Promotion

- [ ] 6.1 Update accepted OpenSpec capability specs and `ARCHITECTURE.md` only
  when the first architecture-significant implementation lands.
- [ ] 6.2 Run narrow verification per gateway and Android unit, then commit each
  coherent unit with Conventional Commits.
- [ ] 6.3 Create isolated gateway preview state and an Android OTA artifact.
- [ ] 6.4 Prove rollback, old/new state compatibility, no interrupted recordings
  or transcription jobs, and gateway backup/restore.
- [ ] 6.5 Promote only after the active-promotion gate passes; otherwise record
  the exact preview/artifact and blocker.

## Later Changes

- [ ] Design and validate a complete Amharic character keyboard and transliteration
  model as its own product change.
- [ ] Define drill consent, corpus, rubric, evaluation, and deletion behavior.
- [ ] Define video capture and media-specific gestures after the basic gesture
  contract is proven discoverable and reliable.
- [ ] Evaluate monetization outside sensitive keyboard/capture surfaces through a
  separate privacy and business-model decision.
