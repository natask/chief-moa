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

`Aggie.Windows/` now adds an unsigned WinUI source scaffold and a Windows-host
CI build contract. It is not connected to the Rust authority core, has no HTTP
client, command runner, credential store, effect implementation, signing
identity, installer, or updater, and has not been built on this macOS host.

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
