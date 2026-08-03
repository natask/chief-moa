# Gateway Capture-Handoff Preview Evidence — 2026-08-03

## Candidate

- Commit: `60ce90f4a98b4d95e0f1daee37a6f22b2deb5291`
- Image digest:
  `sha256:129f1354d5e8b56467d074fd498d41c4e5bce0d999254e72b56348e79478fa4a`
- Isolated Compose project: `chief-capture-preview-60ce90f4`
- Bound address: `127.0.0.1:18793`
- State isolation: dedicated Compose network, Postgres service, and named
  volumes; no production state, queue, worker pool, or public URL was used.
- Provider isolation: transcription worker disabled, no provider credential,
  and Switchboard transport pointed at a closed loopback target. This preview
  incurred no provider call or cost.

The candidate fixes a deployment-contract omission: the gateway image already
implemented retained-audio transcription and Switchboard handoff, but
`docker-compose.yml` did not pass the `CAPTURE_TRANSCRIPTION_*` or
`AGENT_SWITCHBOARD_*` settings into the container. The candidate maps the
complete settings with inert defaults and adds a deployment-contract test that
keeps those defaults and the VPS operator template aligned.

## Exact Preview Results

The isolated gateway health response reported the exact candidate commit,
`capture_transcription.enabled=false`, and
`voice_stream.activity.drain_safe=true`.

An authenticated 3,200-byte retained PCM note produced:

- audio note: `note_msddtppo_638269901ada`
- schema-v2 capture block:
  `cap_f00167f0c6ba4512dccf444265669087738cee890a47712dbd0843ad5f4877ce`
- processing state: queued
- dispatch count: zero
- agent-run file count: zero

The exact note replayed byte-for-byte after a gateway restart. The exact
capture identity rehydrated from the same isolated state. An unconfirmed
handoff returned HTTP 400 before any Switchboard request, dispatch, or agent
run. This proves the inert capture boundary and explicit-confirmation gate in a
production-shaped container without fabricating a transcript or admission.

## Rollback And State Compatibility

The currently deployed predecessor,
`c9c65689c43389ab879418330b48da559237ef68`, was built from exact source and
started against the same isolated candidate-created Postgres and data volumes.
It became healthy, reported `drain_safe=true`, replayed the same note as exactly
3,200 bytes, and emitted no fatal, uncaught, unhandled, or panic log. It did not
project the candidate capture block, returning a bounded not-found response
instead of failing on the additive state.

The exact candidate was then restored without rebuilding. It became healthy,
replayed the same 3,200-byte note, and rehydrated the same schema-v2 capture
identity in queued state. The rollback path is therefore the predecessor image
plus the preserved named volumes; the candidate remains predecessor-tolerant
and recoverable across that rollback for this additive state.

## Verification

- `node --test test/capture-deployment-contract.test.js`: 3/3 pass
- `cd gateway && npm run check`: pass, including the repo-wide source-size
  policy
- `openspec validate chief-moa-capture-handoff-reconciliation --strict`: pass
- `git diff --check`: pass before the implementation commit

## Promotion Decision

Do not promote this candidate yet. The isolated preview proves configuration
reachability, inert capture, restart recovery, predecessor compatibility,
rollback, and drain safety. It does **not** prove:

- retained PCM transcription through a real configured provider;
- a real user confirmation on an installed Surface;
- a confirmed Switchboard receipt bound to source, transcript-result identity,
  execution authority, canonical outcome, and acceptance gate;
- preservation of that outcome and acceptance gate in a downstream Agent
  Launcher run packet;
- hosted preview smoke or public post-promotion smoke.

Production still reports build `c9c65689c43389ab879418330b48da559237ef68`
with no `capture_transcription` health section. A production capture POST was
observed as HTTP 404. Those are blockers, not evidence that the coherent
capture-to-Switchboard loop is installed.

The browser extension has a versioned `0.1.145` package at
`browser_extension/dist/Ag-0.1.145.zip`, and the local deployment marker binds
it to commit `53c02597f1e169a89805db46670020fe99fbc096`. The marker does not
independently prove that an already-loaded browser confirmed the reload, so
installed-browser status remains unverified.
