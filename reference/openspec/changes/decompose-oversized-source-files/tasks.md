# Tasks

## 1. Establish Guardrails

- [x] 1.1 Inventory tracked production source files above 2,000 lines.
- [x] 1.2 Add a repository source-size policy with explicit debt ceilings.
- [x] 1.3 Run the policy from the gateway test suite.
- [x] 1.4 Critique the 10,000-line/2x-test proposal, retain both as ultimate
      constraints, and add a 60,000-line first milestone to prevent destructive
      metric chasing.
- [x] 1.5 Add a production-only 90% lines/branches/functions gate for the first
      extracted slice.
- [ ] 1.6 Extend the production-only coverage gate to every changed surface.
- [ ] 1.7 Classify every owned source file exactly once as executable, UI,
      operational tooling, migration/schema, generated/vendor, test, or fixture.
- [ ] 1.8 Add per-surface PR coverage reporting and changed-line ratchets.
- [x] 1.9 Record audited per-surface baselines, exact scope rules, staged
      implementation tickets, and non-vacuous acceptance checks in
      `coverage-program.md`.

## 2. Gateway Decomposition

- [x] 2.1 Extract and unit-test browser-evidence normalization.
- [x] 2.2 Extract browser-turn lifecycle and persistence with a focused 90%
      line/branch/function coverage gate; reduce `server.js` to 15,529 lines.
- [x] 2.3a Extract deterministic broker routing with a focused 90%
      line/branch/function coverage gate.
- [x] 2.3b Extract broker context-pack and launch handlers with a focused 90%
      line/branch/function coverage gate; reduce `server.js` to 14,983 lines.
- [x] 2.3c Extract work-history handlers with a focused 90% line/branch/function
      coverage gate; reduce `server.js` to 16,061 lines.
- [x] 2.4a Extract pet agent/bookmark collection handlers with a focused 90%
      line/branch/function coverage gate; reduce `server.js` to 15,939 lines.
- [x] 2.4b Extract the remaining companion, pet, and profile handlers through
      the bounded 2.4b1-2.4b4 slices below.
- [x] 2.4b1 Extract pet shared-library, install, publish, and voice-clone
      handlers with a focused 90% line/branch/function coverage gate. Verified
      at 100% lines, 98.86% branches, and 90.91% functions; reduce `server.js`
      to 15,726 lines.
- [x] 2.4b2 Extract pet catalog, active-profile, create, preview, apply, and
      generation handlers with a focused 90% line/branch/function coverage
      gate. Verified at 100% lines, 91.84% branches, and 100% functions; reduce
      `server.js` to 15,576 lines.
- [x] 2.4b3 Extract companion catalog, create, preview, apply, and rollback
      handlers with a focused 90% line/branch/function coverage gate. Verified
      at 100% lines, 93.22% branches, and 100% functions; reduce `server.js` to
      15,437 lines.
- [x] 2.4b4 Extract profile read, update, history, version, rollback, and reset
      handlers with a focused 90% line/branch/function coverage gate. Verified
      at 100% lines, branches, and functions; reduce `server.js` to 15,300 lines.
- [ ] 2.5 Extract agent-run lifecycle, harnesses, and work graph handlers.
- [x] 2.5a Extract agent-run list, detail, event projection, active-state, and
      cancel response handlers with a focused 90% line/branch/function coverage
      gate. Verified at 100% for all three metrics; reduce `server.js` to 15,253
      lines.
- [x] 2.5b Extract worker registration, claim, heartbeat, event, result, and
      completion-hook handlers with a focused 90% line/branch/function coverage
      gate. Verified at 100% for all three metrics; reduce `server.js` to 15,121
      lines.
- [x] 2.5c Extract agent-run launch and follow-up handlers with a focused 90%
      line/branch/function coverage gate. Verified at 100% lines, 93.62%
      branches, and 100% functions; reduce `server.js` to 14,998 lines.
- [x] 2.5d Extract router activation launch, completion ping, result summary,
      and status projection handlers with a focused 90% line/branch/function
      coverage gate. Verified at 100% lines and branches and 91.67% functions;
      reduce `server.js` to 14,838 lines.
- [ ] 2.6 Split voice diagnosis, cascaded reasoning, and turn persistence.
- [ ] 2.7 Extract context, thread, and history assembly.
- [ ] 2.8 Extract device-client, browser-task, and tool-request stores.
- [ ] 2.9 Move provider adapters and HTTP routes behind bounded modules.
- [ ] 2.10 Reduce `server.js` below 2,000 lines and remove its debt exemption.
- [ ] 2.11 Split the durable voice-draft store into bounded state, persistence,
      authority, and recovery modules.
- [x] 2.12 Add exhaustive immutable-publish, rollout, rollback, file-adapter,
      SemVer, and hostile-input tests for the release registry with a focused
      90% line/branch/function coverage gate. Verified at 100% lines and
      functions and 94.88% branches.
- [x] 2.13 Add exhaustive envelope, provider-payload, executable-output,
      response-bound, and fallback tests for proactive browser turns with a
      focused 90% line/branch/function coverage gate. Verified at 100% for all
      three metrics.
- [x] 2.14 Add exhaustive worker registration, token authority, claim lease,
      heartbeat, event, cancellation, retry, and terminal-result tests with a
      focused 90% line/branch/function coverage gate. Verified at 100% lines,
      92.09% branches, and 98.55% functions.
- [x] 2.15 Add an exhaustive local, self-host, hosted, token, future-auth,
      trust-proxy, and invalid-mode policy matrix with a focused 90%
      line/branch/function coverage gate. Verified at 100% lines and functions
      and 96.77% branches.
- [x] 2.16 Add isolated file-fallback, fake-gbrain CLI, recall parsing,
      fail-soft process failure, and legacy-row tests for the Brain with a
      focused 90% line/branch/function coverage gate. Verified at 99.47% lines,
      95.86% branches, and 100% functions.
- [x] 2.17 Add an exhaustive identity, persona, preference, note, rejection,
      normalization, and bound matrix for deterministic memory matching; repair
      the promised `I'd like`/`I'd prefer` patterns and remove unreachable helper
      branches. Verified at 100% line/branch/function coverage.
- [x] 2.18 Add exhaustive transcript-sidecar status, delegation, stream
      ownership, finalization, merge, fallback, and error tests with a focused
      90% line/branch/function coverage gate. Verified at 100% lines and
      functions and 97.14% branches.
- [x] 2.19 Add exhaustive Exa tool construction, request validation, provider
      response, timeout, network-error, URL filtering, and metadata-bound tests
      with a focused 90% line/branch/function coverage gate. Verified at 100%
      lines and functions and 90.28% branches.
- [x] 2.20 Add exhaustive worker-runtime configuration, credential, claim
      safety, allowlist, retry, cancellation, stale-authority, workspace-lock,
      terminal-result, provider-error, and CLI-process tests with a focused 90%
      line/branch/function coverage gate. Verified at 100% lines, 91.36%
      branches, and 97.56% functions.
- [x] 2.21 Add exhaustive work-graph storage selection, graph mutation,
      validation, event, artifact, filter, bound, persistence, and corrupt-state
      recovery tests with a focused 90% line/branch/function coverage gate.
      Verified at 100% lines and functions and 92.22% branches.
- [x] 2.22 Add exhaustive PostgreSQL work-graph schema, transaction, rollback,
      CRUD, mutation, run-reference, filter, bound, and row-normalization tests
      with a deterministic scripted pool and focused 90% line/branch/function
      coverage gate. Verified at 98.67% lines, 93.44% branches, and 97.73%
      functions.
- [x] 2.23 Add exhaustive video-note storage, quota, metadata, corruption,
      stream, inline-part, raw-body, HTTP handler, deletion, and error-bound
      tests with a focused 90% line/branch/function coverage gate. Verified at
      100% lines, 93.24% branches, and 95.56% functions.
- [x] 2.24 Add exhaustive account-provider catalog, OAuth configuration,
      authorize, exchange, refresh, revoke, provider-error, and deterministic
      fixture-lifecycle tests with a focused 90% line/branch/function coverage
      gate. Verified at 100% lines and functions and 96.51% branches.
- [x] 2.25 Add exhaustive agent-profile normalization, global/device version,
      patch, reset, rollback, revert, spoken-guard, migration, persistence, and
      corrupt-state tests; make default normalization idempotent so an untouched
      profile is not falsely marked overridden. Verified with a focused gate at
      99.40% lines, 91.76% branches, and 100% functions.
- [x] 2.26 Add exhaustive account-connection creation, OAuth, secret-form,
      refresh, health-check, notification, persistence, reauthorization,
      disable, and disconnect tests; persist notification reasons so duplicate
      queued notifications coalesce correctly. Verified with a focused gate at
      99.30% lines, 92.96% branches, and 95.40% functions.
- [x] 2.27 Add exhaustive browser-agent action, observation, planner-context,
      tool-capture, persistence, lease, policy, fallback, terminal-state, and
      health-count tests; remove the unreachable max-step helper. Verified with
      a focused gate at 99.85% lines, 90.00% branches, and 100% functions.
- [x] 2.28 Add exhaustive companion catalog, manifest, voice binding, pet,
      agent, bookmark, clone-job, consent, publication, persistence, and legacy
      projection tests; make pet sprite normalization idempotent and repair
      inline manifest previews. Verified with a focused gate at 98.59% lines,
      90.15% branches, and 98.46% functions.
- [x] 2.29 Add exhaustive event-substrate normalization, JSON/PostgreSQL,
      idempotency, compare-and-append, filtering, transaction, stream-lock,
      stale-reaper, filesystem-boundary, and retry tests with a focused 90%
      line/branch/function gate. Verified at 97.56% lines, 90.27% branches, and
      98.06% functions. Stabilize nondeterministic child-process attribution by
      including the existing end-to-end smoke and deterministic open-file
      identity checks; four repeated expanded gates measured 90.29%-91.08%
      branches.
- [x] 2.30 Add exhaustive profile-option voice/persona alias, language code,
      native-script, list, mention-routing, rejected-field, model-option,
      payload, and language-control tests with a focused 90%
      line/branch/function gate. Verified at 99.28% lines, 93.33% branches, and
      100% functions.
- [x] 2.31 Add exhaustive research-workflow normalization, pass clamping,
      query-alias, search/model failure, alternate-output, source deduplication,
      output bounding, markdown, and metadata tests with a focused 90%
      line/branch/function gate. Verified at 100% lines, 97.73% branches, and
      100% functions.
- [x] 2.32 Add exhaustive preview-adapter provider-shape, inspection-identity,
      active-collision, polling-bound, timeout, sleep, abort, cleanup, and
      aggregate-failure tests with a focused 90% line/branch/function gate.
      Verified at 100% lines, 91.30% branches, and 100% functions.
- [x] 2.33 Add exhaustive audio-note format, metadata, reload, quota,
      corruption, request-stream, body-limit, product-event, malformed-ID,
      missing-audio, non-file, and byte-stream tests with a focused 90%
      line/branch/function gate. Verified at 100% lines, 90.44% branches, and
      97.56% functions.
- [x] 2.34 Add exhaustive voice-chunker option, punctuation, Latin-guard,
      hard-split, bracket-atomicity, force-break, style, tag, literal-bracket,
      code-fence, and dynamic-cap tests with a focused 90%
      line/branch/function gate. Verified at 97.08% lines, 91.82% branches, and
      97.22% functions.
- [x] 2.35 Add exhaustive voice-router forced-precedence, cancellation,
      classification, model-action normalization, malformed-JSON, environment,
      timeout, and heuristic-fallback tests with a focused 90%
      line/branch/function gate. Verified at 99.47% lines, 96.79% branches, and
      100% functions.
- [x] 2.36 Add exhaustive work-history task/run lifecycle, evidence, feedback,
      control, deployment request, claim, effect, receipt, projection, UI-route,
      validation, idempotency-collision, and rollout-guard tests; distinguish an
      already-receipted rollback from a never-applied request. Enforce a focused
      90% line/branch/function gate, verified at 99.80% lines, 91.27% branches,
      and 95.59% functions while retaining the 2,032-line source ceiling.
- [x] 2.37 Extract the authenticated self-extension collection, runtime, create,
      and apply routes from `server.js`; add exhaustive routing, authorization,
      provenance, approval, normalization, persistence, corruption-recovery,
      filtering, activation, and reload tests. Enforce focused 90%
      line/branch/function gates, verified at 100% lines, 96.74% branches, and
      100% functions for handlers and 98.37% lines, 90.68% branches, and 100%
      functions for the artifact store. Preserve every corrupt-state snapshot
      with collision-resistant archive names and reduce `server.js` to 14,654
      lines.
- [x] 2.38 Extract authenticated UI-spec read, replace, and reset routing from
      `server.js`; add exhaustive authorization, wrapper, error, persistence,
      corruption-fallback, clone, reset, component, control, coordinate, tone,
      action, sanitization, and collection-bound tests. Enforce focused 90%
      line/branch/function gates, verified at 100% for handlers and 99.68%
      lines, 93.75% branches, and 100% functions for the declarative store.
      Reduce `server.js` to 14,626 lines.
- [x] 2.39 Extract the fail-closed billing runtime authorize and usage routes
      from `server.js`; add exhaustive authorization, configuration, denial,
      receipt, immutable-price, budget, numeric-bound, approval-window,
      signature, signer, profile-effect, rollback-effect, idempotency, and
      persistence-recovery tests. Enforce focused 90% line/branch/function
      gates, verified at 100% lines, 95.24% branches, and 100% functions for
      handlers and 100% lines, 93.40% branches, and 100% functions for runtime
      authority. Reduce `server.js` to 14,613 lines.
- [x] 2.40 Extract authenticated work-graph node, event, artifact, item-read,
      and action routing from `server.js`; add exhaustive route, authorization,
      query-alias, filter-default, collection, creation, and exact path-remainder
      tests. Enforce a focused 90% line/branch/function gate, verified at 100%
      for all three metrics, while retaining the existing above-90% JSON and
      PostgreSQL store gates. Reduce `server.js` to 14,534 lines.
- [x] 2.41 Extract product-event and project routing plus the durable project
      store from `server.js`; add exhaustive authorization, status-fallback,
      query-alias, reserved-event, create/update, persistence, corrupt-state,
      normalization, bound, and project-brief prompt tests. Enforce focused 90%
      line/branch/function gates, verified at 100% lines, 96.30% branches, and
      100% functions for handlers and 100% for all three store metrics. Reduce
      `server.js` to 14,335 lines.
- [x] 2.42 Extract authenticated device-client and tool-request list,
      heartbeat, create, claim, and receipt routing from `server.js`; add
      exhaustive authorization, query-alias, validation, optional-registration,
      availability, target/claimant binding, result, receipt, and default-clock
      tests plus the end-to-end device-hub smoke. Enforce a focused 90%
      line/branch/function gate, verified at 100% lines, 98.86% branches, and
      100% functions. Reduce `server.js` to 14,179 lines.
- [x] 2.43 Extract authenticated legacy CDP and multi-step browser-agent task
      list, create, claim, item-read, step, finish, and receipt routing from
      `server.js`; add exhaustive authorization, query, validation, empty-queue,
      run-projection, receipt, planner-failure, typed-error, fallback, path, and
      default-clock tests plus both browser-task end-to-end smokes. Enforce a
      focused 90% line/branch/function gate, verified at 100% lines, 96.61%
      branches, and 100% functions. Reduce `server.js` to 13,893 lines.
- [x] 2.44 Extract authenticated browser role, turn creation, evidence
      completion, and lifecycle-status routing from `server.js`; add exhaustive
      authorization, input, modality, build-error, locator-alias, missing-turn,
      evidence-content, request-linkage, page-ref, deduplication, persistence,
      and default-clock tests plus browser routing, continuity, and agent-loop
      smokes. Enforce a focused 90% line/branch/function gate, verified at 100%
      lines, 95% branches, and 100% functions. Reduce `server.js` to 13,772 lines.
- [x] 2.45 Extract OAuth, gateway-secret-form, provider catalog, connection,
      notification, health, item-read, patch, refresh, reauthorization, disable,
      and disconnect routing from `server.js`; add exhaustive auth-class,
      redirect, callback, form/JSON, scope, query, path, action, typed-error,
      payload, and default tests plus encrypted credential and device-notification
      smokes. Enforce a focused 90% line/branch/function gate, verified at 100%
      lines, 97.14% branches, and 100% functions. Reduce `server.js` to 13,638
      lines.
- [x] 2.46 Extract Android OTA manifest, current and versioned APK, rollback,
      and health routing from `server.js`; add exhaustive authorization,
      manifest-absolutization, artifact-streaming, invalid-release, missing-file,
      rollback-outcome, warning, event, and health tests plus the existing OTA
      HTTP integration suite. Enforce a focused 90% line/branch/function gate,
      verified at 100% lines, 97.92% branches, and 100% functions. Reduce
      `server.js` to 13,468 lines.
- [x] 2.47 Extract presentation-evaluation authorization, transcript selection,
      evaluator invocation, model-failure mapping, and live/final parsing from
      `server.js`; add focused unrelated-route, auth, inline and stored turn,
      default-mode, no-transcript, provider-failure, real-evaluator, and existing
      deterministic presentation smoke coverage. Enforce a focused 90%
      line/branch/function gate, verified at 100% for all three metrics. Reduce
      `server.js` to 13,418 lines.
- [x] 2.48 Extract authenticated harness discovery and supervisor status
      projection from `server.js`; add focused unrelated-route, authorization,
      catalog, work-status count, active filtering, run sorting, runtime evidence,
      legacy-storage fallback, empty-field, default-clock, and hard-cap tests plus
      the existing supervisor lifecycle smoke. Enforce a focused 90%
      line/branch/function gate, verified at 100% for all three metrics. Reduce
      `server.js` to 13,341 lines.
- [x] 2.49 Extract authenticated conversation, session, thread, context, voice
      turn, chat turn, and history read routing from `server.js`; add focused
      route-recognition, authorization, alias, default, decoding, branch-metadata,
      pagination, legacy-record, collision, and normalization tests plus session
      history, thread lifecycle, and chat-turn integration smokes. Enforce a
      focused 90% line/branch/function gate, verified at 100% for all three
      metrics. Reduce `server.js` to 13,184 lines.
- [x] 2.50 Extract authenticated thread-switch mutation routing from `server.js`;
      add focused recognition, authorization, explicit continuation, alias,
      metadata-bound, default, new, fork-parent, fork-point, summary-seeding,
      existing-summary, incognito-isolation, receipt, and clock tests plus the
      existing cross-surface thread lifecycle smoke. Enforce a focused 90%
      line/branch/function gate, verified at 100% lines, 94.44% branches, and
      100% functions. Reduce `server.js` to 13,111 lines.
- [x] 2.51 Extract authenticated broker-message, research, report persistence,
      report read, model-pass fallback, and completion-event routing from
      `server.js`; add focused recognition, authorization, validation, selected
      and unselected routing, legacy identity, evidence-message, provider-empty,
      provider-failure, atomic persistence, sanitization, corrupt/missing read,
      event fallback, and clock tests plus broker and research integration smokes.
      Enforce a focused 90% line/branch/function gate, verified at 100% lines,
      98.41% branches, and 100% functions. Reduce `server.js` to 12,962 lines.
- [x] 2.52 Extract authenticated audio/video-note collection, metadata, byte
      stream, and deletion routing from `server.js`; add focused unsupported
      method/path, authorization, async creation, collection, stream-precedence,
      metadata, and delete dispatch tests plus audio- and video-note integration
      smokes. Enforce a focused 90% line/branch/function gate, verified at 100%
      for all three metrics. Reduce `server.js` to 12,889 lines.
- [x] 2.53 Extract authenticated voice retranscription, turn list/detail,
      diagnosis, stored audio, session ticket, LiveKit token/reason/turn-record,
      hosted synthesis, and ambient-frame routing from `server.js`; add focused
      recognition, authorization, precedence, decoded identity, diagnosis scope,
      alias, bound, LiveKit unavailable/available, and synthesis-independence
      tests plus diagnosis and LiveKit transport smokes. Enforce a focused 90%
      line/branch/function gate, verified at 100% lines, 98.36% branches, and
      100% functions. Reduce `server.js` to 12,767 lines.
- [x] 2.54 Extract the gateway health projection from `server.js`; add focused
      routing, configured dependency, subsystem projection, and optional-state
      fallback tests plus an account-connection health integration smoke.
      Enforce a focused 90% line/branch/function gate, verified at 100% for all
      three metrics. Reduce `server.js` to 12,686 lines.

## 3. Other Oversized Surfaces

- [ ] 3.1 Split extension background orchestration below 2,000 lines.
- [ ] 3.2 Split extension content UI/voice/action responsibilities below 2,000 lines.
- [ ] 3.3 Split Android overlay lifecycle, UI, voice, and action coordination below 2,000 lines.
- [ ] 3.4 Split voice provider implementations into provider-specific modules.
- [ ] 3.5 Reduce the voice-session transport below 2,000 lines.
- [ ] 3.6 Split the pet-library page into bounded markup, style, and behavior files.
- [ ] 3.7 Reduce the work-history module below 2,000 lines.

## 4. Production Coverage Rollout

- [x] 4.1 Enforce at least 90% lines, branches, and functions for the Windows
      portable Rust core. Verified at 98.56% lines, 92.07% branches, and 98.15%
      functions with 27 passing tests.
- [ ] 4.2 Add a separate 90% line/branch/method report for the WinUI C# shell on
      a Windows runner.
- [x] 4.3 Add an exact browser-extension runtime classifier and non-vacuous
      production coverage ratchet that counts unloaded eligible files as zero.
      Baseline: 14.99% lines, 4.87% branches, and 6.73% functions.
- [ ] 4.4 Merge Node and Chromium target coverage and raise the browser hard
      gate to at least 90% lines, branches, and functions.
- [x] 4.4a Extract the browser turn/evidence protocol from background
      orchestration with a focused 90% gate. Verified at 100% lines, 95.90%
      branches, and 100% functions; reduce `background.js` to 5,543 lines.
- [x] 4.4b Extract browser agent-loop observation and action policy with a
      focused 90% gate. Verified at 100% lines, branches, and functions; reduce
      `background.js` to 5,460 lines.
- [x] 4.4c Execute the browser options runtime under Chrome storage, DOM,
      gateway, microphone, profile, companion, and sparse-optional-state tests;
      add it to the focused 90% gate. Verified at 99.22% lines, 92.16% branches,
      and 100% functions. Raise the exact whole-extension ratchet to 27.47%
      lines, 13.16% branches, and 11.45% functions with 31 passing unit tests
      and a passing real headless-Chromium smoke.
- [x] 4.4d Execute the bounded per-origin tweaks runtime under storage, DOM,
      deterministic intent-planning, every CSS compiler kind, agent-record
      validation, reapplication, removal, and message-routing tests; add it to
      the focused 90% gate. Verified at 99.14% lines, 91.54% branches, and 100%
      functions. Raise the exact whole-extension ratchet to 31.73% lines,
      15.04% branches, and 13.69% functions with 32 passing unit tests and a
      passing real headless-Chromium smoke.
- [x] 4.4e Execute the LiveKit background coordinator, proactive confirmation
      page, and offscreen audio worklet under focused success, failure,
      authorization, message-routing, browser-capability, and audio-buffer
      tests. Enforce focused 90% gates, verified respectively at
      100%/90.19%/100%, 100%/91.66%/100%, and 100%/100%/100% for
      lines/branches/functions. Raise the exact whole-extension ratchet to
      34.02% lines, 16.39% branches, and 15.05% functions with 35 passing unit
      tests and a passing real headless-Chromium smoke.
- [x] 4.4f Replace anonymous VM-string execution for the voice-capture gesture,
      voice-draft protocol, and UI-spec runtime with attributable production
      module imports; extend boundary cases and enforce focused 90% gates.
      Verified respectively at 100%/100%/100%, 100%/91.56%/100%, and
      100%/99.15%/100% for lines/branches/functions. Raise the exact
      whole-extension ratchet to 38.14% lines, 21.56% branches, and 18.19%
      functions while reducing conservative zero metadata to five files.
- [x] 4.4g Add an injectable production seam to the flag-gated offscreen
      LiveKit room lifecycle and test state mapping, pre-connect microphone
      buffering, audio attachment, participant events, teardown failures, and
      message dispatch. Enforce a focused 90% gate, verified at 100% lines,
      93.93% branches, and 100% functions. Raise the exact whole-extension
      ratchet to 39.13% lines, 22.00% branches, and 18.79% functions while
      reducing conservative zero metadata to four files.
- [x] 4.4h Execute extension-owned microphone and screen capture under focused
      media, resampling, cleanup, cap, upload, failure, and message-routing
      tests. Enforce a focused 90% gate, verified at 100% lines, 90.44%
      branches, and 100% functions. Raise the exact whole-extension ratchet to
      42.36% lines, 24.04% branches, and 20.24% functions with 37 passing unit
      tests and reduce conservative zero metadata to three files.
- [x] 4.4i Execute the extension-owned side panel under focused role, port,
      audio, voice-turn, recovery, hold-to-talk, picture-in-picture, typed-turn,
      and failure tests. Enforce a focused 90% gate, verified at 99.48% lines,
      93.33% branches, and 100% functions. Raise the exact whole-extension
      ratchet to 47.26% lines, 27.19% branches, and 23.67% functions with 38
      passing unit tests and reduce conservative zero metadata to the two
      oversized orchestration files.
- [x] 4.4j Extract bounded page observation, visible-text collection, action
      indexing, labels, and local confirmation policy from `content.js` into a
      focused runtime. Verified at 100% lines, 95.83% branches, and 100%
      functions; reduce `content.js` to 4,499 lines and raise the exact
      whole-extension ratchet to 48.36% lines, 28.52% branches, and 24.85%
      functions with 42 passing unit tests.
- [x] 4.4k Extract content voice transcript routing, profile-control and speech
      overlap policy, audio-segment normalization, playback progress, and
      transcript merging into a focused runtime. Verified at 100% lines,
      97.03% branches, and 100% functions; reduce `content.js` to 4,298 lines
      and raise the exact whole-extension ratchet to 49.69% lines, 30.53%
      branches, and 26.14% functions with 43 passing unit tests.
- [x] 4.4l Remove the uncovered duplicate UI-spec sanitizer from `content.js`
      and make the already-loaded, focused `ui-spec-runtime.js` the single
      sanitization authority. Preserve its 100% lines, 99.15% branches, and
      100% functions gate; reduce `content.js` to 4,155 lines and raise the
      exact whole-extension ratchet to 49.98% lines, 31.14% branches, and
      26.39% functions.
- [x] 4.4m Extract companion-pet payload and safe image URL sanitization,
      language-chip normalization, and avatar-behavior validation from
      `content.js` into a focused runtime. Verify it at 100% lines, 94.44%
      branches, and 100% functions; reduce `content.js` to 4,064 lines and
      raise the exact whole-extension ratchet to 50.70% lines, 32.46%
      branches, and 27.07% functions with 44 passing unit tests.
- [x] 4.4n Extract content-script stale-context detection, safe runtime
      messaging, safe storage access, and base64 decoding into an injected
      runtime while preserving post-call invalidation decisions. Verify it at
      100% lines, 91.11% branches, and 100% functions; reduce `content.js` to
      4,005 lines and raise the exact whole-extension ratchet to 51.33% lines,
      33.03% branches, and 27.93% functions with 45 passing unit tests.
- [x] 4.4o Extract `/incognito` and `/new` parsing plus persistent and one-shot
      context-control state from `content.js`, preserving incognito precedence
      without consuming a deferred new-thread arm. Verify the focused runtime
      at 100% lines, 93.33% branches, and 100% functions; reduce `content.js`
      to 3,954 lines and raise the exact whole-extension ratchet to 51.76%
      lines, 33.42% branches, and 28.33% functions with 46 passing unit tests.
- [x] 4.4p Extract privacy-first proactive sensitivity detection and structural
      page-count collection from `content.js`, retaining overlay exclusion,
      ten 100-count signal caps, a 2,000-node traversal cap, and fail-closed
      helper/walker behavior. Verify the focused runtime at 100% lines, 92.64%
      branches, and 100% functions; reduce `content.js` to 3,890 lines and raise
      the exact whole-extension ratchet to 52.36% lines, 34.39% branches, and
      28.87% functions with 47 passing unit tests.
- [x] 4.5 Enforce at least 90% lines, branches, and functions for the LiveKit
      worker. Verified at 99.07% lines, 90.40% branches, and 92.00% functions
      with all 19 tests passing.
- [x] 4.6 Add a production-only Android JaCoCo report and exact non-regression
      gate. Baseline: 16.43% lines, 19.79% branches, and 21.49% methods with
      128 passing JVM tests.
- [ ] 4.7 Merge JVM and emulator/device evidence and raise the Android hard gate
      to at least 90% lines, branches, and methods.
- [x] 4.7a Extract Android agent-run tracking from overlay orchestration with a
      focused 90% gate. Verified at 98.96% lines, 95.95% branches, and 100%
      methods; reduce `OverlayService.java` to 3,981 lines.
- [x] 4.7b Extract Android context-control state from overlay orchestration with
      a focused 90% gate. Verified at 100% lines, branches, and methods; reduce
      `OverlayService.java` to 3,959 lines.
- [x] 4.8 Repair Apple protocol drift, move executable shell behavior into
      test-linked modules, and add an exact, fail-closed coverage classifier.
      Current deterministic baseline: 84.60% lines, 85.42% functions, and
      78.67% LLVM regions across 45 passing tests and both instrumented app
      products. This Swift toolchain emits no branch counters, so regions are
      not relabeled as branches.
- [x] 4.8a Execute and merge inert bootstrap profiles for both Apple app
      products instead of counting their entrypoints as unexecuted. Verified
      without launching a window or requesting TCC permissions.
- [ ] 4.9 Raise Apple executable coverage to at least 90% for lines and
      functions, and enforce an honest 90% branch metric on a toolchain or
      instrumentation path that emits branch counters.
- [x] 4.8 Extract website inline JavaScript into attributable runtime modules
      and enforce at least 90% lines, branches, and functions across Pages
      handlers and browser code. Verified at 96.09% lines, 90.40% branches,
      and 97.47% functions with 42 passing tests.

## Verification

- `node scripts/source-size-policy.js`
- `cd gateway && npm run check`
- Surface-native verification for each later extraction.
