# PR Consolidation And Promotion Evidence (2026-07-15)

## Intent

Resolve every open pull request, move the verified combined result to `master`
through the repository release gate, and confirm the DigitalOcean VPS promotion
end to end without interrupting active voice work.

## Integration Decision

- PR #12 is an ancestor of PR #13 and is superseded by it.
- PR #13 is the cross-surface manual voice steering superset.
- PR #15 carries the current-master Chirp, decomposition, and event-lock work.
- The release candidate starts at `origin/master`, merges #13 and #15, and keeps
  the current GCS/playback extraction together with Note admission and durable
  cross-socket steering.
- The combined candidate repaired a dropped trusted Coach prompt overlay and
  retained the `voice-session-server.js` 2,155-line debt ceiling.
- The browser extension release allocator selected version `0.1.57`.

## Verification Evidence

Candidate before this evidence-only commit: `44baa69e32e1c25b0b58c24895e119fc8245d6ad`.

- Gateway: `npm run check` passed, including the full test, smoke, source-size,
  syntax, and coverage matrix.
- Event substrate: the original PR #15 cross-process lock failure passed 20
  consecutive focused stress runs and the full gateway coverage run.
- Android: `./gradlew testDebugUnitTest assembleDebug` passed.
- Browser: `npm run verify && npm run smoke && npm run package` passed in an
  isolated headless Chrome profile; artifact `dist/A.G.-0.1.57.zip`.
- Apple: `swift test`, `swift build --product MoaMac`, and the ad-hoc QA bundle
  packaging passed.
- Windows: the portable-core coverage gate passed at 98.56% lines, 98.15%
  functions, and 92.07% branches.
- Website: 42 tests passed.
- LiveKit worker: build, 19 tests, and coverage passed at 99.07% lines, 90.40%
  branches, and 92.00% functions.
- OpenSpec: strict validation passed for the principal workflow, voice capture,
  voice gesture, provider voice, and Android core product-map changes.

## Promotion Contract

- Push and master movement must use `scripts/release/push-master.sh`.
- GitHub PR CI must be green before master fast-forwards.
- Gateway promotion is the master-triggered `vps-deploy` ref plus droplet timer.
- Do not promote while `/health` reports `voice_stream.activity.drain_safe=false`.
- Confirm production `/health` build SHA matches the promoted master identity,
  and confirm backup/restore-gated workflow evidence before claiming deployment.
