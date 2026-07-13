# Intent and voice foundation preview/promotion contract

## Candidate boundary

The integrated candidate is built only from committed staging state after all
slice auditors pass. It may not read or write the active gateway data directory,
database, queue, recording archive, worker pool, URL, or credentials.

## Isolated gateway preview

- Use a unique Compose project name, bind port, database volume/database name,
  `DATA_DIR`, queue namespace, and artifact directory.
- Use loopback/deterministic voice and model adapters. Provider/model/tool call
  counters must stay zero through draft create/capture/pause/park/resume/
  discard and unexpected close; only explicit SEND may enter the canonical
  provider seam.
- Seed synthetic, non-sensitive audio and intent fixtures. Never copy active
  recordings, transcripts, credentials, tokens, archives, or user database
  files into preview.
- Smoke authenticated intent list/detail/rehydration, draft HTTP lifecycle,
  draft WebSocket lifecycle, one explicit SEND, reliability timeline, legacy
  chat/voice, restart recovery, and bounded failure responses.
- Destroying preview must delete only its unique project resources. Preserve
  the committed candidate and test evidence as the rollback/reproduction
  artifact.

## Release artifacts

- Browser: verify, real-Chrome smoke, versioned package. Do not signal the
  loaded unpacked extension until there is proof no active browser recording,
  draft, task, or user session will be interrupted.
- Android: clean tests/build and OTA artifact. Do not install or publish OTA
  until real-phone QA against the matching isolated gateway proves capture,
  directional controls, post-SEND playback, process death/restart, and rollback
  without interrupting an active phone session.
- Gateway: candidate image/ref plus isolated smoke evidence. The active VPS
  remains unchanged until backup and scratch restore pass, old/new persisted
  state is compatible, running turns/jobs can drain or retry, and the previous
  deploy ref is a tested fast rollback.

## Promotion gate

Promotion is allowed only when all are true:

1. Every slice and integrated auditor returns PASS and all project gates pass.
2. Isolated preview smoke passes with separate state and no active-data access.
3. Backup and scratch restore evidence exists for every sensitive persisted
   store; audio retention/deletion policy is explicit.
4. Old and new code can read all persisted records used during rollout, with no
   irreversible migration coupled to the code switch.
5. No recording, voice turn, upload, agent run, queue job, migration, or active
   user session will be stopped, lost, or stranded; drain/resume/retry is proven.
6. The prior ref/artifact/config and restore command provide a fast tested
   rollback, followed by a health and legacy-voice smoke.

Missing real-phone QA, sensitive-data backup/restore, retention policy,
preview isolation, or drain evidence stops the run at committed artifacts. It
does not justify a dev-server replacement, browser reload, phone install, or
VPS restart.
