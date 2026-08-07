# Moa Windows surface

This directory is the Windows-owned Aggie surface lane. The first slice is a
portable Rust core so its trust rules can be tested without pretending that a
macOS host produced a WinUI application.

This lane is MIT-licensed and intentionally open to community-owned shells. A
contributor may replace the visual “blob” or use another Windows UI framework,
provided it keeps the behavior and authority boundaries in
[the companion surface contract](docs/companion-surface-spec.md).

The core:

- consumes bounded Aggie `action.proposed` envelopes;
- keeps proposal review, approval and execution eligibility local;
- binds approval to the complete surface and proposal digest;
- produces a local receipt only after a caller reports an observed outcome;
- validates a privacy-bounded `context_descriptor` v1 and resolves only
  caller-declared `execution_adapters` v1 for the observed foreground app;
- evaluates package/channel/version/architecture metadata for handoff to the
  Microsoft Store or Windows App Installer;
- never performs an effect, stores a provider key, or owns canonical history.

`Aggie.Windows/` now adds an unsigned WinUI literal-dictation candidate and a
Windows-host CI build contract. The explicit Dictation activity opens the
microphone only after the gateway acknowledges a durable `voice_drafts_v1`
identity, streams PCM16 to the configured gateway, exposes visible Cancel,
Pause, Resume and Finish controls, and accepts only transcription events. It
stores the bounded draft pointer locally, but never audio, transcript text,
provider credentials, or the gateway session credential.

It intentionally has no command runner, provider credential store, effect
implementation, UI Automation adapter, MSIX manifest, signing identity,
downloader, installer, or bespoke updater. Its only network path is the
configured, authenticated gateway voice WebSocket, and its only filesystem
write is the bounded draft-identity pointer used to prevent silent source loss.
The update seam remains
eligibility metadata only: package discovery, signature verification, rollout,
restart and rollback remain owned by the selected standard Windows mechanism.
Those require a Windows worktree with the .NET/Windows App SDK toolchain and a
separate signing/install authority review.

## Verify the portable core

```sh
cd windows_app/core
cargo test --locked
cargo clippy --all-targets -- -D warnings
```

## Windows build contract

The workflows run the portable-core checks and define an unsigned scaffold
build on a Windows runner. Until an actual workflow result is observed, the
scaffold build is unproven. Even a pass is not MSIX, signing, installation,
accessibility-runtime, integration, or physical-device evidence.

The Windows workflow also runs the pure .NET dictation protocol tests before
building the unsigned WinUI candidate. On a non-Windows host, verify the
portable authority and source contract and create a clearly labeled, non-
installed source QA artifact:

```sh
cd windows_app/core
cargo fmt --check
cargo test --locked
cargo clippy --all-targets -- -D warnings
cargo build --locked --target x86_64-pc-windows-msvc
cd ../..
node windows_app/scripts/verify-dictation-source.mjs
node windows_app/scripts/package-windows-dictation-qa.mjs
```

The microphone adapter uses [NAudio](https://github.com/naudio/NAudio) 2.2.1,
which is MIT-licensed. The NuGet package retains its upstream license metadata;
the QA source archive contains the package reference, not vendored NAudio
binaries.
