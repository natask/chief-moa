# Separate implementation tickets

Each ticket is one independently committed candidate. An agent may touch only
the named paths plus this change's evidence note. Shared integration files are
reserved for a later integration ticket.

## 0. Claims ledger and authorization

- [x] 0.1 Record the user-approved Wispr-replacement outcome, current candidate
      commits, authority split, and forward 90% gate in this change.
- Acceptance: each requested outcome below has its own ticket, acceptance check,
  and verification.
- Verification: `openspec validate cross-surface-screen-aware-dictation --strict`.

## 1. Android screenshot authority adapter

- [ ] 1.1 Add an explicit-consent, secure-content-suppressing, size-bounded
      screenshot adapter; do not add networking.
- Allowed paths: new Android screenshot/redaction classes, accessibility service
  adapter/config, and focused JVM tests.
- Depends on: ticket 0.
- Acceptance: one user-invoked capture from the selected app yields a bounded
  image bound to package/time/digest; disabled, secure, denied, or stale capture
  yields no bytes.
- Verification: Android unit tests, 90% gate for new pure logic, `assembleDebug`,
  and physical-phone allowed/denied/secure QA.

## 2. Gateway multimodal screen evidence

- [ ] 2.1 Generalize the existing browser-vision candidate into a bounded,
      surface-neutral screen-evidence validator and provider attachment.
- Allowed paths: new gateway screen-evidence modules/tests/coverage script; no
  capture-block code and no deployment.
- Depends on: ticket 0; reuse `acc53b20`, `ef6783e6` where compatible.
- Acceptance: a valid JPEG plus semantic summary reaches an OpenAI/Vertex model
  request as untrusted evidence, invalid media is rejected, and raw bytes are
  absent from durable turn state.
- Verification: focused tests and >=90% line/branch/function coverage.

## 3. Android screen-aware turn integration

- [ ] 3.1 Attach ticket 1 evidence through ticket 2 only on a visible Ask turn;
      keep model output inert.
- Allowed paths: Android gateway client/action broker/overlay integration and
  focused tests; gateway route glue only in the integration commit.
- Depends on: tickets 1 and 2.
- Acceptance: current evidence is attached once; app/focus/freshness changes
  invalidate it and no proposed action executes without local validation.
- Verification: Android tests/build, gateway smoke, physical-phone stale-state QA.
- Candidate status: deterministic Android glue is implemented in
  `android-screen-dictation-integration-evidence.md`; physical-phone stale,
  secure, and denial QA remains not measured, so this ticket stays open.
  Callback-time release regressions cover secure/password no-context fallback,
  missing accessibility authority, stale state, and package mismatch. The
  integration-sequence test also proves a failed gate cannot be undone by a
  later screenshot attachment step.

## 4. Android IME literal dictation

- [ ] 4.1 Add an opt-in `InputMethodService`, sensitive-editor classifier,
      editor-session binding, and `InputConnection.commitText` insertion.
- Allowed paths: new Android IME/pure policy classes, manifest/metadata/settings,
  and focused tests; no accessibility typing and no action expansion.
- Depends on: gateway ticket 9b for production transcription; a local candidate
  may prove editor safety first.
- Acceptance: exact text inserts without submit in two ordinary apps, while
  password, stale focus, or changed editor causes zero record/upload/display or
  insertion.
- Verification: >=90% pure-policy coverage, unit/build checks, physical IME QA.
- Candidate status: the fixed QA text has been replaced by an Android
  SpeechRecognizer literal-transcript MVP. It deliberately has no durable raw
  audio; physical insertion, language, sensitive-editor, and stale-focus QA
  remains not measured, so this ticket stays open.

## 5. Android screen-aware action proposals

- [ ] 5.1 Expand only bounded semantic click/focus/insert proposals with fresh
      state binding, explicit approval classes, and local receipts.
- Allowed paths: Android action policy/executor/receipt modules and tests.
- Depends on: tickets 3 and 4.
- Acceptance: “write an email based on what you see” produces a reviewable
  candidate; insert/click/send are distinct locally approved effects and stale
  state produces a refusal receipt.
- Verification: 100% trust-invariant cases, Android tests/build, phone QA.
- Candidate status: the local IME insertion authority is implemented and binds
  exact visible text to package/fingerprint, explicit Insert approval, final
  target revalidation, one consumed `commitText`, and a local receipt. Send is
  independently refused and no Accessibility typing/click/submit was added.
  Gateway proposal ingress and physical-phone ordinary/password/stale QA remain
  not measured, so this ticket stays open.

## 6. macOS typed command integration and QA install

- [ ] 6.1 Rebase/cherry-pick `86fdd7b7`, `f55438d7`, `c57e2040` onto the current
      target, resolve drift, and produce a clean versioned QA ZIP/checksum.
- [ ] 6.2 In a separate operations step, install that exact artifact only when
      no existing bundle/TCC identity is displaced; record hash and rollback.
- Allowed paths: macOS typed companion, package/scan/CI, its OpenSpec/evidence;
  do not incorporate the dirty local-program worktree.
- Depends on: ticket 0.
- Acceptance: the exact installed QA bundle launches as a menu-bar app and a
  hotkey typed turn reaches the configured gateway; otherwise record signing or
  TCC blocker and artifact path.
- Verification: `swift test`, `swift build --product MoaMac`, package, scan,
  install/launch/TCC smoke, uninstall rollback.

## 7. macOS notch shell

- [ ] 7.1 Anchor the compact surface below a supported display notch and define
      deterministic centered/menu-bar fallback for non-notched/external screens.
- Allowed paths: macOS panel/layout policy and tests only.
- Depends on: ticket 6.1.
- Acceptance: layout tests and visual QA show no menu-bar/system-UI occlusion on
  notched and fallback displays.
- Verification: >=90% layout-policy coverage, Swift checks, screenshot QA.

## 8. macOS microphone transcription

- [ ] 8.1 Add explicit microphone permission, push-to-talk audio transport to
      the gateway, and visible partial/final literal transcript; no AX mutation.
- Allowed paths: macOS audio/voice client, permission metadata, transcript UI,
  and focused tests.
- Depends on: ticket 6.1 and gateway ticket 9b.
- Acceptance: fixture and protected spoken phrase yield the exact visible final
  transcript; denial and interruption are visible and mutate no other app.
- Verification: >=90% core parser/state coverage, Swift checks, mic/TCC QA.

## 9. macOS cursor insertion

- [ ] 9.1 Bind and revalidate the prior focused editable AX element, preview the
      exact candidate, and form fsync-backed pending/terminal receipts.
- Allowed paths: macOS insertion policy/AX adapter/journal and tests; reconcile
  `5a3bb444` only after its dirty worktree is resolved.
- Depends on: ticket 8.
- Acceptance: exact transcript inserts into a test field after confirmation;
  secure, stale, wrong-app, or non-settable targets receive zero mutation.
- Verification: 100% trust cases, >=90% core coverage, isolated AX/TCC QA.

## 10. macOS screen-aware actions

- [ ] 10.1 Connect the separately granted focused-window evidence flow to Ask
      and bounded local proposals without widening screenshot authority.
- Allowed paths: macOS coordinator/action integration and focused tests.
- Depends on: tickets 2, 6, and 9.
- Acceptance: a screen-based draft is inert until local approval; Stop or grant
  expiry cancels queued work and records a terminal receipt.
- Verification: Swift checks and isolated Screen Recording/AX/TCC QA.

## 11. Browser focused-field dictation parity

- [ ] 11.1 Add/reconcile literal transcription insertion into a locally bound
      editable target without submit or implicit browser action.
- Allowed paths: extension dictation controller, insertion receipt runtime,
  manifest version, and focused tests.
- Depends on: gateway ticket 9b; reuse existing voice and CDP contracts.
- Acceptance: literal text inserts once into the current editor; password,
  stale tab/frame/element, or focus change causes zero insertion.
- Verification: >=90% controller coverage, `npm run verify`, `npm run smoke`,
  real-browser QA, package/reload verification.

## 12. Gateway contracts (three candidates)

- [ ] 12.1 Screen evidence: implement ticket 2 without capture persistence.
- [ ] 12.2 Capture block: store audio before async STT; expose idempotent
      create/detail/retry/revision/tombstone; keep literal transcript immutable.
- [ ] 12.3 Delivery intent: add explicit `literal_text` vs
      `assistant_response`; literal bypasses model, tools, memory, TTS, and
      agent dispatch and returns only a candidate.
- Allowed paths: one new gateway module/test/coverage unit per sub-ticket;
  shared route glue only after all candidate contracts are verified.
- Dependencies: 12.1 depends on ticket 0; 12.2 is independent; 12.3 depends on
  12.2. Surface insertion remains out of scope.
- Acceptance 12.2: forced STT failure preserves playable audio and idempotent
  retry reaches `transcribed`; capture alone starts zero runs.
- Acceptance 12.3: literal mode invokes zero model/tool/memory/TTS/run hooks;
  assistant mode preserves current routing and may consume approved evidence.
- Verification: focused smoke plus >=90% line/branch/function coverage for each
  new module and `npm run check` at integration.

## 13. Independent verification and operations

- [ ] 13.1 Bind exact commits/artifact digests/config to deterministic coverage,
      Android phone, Chrome, installed Mac, English/Amharic/mixed, interruption,
      sensitive-field, stale-target, memory, and rollback evidence.
- [ ] 13.2 Create isolated previews/artifacts, prove compatibility,
      no-interruption, backup/restore for persisted audio/transcripts, and known
      rollback before promotion.
- [ ] 13.3 Promote only the tested identity through existing release paths and
      smoke the active target; production master moves only through
      `scripts/release/push-master.sh`.
- Allowed paths: verification evidence and existing release commands; this lane
  does not repair product code.
- Depends on: each candidate independently, then a clean prospective integration.
- Acceptance: every required cell is passed for the same promoted candidate or
  remains explicitly failed/blocked/not-measured/stale; no generic skipped state.
- Verification: OpenSpec strict validation, surface commands from `AGENTS.md`,
  real-surface receipts, preview/safety-gate/promotion/post-smoke records.
