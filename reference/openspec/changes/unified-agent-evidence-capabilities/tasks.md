# Unified Agent Evidence Capabilities Tasks

Each implementation unit has one observable acceptance check. Gateway, browser,
Android/workflow, and independent verification remain separate ownership lanes.

## 1. Contract Reconciliation (workflow/docs lane, serial first)

- [x] 1.1 Define `moa.reasoning-turn.v2`, `evidence_asset.v1`,
      `moa.video-evidence-request.v1`, and `moa.browser-program.v2`.
- [x] 1.2 Reconcile generated program authority as
      `reviewed_standalone_v1` and `delegated_runtime_v1`.
- [x] 1.3 Record route-uniform search, initial-turn multimodal evidence, video
      continuation, receipts/retention, ownership, and the rollout DAG in
      OpenSpec and `ARCHITECTURE.md`.
  - Acceptance: strict OpenSpec validation passes, and no active reconciled
    document makes the two execution profiles look like one universal policy.

## 2. Route-Uniform Search (gateway lane)

- [ ] 2.1 Centralize answer-capability assembly across Android chat, browser
      turns/evidence, browser HTTP voice, cascaded voice, broker direct-answer
      and research, and resumed image/video turns.
- [ ] 2.2 Prefer native search, otherwise expose the bounded gateway search
      function, otherwise expose explicit unavailable state.
- [ ] 2.3 Normalize used source URLs and bounded invocation metadata into the
      turn record without retaining unrestricted search bodies.
  - Acceptance: a provider/route matrix proves every ordinary route gets
    `native`, `gateway_function`, or `unavailable`, while context preflight,
    transcription, TTS, and proactive calls get no search.
  - Verification: gateway check, focused tool-loop tests, health assertion, and
    a token-authenticated current-fact smoke with normalized sources.

## 3. Initial Browser Multimodal Turn (browser + gateway lanes, serial merge)

- [ ] 3.1 Send the already-collected bounded page observation and optional JPEG
      in the initial browser turn.
- [ ] 3.2 Validate media/grant/digest/freshness and map the asset to supported
      provider-native image input; record honest text-only degradation.
- [ ] 3.3 Keep raw pixels request-only by default and retain only bounded audit
      metadata unless the user selected retention.
  - Acceptance: one “explain this page” call returns completed, makes zero
    evidence follow-up calls, and the provider fixture sees page text plus one
    bounded JPEG; failed/oversized capture degrades to text-only.

## 4. Evidence Reference Resolution And Android Alignment

- [ ] 4.1 Resolve authorized broker evidence references into model/harness
      evidence rather than passing opaque IDs.
- [ ] 4.2 Encode existing Android semantic accessibility summaries in the
      shared evidence envelope without claiming pixel capture.
  - Acceptance: a broker fixture sees resolved bounded evidence, unauthorized
    or expired refs are omitted with reasons, and Android exposes no screenshot
    asset without a separate visible capture grant.

## 5. Video Continuation (browser + gateway lanes)

- [ ] 5.1 Fix recorder shutdown so manual/sub-second stop includes the terminal
      `MediaRecorder` chunk before clearing active capture.
- [ ] 5.2 Add the zero-authority video evidence request and extension-owned
      trusted Start/indicator/stop/delete flow.
- [ ] 5.3 Attach the video idempotently and resume the originating reasoning
      turn with its original query, role, branch, envelope, and capabilities.
- [ ] 5.4 Add explicit provider video support checks and disclosed derivation;
      never silently substitute frames/transcript for actual video.
  - Acceptance: model output alone opens no picker and captures/uploads nothing;
    trusted Start plus stop sends the terminal chunk, attaches the actual video,
    and resumes the original turn with search and browser capabilities intact.

## 6. userScripts Onboarding And Reviewed Runtime (browser lane)

- [ ] 6.1 Add a separate default-off userScripts capability probe/onboarding
      state with zero registrations before explicit enablement.
- [ ] 6.2 Implement immutable program artifact validation, exact host grants,
      `USER_SCRIPT` register/update/unregister/read-back, local receipts, and
      verified removal for `reviewed_standalone_v1`.
  - Acceptance: an isolated profile proves disabled/available/toggle-revoked
    states, direct approval for each changed revision, exact registration
    read-back, rollback/removal, and no `MAIN` or CDP path.

## 7. Delegated Runtime (gateway + browser lanes, after Section 6)

- [ ] 7.1 Extend the confirmed browser delegation envelope with explicit
      `script.evaluate`/`script.persist` program classes.
- [ ] 7.2 Implement independent visible grants for arbitrary code, site/frame
      scope, `MAIN`, bridge capabilities, and CDP `Runtime.evaluate`.
- [ ] 7.3 Require immutable hash-bound revisions, local pre-execution
      revalidation, receipts, checkpoints, stop, and removal/rollback.
  - Acceptance: an in-envelope revision needs no redundant confirmation, but
    any scope/world/bridge widening, origin/document change, checkpoint,
    destructive effect, stale evidence, or expired envelope pauses before the
    effect; `MAIN` and CDP never activate as silent fallbacks.

## 8. Add / Remove / Draw Behavior Proof (browser QA lane)

- [ ] 8.1 Prove packaged anchor-bound Explain annotation with no arbitrary-code
      authority.
- [ ] 8.2 Prove Collaborate-confirmed insertion/removal and
      Delegate-preauthorized persistent hide.
- [ ] 8.3 Prove a generated drawn overlay in `USER_SCRIPT`, separately granted
      `MAIN`, and separately authorized CDP execution.
- [ ] 8.4 Prove destructive application deletion cannot masquerade as a visual
      modification and that stop remains reachable outside the page.
  - Acceptance: every attempt binds profile, source hash, exact grants,
    before/after evidence, result, and cleanup/removal to a local receipt.

## 9. Independent Verification And Release (verification/deploy lane, serial last)

- [ ] 9.1 Independently run strict OpenSpec validation, gateway checks, extension
      verify/smoke, focused contract tests, and dedicated-profile browser QA.
- [ ] 9.2 Audit secrets, capture authority, provider disclosure, program risk
      classification, receipts, retention/deletion, stop, and recovery.
- [ ] 9.3 Package and promote only after preview smoke, rollback,
      no-interruption, state compatibility, and required backup/restore evidence
      pass; otherwise record the artifact and exact blocker.
