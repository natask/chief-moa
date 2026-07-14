## Why

Moa needs normal application updates to arrive without the user rebuilding or
manually reinstalling every client. Android OTA and browser-extension packaging
already exist in partial, surface-specific forms, but there is no reusable
release contract that macOS and Windows can adopt. Building four unrelated
updaters would duplicate channel selection, signing, rollout, evidence, and
rollback logic and make release claims difficult to trust.

This change defines one cross-surface release protocol and thin platform
adapters. It is separate from contextual capability routing and integration
authentication: application delivery changes the trusted client package;
runtime capabilities and connected accounts remain data governed by their own
contracts.

## What Changes

- Define an immutable, canonical, signed release manifest and a signed channel
  head for `stable`, `beta`, and `development` channels.
- Define common release identity, artifact integrity, compatibility, staged
  rollout, pause, supersession, rollback, and install-receipt fields.
- Require two distinct trust checks where the platform supports them: Moa
  release-control signature verification and native package/signing
  verification by the operating system or distribution store.
- Add platform adapter contracts for:
  - Android: the existing gateway-served APK flow, APK-signing continuity,
    checksum verification, and package-installer approval;
  - browser: browser-store managed updates for users, plus the existing
    versioned package and explicitly enabled unpacked-development reload flow;
  - macOS: a Developer ID-signed and notarized package consumed by a mature
    updater adapter, with user-visible install policy;
  - Windows: a signed package consumed by a platform or mature updater adapter,
    with publisher continuity and user-visible install policy.
- Define evidence-backed release states so an unsigned build, packaged archive,
  reload poke, notarization request, or CI success cannot be reported as a
  published, installed, smoke-checked, or production-ready update.
- Stage Android and browser first because they can be validated now. Keep macOS
  and Windows as separately testable adapter lanes that cannot claim readiness
  until their signing, distribution, installation, rollback, and real-device
  evidence exists.

## Capabilities

### New Capabilities

- `cross-surface-release-envelope`: A reusable signed manifest, channel,
  rollout, compatibility, and evidence contract for every application surface.
- `platform-update-adapters`: Thin Android, browser, macOS, and Windows adapters
  that translate the common release decision into the platform's supported
  package and update mechanism.
- `release-rollback-and-receipts`: Pause, supersession, rollback planning, local
  install receipts, and evidence-based readiness reporting.

## Boundaries

- A release manifest is data, not executable code. It identifies immutable
  artifacts; clients never execute scripts from a manifest.
- Release signing keys and platform signing/notarization credentials stay in
  isolated release infrastructure. They are never shipped in a client, stored
  in the browser extension, or exposed through gateway APIs.
- The gateway may publish and serve release metadata and artifacts. The client,
  operating system, or browser store owns installation authority.
- Chrome Manifest V3 privileged code still ships only through a packaged/store
  extension. Runtime configuration is not a substitute for package updates,
  and remotely hosted executable code is out of scope.
- This contract does not promise silent installation. Each adapter follows the
  platform's user-consent, enterprise-policy, and store rules.
- This change does not select or build a bespoke updater framework. Adapters
  SHOULD wrap a maintained platform-native or established updater mechanism;
  any dependency selection requires a separate review of license, maintenance,
  signing support, and rollback behavior.
- Gateway deployment, runtime customization, contextual capability routing, and
  third-party account authentication are separate changes.

## Current Truth At Change Creation

| Surface | Evidence present on 2026-07-13 | Not established by this evidence |
|---|---|---|
| Android | Gateway-served APK manifest/artifact, checksum check, package-installer handoff, OTA build/deploy scripts | Shared signed envelope, staged channels, automatic production readiness |
| Browser | Versioned packaging and an opt-in unpacked-development reload bridge | Store publication, store rollout, confirmed reload in every browser, cross-browser support |
| macOS | Architecture/prototype work elsewhere in repository history | Signed/notarized updater, published feed, install or rollback evidence |
| Windows | Protocol/prototype work elsewhere in the repository | Signed package, updater, publishing, install or rollback evidence |

The table is a baseline, not a production claim. Task completion must attach the
observable evidence named in `tasks.md` and the capability specification.

## Impact

- New shared release-envelope and verification code under a future gateway or
  repository release module.
- Existing Android OTA build, gateway endpoints, and client update check.
- Existing browser verification, packaging, store submission, and unpacked
  development reload paths.
- Future macOS and Windows packaging/updater adapters.
- Release CI, signing custody, artifact storage, deploy markers, smoke evidence,
  and OpenSpec/architecture documentation.

## Verification

- Strict OpenSpec validation for this change.
- Deterministic fixtures proving canonicalization, signature verification,
  channel selection, staged rollout, compatibility rejection, key rotation,
  pause, supersession, and rollback behavior.
- Per-adapter package, install, relaunch, version, and rollback/supersession
  checks on the actual target platform before that adapter advances beyond
  `built` or `packaged`.
