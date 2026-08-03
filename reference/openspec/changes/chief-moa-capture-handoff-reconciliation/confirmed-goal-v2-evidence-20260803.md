# Confirmed Goal Contract V2 Evidence — 2026-08-03

## Exact Candidate

- Commit: `5be6afc6745f6e776bb06424d694ead49275ae65`
- Gateway image:
  `sha256:e61a6f5824bfa7a3e8c8aff39f2d59e3e526ab1da8963530b48cffcac7ae461c`
- Browser extension: `0.1.146`
- Extension package: `browser_extension/dist/Ag-0.1.146.zip`
- Extension SHA-256:
  `d4ba628b027a386b33da562eb59f293089bdcb7c09d4acfb37c552f4a0fd2abf`

The exact gateway image ran in the isolated Compose project
`chief-capture-preview-5be6afc6`, bound to `127.0.0.1:18793` with separate
network, Postgres, and named volumes. Health reported the exact commit,
`capture_transcription.enabled=false`, and
`voice_stream.activity.drain_safe=true`. No provider credential or external
Switchboard traffic was used.

## Contract Proof

Chief keeps source-only contract v1 when confirmed goal fields are absent. A
terminal selected-note handoff becomes contract v2 only after the browser user
enters and confirms both:

- one nonempty `desired_outcome` of at most 100,000 characters; and
- 1–32 deduplicated `acceptance_criteria`, each at most 1,000 characters.

The literal transcript remains source evidence. Chief does not derive or
summarize the desired outcome or acceptance criteria from it. The browser shows
the exact goal fields in the execution confirmation and persists the confirmed
goal before network submission so a response-loss retry cannot change the
request. Editing, cancellation, capture, transcription, and replay remain
non-executing.

The gateway request digest covers the complete v2 envelope. Switchboard must
echo `desiredOutcome` and `acceptanceCriteria`; a mismatch is rejected before a
Chief receipt is appended. The retained receipt includes the exact confirmed
goal fields plus the content-bound source, request digest, idempotency identity,
and bounded external identities. A changed goal on the same source revision is
a conflict.

Chief and Switchboard use the same `external-intent-v2.json` fixture shape. The
Chief copy is `gateway/test/fixtures/external-intent-v2.json`.

## Verification

- Full gateway `npm run check`: pass
- Focused handoff unit and live-server integration: 24/24 pass
- Handoff focused coverage: 99.17% lines, 92.17% branches, 100% functions
- Browser `npm run verify`: 278/278 unit tests pass
- Real headless side-panel smoke: pass, including exact goal confirmation,
  cancellation with zero handoff, v2 request, echoed receipt, retry, and panel
  reopen
- Real headless full-extension smoke: pass
- Repo-wide source-size policy: pass
- Strict OpenSpec validation: pass
- `git diff --check`: pass

## Installed And Promotion State

The `0.1.146` extension is packaged but was not sent a reload signal and has no
deploy marker or installed-browser confirmation. Production Chief still reports
gateway build `c9c65689c43389ab879418330b48da559237ef68`, with no
`capture_transcription` health projection. Loading the v2-only browser goal UI
against that old gateway would produce an incompatible v1 receipt, so the
extension was deliberately not reloaded.

No fixture or synthetic note is claimed as an actually user-confirmed capture.
The implementation and exact artifacts are complete. Active promotion and the
installed-loop acceptance remain blocked until the gateway candidate can be
safely promoted, the browser reload is confirmed, and a real selected note is
transcribed and explicitly confirmed by the user through installed Chief and
Switchboard/Launcher.
