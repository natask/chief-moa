# Moa Windows surface

This directory is the Windows-owned Aggie surface lane. The first slice is a
portable Rust core so its trust rules can be tested without pretending that a
macOS host produced a WinUI application.

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

`Aggie.Windows/` now adds an unsigned WinUI source scaffold and a Windows-host
CI build contract. It is not connected to the Rust authority core and has not
been built on this macOS host.

It intentionally has no HTTP client, command runner, filesystem write path,
credential store, effect implementation, UI Automation adapter, MSIX manifest,
signing identity, downloader, installer, or bespoke updater. The update seam is
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
