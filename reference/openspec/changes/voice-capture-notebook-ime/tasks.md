# Tasks

Every implementation unit has one observable acceptance check. The user made
literal dictation the first cross-surface product milestone on 2026-08-02.
Sections 0, 1, 2, 4, 4A, and 6 are authorized in the staged order below;
writing-skill and agent-dispatch expansion in sections 3 and 5 remains deferred.
Existing trust, retention, preview, and promotion gates still apply.

## Dictation-First Lane Order

1. **Gateway:** finish the stored-audio-first capture lifecycle and keep the
   transcription-only path free of reasoning, TTS, tools, and agent dispatch.
2. **Browser voice:** finish loaded-extension clipboard and cross-tab QA against
   the exact promoted gateway candidate.
3. **Android action/accessibility:** add the real IME insertion path; keep the
   launcher clipboard fallback, and never use Accessibility for IME typing.
   Keep draft Cancel on the left and Pause/Resume on the right so controls do
   not cover the user or assistant transcript lanes.
4. **Native desktop:** restore an explicit literal-dictation activity without
   stealing or weakening assistant voice. Implement platform-owned clipboard or
   insertion per supported native Surface.
5. **Workflow/docs:** keep this change and `CORE_PRODUCT_INTENT.md` as the
   dictation authority; record exact candidate and device evidence here.
6. **Verification/deploy:** verify each Surface independently, then run one
   exact-candidate cross-surface acceptance pass before promotion.

Browser action/CDP is deliberately outside this milestone. Dictation does not
gain page-action authority because it runs inside the browser extension.

## 0A. Authorized Ask/Note/Coach Gateway State

- [x] 0A.1 Persist a versioned device-scoped Ask/Note/Coach selection without
  adding delivery state to the durable base persona.
- [x] 0A.2 Expose authenticated read/change/history mode routes with the routing
  decision needed before clients open provider work.
- [x] 0A.3 Fail closed before model work for Note and apply Coach as a bounded
  turn-local overlay that disappears after reverting to Ask.
- [x] 0A.4 Add deterministic unit and gateway smoke coverage for the truth table,
  persistence, provider denial, persona preservation, and reversion.
- Acceptance: Note produces zero model requests, Coach preserves the saved base
  persona while changing the turn policy, and Ask restores normal policy.
- Rejected: Android/browser mode selectors.
- Deferred: conversational mode switching, client admission preflight and
  capture mechanics, capture blocks and notebook, video routing, and deployment.

## 0B. Authorized Browser Dictation Slice

- [x] 0B.1 Let a browser voice session request literal transcription only, with
  no reasoning or TTS stage.
- [x] 0B.2 Route the browser-owned global invocation bridge to start/finish
  dictation and copy the final transcript to the clipboard. Superseded for the
  OS-wide summon by the native Mac assistant; browser dictation remains
  explicitly invocable inside the browser Surface.
- [x] 0B.4 Make long-form streaming transcript assembly idempotent for repeated
  provider result identities and reconcile meaningful rotation/reconnect
  overlap without deleting short deliberate repetition. Verify sanitized
  English and Amharic fixtures through the gateway final-turn path.
- [x] 0B.3 Preserve explicit configured input-language evidence and the canonical
  retained voice turn while keeping agent dispatch out of this path.
- [x] 0B.4 Make the extension worker authoritative for the one active dictation
  session so an invocation from another tab commits that session, late tabs
  hydrate passive state, and tab activation cannot start a competing recorder.
- [x] 0B.5 Keep a one-click Copy control on the completed dictation card so the
  exact final transcript can be copied again after the automatic clipboard
  attempt, with a visible clipboard-replaced or retryable-failure receipt.
- [x] 0B.6 Reject a dominant unexpected-script final hypothesis at one common
  streaming/batch boundary, retry once from retained PCM using the configured
  input-language evidence, and fail visibly without reasoning, final hooks,
  fallback resurrection, or canonical history when the retry is still invalid.
- Acceptance: an explicit browser dictation invocation starts capture, a second
  invocation commits it, the final English/Amharic transcript is paste-ready,
  and the gateway performs
  zero reasoning and TTS calls for the turn. The completed card keeps a Copy
  control bound to that exact final transcript. Starting in one tab and
  finishing from another still produces one canonical turn.
- Verification: gateway Chirp smoke, browser verify/smoke, and manual loaded-
  extension clipboard QA.
- Acceptance status: source implementation, automated browser verification, and
  real headless-Chrome smoke pass in the current candidate. Loaded-extension
  cross-tab macOS clipboard QA is still required before promotion.

## 0C. Authorized Literal Capture Projection Slice

- [x] 0C.1 Project each completed transcription-only voice turn into one
  deterministic, queryable capture block after canonical turn storage.
- [x] 0C.2 Preserve the bounded literal transcript, completeness metadata,
  language/provider provenance, source surface, and retained audio reference.
- [x] 0C.3 Append one idempotent `file_only` / `unclassified` routing proposal
  with `executable: false` and `model_used: false`.
- [x] 0C.4 Reconcile completed dictation turns at startup without delaying the
  terminal event or clipboard path.
- [x] 0C.5 Add authenticated list, search, and detail reads plus deterministic
  domain and handler tests.
- Acceptance: a successful browser dictation remains immediately paste-ready,
  becomes a durable literal capture, and creates no reasoning request, TTS
  request, agent run, executable action, or inferred intent.
- Acceptance status: the bounded candidate implementation and full gateway
  verification pass. Preview/state-compatibility evidence and production
  promotion have not yet been recorded. This slice does not satisfy
  the full audio-note-first lifecycle in section 1.

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

- Scope note: section 0C is only an additive projection from already-completed
  browser dictation turns. The tasks below remain open for stored-audio-first
  create, asynchronous STT lifecycle, retry, revision, retention, and deletion.
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
- [x] 2.4 Add a reversible bottom-center drag-to-hide target for the orb.
      (Done in `overlay-companion-ribbons`: the armed zone is now the painted
      200x72dp target plus 12dp, and a drop is undoable for 5s.)
- [ ] 2.5 Add unit coverage for capture state and drag-to-hide decisions.
      (Drag-to-hide half done: `MoaOrbRemovalUndoTest` and the bounded-target
      cases in `MoaOrbOverlayGeometryTest`. Capture state still open.)
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

- [x] 4.1 Add an `InputMethodService`, manifest declaration, metadata, settings
  entry, and keyboard-switch affordance.
- [x] 4.2 Add a fail-closed sensitive-editor classifier and prove no record,
  upload, cache, prior-candidate display, or rewrite occurs in password fields.
- [x] 4.3 Reuse capture-block creation for voice input and bind returned candidates
  to the active editor session.
- [x] 4.4 Commit selected text through `InputConnection.commitText(...)`; handle
  cancel, focus change, punctuation, delete, enter/action, and offline states.
- [ ] 4.5 Add English, Amharic, and mixed-language selection using explicit
  gateway language state without silent global profile mutation.
- Acceptance: voice text inserts into two ordinary apps, refuses a password
  field, and never types through accessibility.
- Verification: Android unit/build checks and physical-phone IME QA.
- Acceptance status: source, focused policy tests, lint, unit tests, and debug
  assembly pass in the current candidate. Two-app insertion, password refusal,
  and English/Amharic/mixed physical-phone QA remain required before the slice
  is accepted or published.

## 4A. Native Desktop Literal Dictation

- [x] 4A.1 Add an explicit literal-dictation activity to the native Mac shell;
  do not replace or overload the assistant voice activity.
- [x] 4A.2 Finalize through the transcription-only gateway contract and expose
  the exact final transcript with a platform-owned Copy action.
- [x] 4A.3 Keep native capture visibility, cancel, failure, and clipboard
  receipts distinct from assistant reply state.
- [ ] 4A.4 Mark Windows dictation `missing` until the native Windows shell can
  capture and complete the same contract; the portable authority scaffold is
  not product acceptance.
- Acceptance: native Mac assistant voice and literal dictation can each be
  invoked deliberately, and a dictation turn creates no assistant/model work.
- Verification: Swift tests/build plus real-Mac microphone and clipboard QA.
- Acceptance status: source and Swift tests pass in the current candidate.
  Real-Mac microphone/clipboard QA and a signed/notarized public distribution
  path remain required before native Mac dictation is accepted as shipped.

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

- [x] 6.1 Update accepted OpenSpec capability specs and `ARCHITECTURE.md` only
  when the first architecture-significant implementation lands.
- [ ] 6.2 Run narrow verification per gateway and Android unit, then commit each
  coherent unit with Conventional Commits.
- [ ] 6.3 Create isolated gateway preview state and an Android OTA artifact.
- [ ] 6.4 Prove rollback, old/new state compatibility, no interrupted recordings
  or transcription jobs, and gateway backup/restore.
- [ ] 6.5 Promote only after the active-promotion gate passes; otherwise record
  the exact preview/artifact and blocker.

## Later Changes

- [ ] Replace hidden multi-tap mode selection with visible Speak, Dictate, and
  Type activities per `explicit-activity-interface-direction-20260723.md`.
- [ ] Make Android orb and browser mascot drag orthogonal to active capture:
  movement preserves the capture identity and release leaves it latched until
  explicit Stop/Send or Cancel.
- [ ] Add separate Mute and Interrupt controls and preserve unrelated detached
  agent runs.
- [ ] Replace the five-minute in-memory product limit with durable bounded
  chunks, an immediate timestamped history row, and explicit replay/retry state.
- [ ] Add visible file/video Attach paths.
- [ ] Design and validate a complete Amharic character keyboard and transliteration
  model as its own product change.
- [ ] Define drill consent, corpus, rubric, evaluation, and deletion behavior.
- [ ] Define video capture and media-specific gestures after the basic gesture
  contract is proven discoverable and reliable.
- [ ] Evaluate monetization outside sensitive keyboard/capture surfaces through a
  separate privacy and business-model decision.
