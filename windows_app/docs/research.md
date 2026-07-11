# Windows surface research packet

Date: 2026-07-11

## Repository and toolchain evidence

- Integration base `c4df1f5` freezes Aggie protocol N=2/N-1=1 in
  `gateway/lib/aggie-surface-protocol.js` and includes `windows` as a surface
  kind. It does not provide a native client transport or executor.
- This macOS host has Rust 1.96 nightly, Clang and Swift. It has no `dotnet`,
  MSBuild, PowerShell, Visual Studio, Windows SDK, Windows App SDK, WinUI, MSIX
  packaging, signing identity, or Windows runtime.
- Rust is therefore the only locally executable, provider-neutral way to prove
  a Windows-compatible authority core without fabricating native evidence.

## Current Microsoft platform facts

- WinUI 3 is Microsoft's native Windows desktop UI layer in Windows App SDK:
  https://learn.microsoft.com/windows/apps/winui/winui3/
- Packaged WinUI templates default to MSIX, and framework-dependent packaged
  apps have Windows App SDK deployment dependencies:
  https://learn.microsoft.com/windows/apps/windows-app-sdk/deploy-packaged-apps
- Credential Locker is available to desktop apps through WinRT, is for small
  credentials rather than data blobs, and should not be used without explicit
  save consent:
  https://learn.microsoft.com/windows/apps/develop/security/credential-locker
- Windows accessibility primarily integrates through UI Automation and
  requires automated plus assistive-technology validation:
  https://learn.microsoft.com/windows/apps/design/accessibility/accessibility-overview
- Direct and Store distribution have different signing/update authority; MSIX
  production packaging must be decided and tested on Windows:
  https://learn.microsoft.com/windows/apps/package-and-deploy/publish-first-app

These sources support future architecture choices. They are not build or UX
evidence for this slice.

## Coherent first slice

Implement a bounded Rust library under `windows_app/core` that independently
parses dangerous-data constraints and keeps action eligibility local. It
consumes already transported Aggie proposal/approval envelopes, binds them to
the complete Windows surface, session, state, time and canonical proposal
digest, and can generate a data-only receipt after an external executor reports
an outcome. A Windows CI job compiles/tests the portable library.

This slice does not choose WinUI navigation, window chrome, system tray,
notification behavior, accessibility labels, credential persistence,
transport authentication, device signing, action handlers, MSIX identity,
update channel, or signing certificate. Those require product authority and a
Windows test environment.
