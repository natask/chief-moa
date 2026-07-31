# Tasks: Cross-Surface Session History

The required six-lane implementation handoff is
[`tickets.md`](tickets.md). Each lane ticket has one observable acceptance check,
files, authority boundary, verification, and deploy target or blocker. Implement
one numbered acceptance unit at a time; shared contracts land before clients,
and integration/promotion remain serial.

## 0. Source Evidence And Contract

- [x] 0.1 Preserve the recovered Android source note as a tracked artifact and
      link its gateway identity, completeness, duplicate handling, and outcome
      disposition from this change.
- [x] 0.2 Define canonical mixed-source message identity, deterministic latest-N ordering,
      deduplication, completeness, authorization, and platform authority rules.
- [x] 0.3 Write the six `chief-moa-orchestration` lane tickets and explicitly
      stage continuous workers/project mapping, macOS, Windows, iPhone, STT
      evaluation, Android overlay/native/remove ergonomics, and multimodal
      presentation input as follow-on outcomes.

Acceptance: strict OpenSpec validation accepts the change, and every staged
source-note outcome is either in scope or named in the follow-on map.

## 1. Gateway Canonical Projection

- [x] 1.1 Implement the gateway ticket in `tickets.md`: one authenticated,
      bounded mixed-source session-message projection with stable identities,
      untruncated bounded long text, deterministic order, deduplication, and
      completeness metadata.

Acceptance: the seeded mixed-source gateway acceptance in `tickets.md` passes.

## 2. Durable Browser Workspace

- [x] 2.1 Freeze the gateway response fixture, then implement the browser voice
      ticket: side-panel hydration, canonical render identity, close/reopen and
      worker-restart recovery, visible load/retry failure, and overlay handoff.
- [x] 2.2 Keep browser action/CDP execution out of scope; if canonical messages
      already contain terminal receipt refs, display only their bounded read-only
      state and prove no action/approval behavior changed.

Acceptance: the isolated Chrome side-panel acceptance in `tickets.md` passes,
and existing automation smokes remain green.

## 3. Android Full-App History

- [x] 3.1 Implement the Android ticket against the same frozen gateway fixture:
      full-app mixed-source history, stable row identity, loading/error states,
      exact retained text, completion labels, and bounded linked status.
- [x] 3.2 Preserve the overlay as current capture/result/status and approval UI;
      do not add canonical scrollback to overlay windows.

Acceptance: the Android process-refresh acceptance in `tickets.md` passes.

## 4. Integrated Verification And Release Evidence

- [x] 4.1 Run the exact candidate through gateway focused checks, extension
      verify/side-panel/general smokes in an isolated profile, Android unit/build
      checks, and strict OpenSpec validation.
- [x] 4.2 Create a gateway preview with isolated state where supported and build
      collision-free extension and Android release artifacts.
- [x] 4.3 Promote, reload, or install only when rollback, compatibility,
      no-interruption, drain, backup/restore, and post-change smoke evidence are
      all present; otherwise record the exact blocker and artifact paths.

Acceptance: the integrated Android-to-gateway-to-browser acceptance in
`tickets.md` passes for one exact candidate without foreground UI or active-user
session interruption.

## 5. Follow-On Outcome Handoffs

These items preserve source intent but are not implementation authorization in
this recovery wave.

- [ ] 5.1 Canonical project/intent mapping, unified worker queues, live outbound
      worker readiness, evidence-backed completion, and opt-in recurring agents.
- [ ] 5.2 Native Android overlay layout/removal ergonomics and five-design
      exploration with physical-phone gesture/removal QA.
- [ ] 5.3 Continuous STT/audio evidence evaluation and provider comparison with
      explicit paid/live consent.
- [ ] 5.4 Multimodal annotated video, drawing, slide, document, and presentation
      input through bounded evidence grants.
- [ ] 5.5 Canonical shared-session macOS history first, then Windows and iPhone
      after native transport, packaging, signing, install, and recovery evidence.

## 6. Browser Transcript-History Polish

- [ ] 6.1 Present retained browser transcripts newest first while keeping the
      canonical gateway response order unchanged. Give the latest completed
      user voice transcript the primary card treatment.
- [ ] 6.2 Add exact Copy to every retained user transcript card. Copy only the
      selected stored transcript, with no label, timestamp, assistant response,
      or metadata.
- [ ] 6.3 Remove repeated page, provider, session, agent, developer, and
      duplicate current-turn status blocks from the default History list. Keep
      current load errors and actions visible. Move linked run and receipt
      evidence behind a secondary detail view.
- [ ] 6.4 Add explicit audio-backed Re-transcribe for messages whose canonical
      record exposes accessible retained audio. Preserve the original
      transcript, append the result as a labeled revision, and keep display and
      copy available when re-transcription fails or audio is unavailable.

Acceptance: an isolated browser fixture seeds three voice turns in canonical
ascending order. History renders the newest transcript first, emphasizes it,
and copies each transcript byte-for-byte. Opening History and copying make no
transcription request. Only the audio-backed turn offers Re-transcribe; one
explicit request appends a labeled revision without changing the original.
The default list contains no repeated page, provider, session, agent, or
developer status blocks.
