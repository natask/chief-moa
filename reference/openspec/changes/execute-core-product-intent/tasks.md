# Tasks: execute core product intent

Every ticket owns the named paths until it finishes. Agents do not commit.
The coordinator reviews and commits one finished unit at a time on local
`master`. Existing shared files stay serial.

## Wave 0: independent contracts

- [ ] B0.1 Browser observation anchors.
  - Owner: browser runtime agent.
  - Paths: new `browser-observation-anchor-runtime.js` and its unit test only.
  - Outcome: scroll keeps one live-node identity; replacement, navigation,
    ambiguity, canvas, and cross-origin targets fail with a reason.
  - Check: focused Node test.
  - Parallel: B0.2, B0.3, V0.1, V0.2, W0.1.

- [ ] B0.2 Purchase and payment checkpoint policy.
  - Owner: browser authority agent.
  - Paths: new `browser-action-checkpoint-policy.js` and its unit test only.
  - Outcome: buy, pay, checkout, credentials, submit, and destructive effects
    require one fresh approval bound to task, envelope, anchor, and before hash.
    Background mode cannot bypass it.
  - Check: focused Node test.
  - Parallel: B0.1, B0.3, V0.1, V0.2, W0.1.

- [ ] B0.3 Browser effect receipt contract.
  - Owner: browser receipt agent.
  - Paths: new `browser-effect-receipt-runtime.js` and its unit test only.
  - Outcome: every attempted effect produces one bounded, idempotent receipt
    without secrets or full page content.
  - Check: focused Node test.
  - Parallel: B0.1, B0.2, V0.1, V0.2, W0.1.

- [ ] V0.1 Endpoint voice timing accumulator.
  - Owner: voice timing agent.
  - Paths: new `gateway/lib/voice-client-timing.js` and its unit test only.
  - Outcome: duplicate and reordered milestones yield one monotonic summary for
    microphone start, partial, final, commit, first model text, audio receipt,
    playout, and completion. Impossible sequences fail.
  - Check: focused gateway unit test.
  - Parallel: browser contracts, V0.2, W0.1.

- [ ] V0.2 Append-only message revision domain.
  - Owner: history revision agent.
  - Paths: new `gateway/lib/session-message-revisions.js` and its unit test only.
  - Outcome: user transcript and assistant reply edits append a revision,
    preserve revision zero, use compare-and-swap, and reject cross-turn edits.
  - Check: focused gateway unit test.
  - Parallel: browser contracts, V0.1, W0.1.

- [ ] W0.1 Documentation authority audit.
  - Owner: workflow agent.
  - Paths: new `scripts/docs/authority-audit.mjs`, its test, and
    `reference/document-authority-index.md` only.
  - Outcome: report incoming links, duplicate authority claims, stale paths,
    and archive candidates without deleting files.
  - Check: focused Node test and repo audit.
  - Parallel: all Wave 0 contracts.

## Wave 1: browser integration and first Claude UI work

- [ ] B1.1 Emit anchors and revalidate actions in `content.js`.
  - Depends: B0.1 and B0.2.
  - Serial owner: browser content integrator.
  - Acceptance: real fixture scroll preserves the anchor; a replacement
    lookalike and purchase target cannot execute as a background action.
  - Check: dynamic Chrome smoke, extension verify.

- [ ] B1.2 Render one anchored on-page annotation. Claude Code UI ticket.
  - Depends: B1.1.
  - Owner paths: new annotation renderer, its CSS, fixture, and smoke only.
  - Acceptance: annotation stays within two CSS pixels while scrolling and
    becomes visibly stale after replacement.
  - Screenshot states: initial, scrolled, stale.

- [ ] B1.3 Fix the delegation envelope purchase gap.
  - Depends: B0.2.
  - Serial gateway/client schema owners.
  - Acceptance: buy and pay never reduce to preauthorized generic click/type.
  - Check: focused gateway and extension tests.

- [ ] B1.4 Wire receipts and cancellation into the background loop.
  - Depends: B0.1 through B0.3 and B1.1.
  - Serial owner: `background.js` integrator.
  - Acceptance: stop prevents later actions, scope change pauses, purchase
    pauses, and success requires completion evidence plus effect receipts.
  - Check: agent-loop smoke, extension verify and smoke.

- [ ] UI1.1 Browser workspace shell. Claude Code UI ticket.
  - Owner paths: side-panel HTML, CSS, UI modules, and UI tests only.
  - Outcome: clean navigation for Agent, Sessions, History, and Settings with
    visible progress, stop, checkpoint, and artifact areas.
  - Screenshot states: idle, streaming, acting, approval, done, error.
  - Parallel: B1.1 and B1.3 after response fixtures freeze.

- [ ] UI1.2 Android dark message and compact-control cleanup. Claude Code UI
  ticket.
  - Owner paths: Android ribbon tokens, ribbon view, focused tests only.
  - Outcome: user messages stay dark; duplicate Copy/History rails leave the
    compact overlay; History remains reachable through the full app.
  - Screenshot states: light system, dark system, long message, active capture.
  - Check: focused unit tests, lint, assemble, Android unit tests.
  - Parallel: browser UI because paths do not overlap.

## Wave 2: accounts, tenant storage, and privacy

- [ ] A2.1 Freeze the hosted identity and data-control OpenSpec.
  - Outcome: stable principal IDs, app-device scopes, data classes, safe media
    defaults, retention, export, and deletion are decided.

- [ ] A2.2 Add identity, app-device, data preference, blob ownership, export,
  and deletion tables with forced row-level security.
  - Depends: A2.1.
  - Acceptance: two integration-test users cannot read or write each other's
    rows. Old code still boots against the additive schema.

- [ ] A2.3 Enable general accounts and canonical principals.
  - Depends: A2.2.
  - Acceptance: two users resolve different stable principals; legacy token
    rotation does not change the seeded owner.

- [ ] A2.4 Add app-device registration and revocation.
  - Depends: A2.3.
  - Acceptance: each user can register and revoke Android and browser devices;
    raw credentials return once and never enter logs.

- [ ] A2.5 Enforce tenant ownership across conversations, media, runs, browser
  evidence, profiles, and account connections.
  - Depends: A2.2 and A2.3.
  - Parallel sublanes use disjoint store and handler paths. One server-route
    integrator runs after them.

- [ ] A2.6 Move new blobs to tenant and user object prefixes.
  - Depends: A2.2 and media ownership.
  - Acceptance: equal object IDs for two users map to different keys. Wrong
    principals cannot stat, read, or delete.

- [ ] A2.7 Enforce capture-time retention defaults and add inventory, export,
  deletion, and restore-safe tombstones.
  - Depends: A2.5 and A2.6.
  - Acceptance: default voice/browser turns retain no raw media; opted-in turns
    retain owned objects; restore cannot resurrect deleted content.

- [ ] A2.8 Browser sign-in and device UI. Claude Code UI ticket.
  - Depends: A2.4 API fixture.
  - Outcome: account/device/revoke UI replaces token paste as the primary path.

- [ ] A2.9 Android sign-in and device UI. Claude Code UI ticket.
  - Depends: A2.4 API fixture and Android credential transport.
  - Outcome: normal chat, history, and voice use the app-device credential.

- [ ] A2.10 Publish the privacy policy only after runtime defaults match it.

## Wave 3: voice latency, corrections, and quality

- [ ] V3.1 Add content-free Android and browser microphone-to-playout traces.
  - Depends: V0.1.
  - Acceptance: each Surface records distinct partial, final, model text, audio
    receipt, and observed playout milestones without transcript or raw IDs.

- [ ] V3.2 Add gateway stage timing and non-billable provider prewarm.
  - Acceptance: first STT partial, STT final, model delta, TTS segment, and
    socket write use one named server clock. Unsupported prewarm says so and
    never sends content or starts paid synthesis.

- [ ] V3.3 Harden assistant text/audio progress ranges.
  - Acceptance: displayed text advances monotonically with played audio and
    stale frames never reveal text.

- [ ] V3.4 Add the authenticated revision API and history projection.
  - Depends: V0.2 and tenant ownership.
  - Acceptance: edit preserves the original, returns the new revision, and
    cannot cross tenant, session, role, or turn.

- [ ] V3.5 Add browser and Android edit UI. Claude Code UI tickets.
  - Depends: V3.4 fixture.
  - Screenshot states: original, editing, corrected, conflict, deleted.

- [ ] V3.6 Export only explicitly consented corrections and raw audio.
  - Depends: V3.4 and retention controls.

- [ ] V3.7 Run offline preprocessing comparisons against one immutable corpus.
  - Outcome: paired WER and CPU/duration reports for gain, denoise, VAD,
    language hints, and bounded time stretch. Live provider replay is a separate
    user-approved paid run.

## Wave 4: self-hosting and development control

- [ ] W4.1 Add shared path claims and one immutable-candidate QA queue.
- [ ] W4.2 Add outbound ephemeral QA workers and shared safe caches.
- [ ] W4.3 Close terminal worktrees only after durable closure receipts.
- [ ] W4.4 Add tenant-scoped portable export, idempotent import, and projection
  rebuild.
- [ ] W4.5 Add proposal-only self-host planning, then an approved isolated
  provisioning executor with backup, restore, device enrollment, and rollback.
- [ ] W4.6 Label successors and archive only verified stale documentation.

## Final QA and release

- [ ] Q5.1 Freeze one combined commit and run source-size, gateway check,
  browser verify/smoke, Android lint/assemble/unit, OpenSpec validation, and
  Claude Code visual critique against fresh screenshots.
- [ ] Q5.2 Create exact-candidate preview artifacts with separate state.
- [ ] Q5.3 Promote only when rollback, compatibility, no-interruption, backup,
  restore, and smoke evidence pass. Record the blocker otherwise.
