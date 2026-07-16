# macOS microphone transcription candidate evidence

## Candidate scope

- Base: `938ad78f` (`fix(macos): accept gateway context metadata`)
- Branch: `feat/macos-push-to-talk-transcription-20260716`
- Adds an explicit microphone usage description, hold-to-talk PCM16 capture,
  authenticated `WS /v1/voice/sessions` transport to the user-configured
  gateway, and visible partial/final literal transcript state.
- The session declares `delivery_intent: literal_text`. Assistant/action events
  are ignored by the transcript client. Provider credentials remain gateway-only.
  The current gateway voice-session integration does not yet honor that field as
  a semantic model/tool/memory/TTS bypass; literal bypass remains blocked on the
  separately owned gateway integration candidate and is not claimed here.
- Excludes AX/cursor insertion, notch changes, screenshots, local actions,
  installation, launch, and deployment.

## Deterministic evidence

- `cd apple_surfaces && swift test`: passed, 58 tests.
- `cd apple_surfaces && swift build --product MoaMac`: passed.
- `cd apple_surfaces && bash scripts/coverage.sh --report-only`: new
  `MoaMacCore/GatewayVoice.swift` reached 98.11% lines, 90.48% functions, and
  96.04% regions. This LLVM toolchain emitted no branch counters.
- The repository-wide Apple coverage gate remains below 90% because existing
  production files outside this ticket are not covered: 68.97% lines, 76.00%
  functions, and 68.64% regions. This is recorded as a pre-existing gate
  blocker, not a pass.
- `cd apple_surfaces && bash scripts/package-moa-mac.sh`: passed and produced an
  ad-hoc-signed arm64 QA ZIP.
- `cd apple_surfaces && bash scripts/scan-moa-mac.sh dist/MoaMac.app`: passed.
- QA ZIP SHA-256:
  `a74d43bffe779b2cbd168f3fcc5c9feb38705a7f9a949725670a0b1b371164f1`.
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
