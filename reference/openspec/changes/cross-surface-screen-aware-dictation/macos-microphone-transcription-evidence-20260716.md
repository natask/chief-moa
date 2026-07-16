# macOS microphone transcription candidate evidence

## Candidate scope

- Base: `938ad78f` (`fix(macos): accept gateway context metadata`)
- Branch: `feat/macos-push-to-talk-transcription-20260716`
- Adds an explicit microphone usage description, hold-to-talk PCM16 capture,
  authenticated `WS /v1/voice/sessions` transport to the user-configured
  gateway, and visible partial/final literal transcript state.
- The session declares `delivery_intent: literal_text`. Assistant/action events
  are ignored by the transcript client. Provider credentials remain gateway-only.
- Excludes AX/cursor insertion, notch changes, screenshots, local actions,
  installation, launch, and deployment.

## Deterministic evidence

- `cd apple_surfaces && swift test`: passed, 56 tests.
- `cd apple_surfaces && swift build --product MoaMac`: passed.
- `cd apple_surfaces && bash scripts/coverage.sh --report-only`: new
  `MoaMacCore/GatewayVoice.swift` reached 98.01% lines, 90.00% functions, and
  95.74% regions. This LLVM toolchain emitted no branch counters.
- The repository-wide Apple coverage gate remains below 90% because existing
  production files outside this ticket are not covered: 65.74% lines, 74.21%
  functions, and 66.06% regions. This is recorded as a pre-existing gate
  blocker, not a pass.
- `cd apple_surfaces && bash scripts/package-moa-mac.sh`: passed and produced an
  ad-hoc-signed arm64 QA ZIP.
- `cd apple_surfaces && bash scripts/scan-moa-mac.sh dist/MoaMac.app`: passed.
- QA ZIP SHA-256:
  `461ca411e411ed88ab75eb2fbd01d2ee2d8c43db2f6c1778edb7ea2d850d93ae`.
  This identifies the retained artifact from exact-candidate verification. The
  current ad-hoc ZIP packaging path is not byte-reproducible across separate
  invocations, so rebuilding it requires recording a new artifact digest.

## Required real-Mac evidence still missing

- Do not install or launch this development candidate in this lane.
- In an isolated QA identity, install the exact ZIP, confirm the first-use TCC
  prompt and denial copy, then grant microphone access and hold/release the mic.
- Verify a protected spoken phrase appears exactly as the visible final
  transcript against the configured gateway, and that interruption remains
  visible while no other application is mutated.
- Installation, TCC identity, live-provider behavior, signing/notarization,
  rollback, and active promotion remain unproven.
