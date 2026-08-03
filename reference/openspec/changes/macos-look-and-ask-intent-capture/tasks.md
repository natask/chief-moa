# Tasks

No source implementation, architecture edit, commit, packaging, or deployment
is authorized by this change. The tasks below define the smallest coherent
future implementation units and their observable acceptance checks.

## 1. Contract Alignment

- [ ] 1.1 Confirm the Look & Ask source binding and transcript-only fallback
      when no stable focused window exists.
- [ ] 1.2 Confirm screenshot retention/delete behavior and the exact durable
      intent schema against the shared evidence and intent substrates.
- [ ] 1.3 Decide the user-visible entry point without changing the existing
      assistant-voice, Dictate, proactive-observation, or global-shortcut
      contracts implicitly.

Acceptance: the accepted design names one invocation path, one source-binding
identity, one retention policy, and one versioned non-executable intent schema.

## 2. Frontmost Source Binding

- [ ] 2.1 Capture the exact verified frontmost app/process generation and
      focused-window identity before the Ag panel takes focus.
- [ ] 2.2 Keep the existing transcript flow usable when Accessibility is
      denied, no stable source window exists, or context remains off.
- [ ] 2.3 Mark attachment stale on app/process/window change, lock/sleep,
      permission loss, or capture-generation replacement.

Acceptance: switching either the frontmost app or focused window after capture
blocks attached-context submission while preserving the transcript and offering
only Recapture or Remove context.

## 3. Explicit Evidence Attachment

- [ ] 3.1 Add a current-turn Attach context control that always starts off and
      resets after submit, cancel, dismissal, or replacement.
- [ ] 3.2 Capture one bounded/redacted AX snapshot only after the user enables
      attachment and Accessibility is available.
- [ ] 3.3 Add a separate off-by-default focused-window screenshot choice using
      Screen Recording only, with same-window pre/post validation and existing
      image bounds.

Acceptance: ordinary summons and transcript submissions perform no AX traversal
or pixel capture; enabling AX never captures pixels; Screen Recording denial
does not block transcript or allowed AX evidence.

## 4. Preview And Exact Release

- [ ] 4.1 Show the exact transcript, source binding, redacted AX evidence,
      redaction/truncation report, destination/retention statement, and optional
      bounded screenshot preview before submission.
- [ ] 4.2 Bind approval to immutable serialized bytes plus evidence digests and
      invalidate it after any transcript, evidence, source, screenshot,
      destination, retention, or serialization change.
- [ ] 4.3 Reject redirects and prove that dismissed, stale, or unapproved
      evidence causes no network release.

Acceptance: a loopback fixture proves released bytes and digests exactly match
the final approved preview, and changing the focused window after preview sends
nothing.

## 5. Durable Non-Executable Intent

- [ ] 5.1 Append `macos_look_and_ask_intent.v1` through the canonical durable
      intent/event substrate with stable idempotency, exact transcript, typed
      evidence refs, provenance, redaction/bounds, and retention metadata.
- [ ] 5.2 Return the same intent identity on retry and expose partial failure
      without duplicating the intent or evidence records.
- [ ] 5.3 Prove submission creates no action proposal, task, queued/executing
      run, repository change, deployment request, release switch, promotion, or
      completion record.

Acceptance: submitting the same approved envelope twice yields one durable
captured intent with inspectable transcript/evidence provenance and zero
executable or release lifecycle records.

## 6. Verification And Later Rollout

- [ ] 6.1 Add pure fixtures for permission separation, AX/image bounds,
      redaction, app/window freshness, exact preview binding, and idempotent
      non-executable admission.
- [ ] 6.2 Run isolated-account TCC QA against the exact candidate without
      changing the user's live Accessibility or Screen Recording grants.
- [ ] 6.3 Update `ARCHITECTURE.md` only with the architecture-significant
      behavior actually implemented.
- [ ] 6.4 Package/promote only under the existing Mac signing, notarization,
      rollback, preview, compatibility, no-interruption, and smoke gates.

Acceptance: verification distinguishes specification, implementation, QA
artifact, signed release, installation, and promoted smoke; no earlier state is
reported as a later one.
