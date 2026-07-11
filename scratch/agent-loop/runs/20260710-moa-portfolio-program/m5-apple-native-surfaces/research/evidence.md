# Research evidence

## Repository and toolchain

- Base `c4df1f5` contains the audited Aggie JavaScript protocol and strict spec.
- No Apple/Xcode/Swift product target existed at the base, so no legacy Apple
  architecture can be silently inherited.
- Measured locally: Xcode 26.3 (17C529), Swift 6.2.4, arm64 macOS host.
- The Apple lane can therefore use a pure Swift package with declared macOS and
  iOS platforms and ask Xcode to compile the package for an unsigned generic iOS
  Simulator destination.

## Architecture decision

The first Apple artifact is a UI-independent adapter library, not a permanent
companion or seamless-assistant shell. It owns protocol validation, local
approval coordination, pre-effect state revalidation, bounded replay, and local
receipt formation. Network transport, Keychain token storage, permissions,
actual actions, native windows/scenes, background modes, signing, update feeds,
and canonical history remain injected or absent.

This is the largest coherent artifact whose behavior can be proven without a
product UX decision, credentials, provisioning profiles, or physical devices.

## Current Apple sources consulted

- Apple SwiftUI app structure: https://developer.apple.com/documentation/swiftui/app
- Keychain Services boundary: https://developer.apple.com/documentation/security/keychain-services
- Testing accessibility: https://developer.apple.com/documentation/accessibility/accessibility-testing
- Unified logging privacy: https://developer.apple.com/documentation/os/logging

The package intentionally does not claim these unimplemented integrations.

## Residual unknowns

- permanent companion versus seamless-assistant UX
- app identifiers, team/provisioning/signing/notarization authority
- Keychain access groups and migration policy
- permission prompts, accessibility APIs, background execution and energy use
- physical-device behavior and supported OS/device matrix
- authenticated transport, reconnect integration, canonical receipt upload
- signed update, rollback and distribution channel

No paid benchmark, external model evaluation, live provider, network, device,
energy, or accessibility run is part of this evidence.
