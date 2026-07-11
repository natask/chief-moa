# Moa Windows surface

This directory is the Windows-owned Aggie surface lane. The first slice is a
portable Rust core so its trust rules can be tested without pretending that a
macOS host produced a WinUI application.

The core:

- consumes bounded Aggie `action.proposed` envelopes;
- keeps proposal review, approval and execution eligibility local;
- binds approval to the complete surface and proposal digest;
- produces a local receipt only after a caller reports an observed outcome;
- never performs an effect, stores a provider key, or owns canonical history.

It intentionally has no HTTP client, command runner, filesystem write path,
credential store, WinUI shell, MSIX manifest, signing identity, or updater.
Those require a Windows worktree with the .NET/Windows App SDK toolchain and a
separate signing/install authority review.

## Verify the portable core

```sh
cd windows_app/core
cargo test --locked
cargo clippy --all-targets -- -D warnings
```

## Windows build contract

The `windows-native-core.yml` workflow runs the same checks on a current
Windows runner and builds the MSVC target. A passing workflow proves only the
portable library on that runner; it is not WinUI, MSIX, signing, installation,
accessibility, or physical-device evidence.
