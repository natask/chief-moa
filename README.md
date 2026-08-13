# Ag

Ag is a personal AI companion across Android, browser, and future
macOS/Windows/iOS surfaces. Each surface is permission-scoped. The gateway
routes Ag turns, model calls, memory, and agent runs.

Ag treats model output as a proposal. The owning Surface checks the
proposal before any platform-local action runs.

The repository is open source under the [MIT License](LICENSE). Platform
maintainers can implement their own native companion shell while preserving the
shared trust and interaction contract.

## Start here

- [ARCHITECTURE.md](ARCHITECTURE.md): system boundary and runtime flows.
- [ENGINEERING_STRATEGY.md](ENGINEERING_STRATEGY.md): contribution tracks,
  ownership strategy, and definition of done.
- [CONTRIBUTING.md](CONTRIBUTING.md): contributor setup, trust boundary, and
  pull request checklist.
- [AGENT_WORKFLOW.md](AGENT_WORKFLOW.md): how intent becomes specs, tickets,
  implementation, and verification.
- [AGENTS.md](AGENTS.md): operating contract for coding agents.
- [Core product intent](CORE_PRODUCT_INTENT.md): stable product
  outcomes, current status, and the ordered work that remains.
- [reference/openspec](reference/openspec): product maps and specs.
- [reference/scratch](reference/scratch): working notes and planning context.

## Components

- `android_app`: native Android companion.
- `browser_extension`: Chrome extension thin client.
- `gateway`: self-hosted gateway for model routing, storage, voice, and agent
  runs.
- `release_control_plane`: persistent release authority contract and domain
  model above applications, clients, and build/QA runners.
- `apple_surfaces`: shared compatibility authority library plus the native
  menu-bar voice/typed companion, privacy-scoped observation/suggestion surface,
  and ad-hoc-signed QA bundle tooling.
- `windows_app`: portable Windows authority core, community WinUI scaffold, and
  the native companion implementation contract.

## Common commands

Android build:

```sh
cd android_app
ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew assembleDebug
```

Gateway check:

```sh
cd gateway
npm run check
```

Gateway dev server:

```sh
cd gateway
cp .env.example .env
npm start
```

VPS gateway deploy path:

```sh
bash scripts/deploy.sh gateway \
  --direct-deploy --target chief-moa-production
```

See [gateway/deploy/vps/README.md](gateway/deploy/vps/README.md) before using
this against active clients; this is an active gateway promotion, so the VPS
preview, drain, compatibility, rollback, and smoke gates must pass first.

Browser extension check:

```sh
cd browser_extension
npm run verify
```

Browser extension local deploy:

```sh
bash scripts/deploy.sh extension
```

macOS surface check and unsigned QA artifact:

```sh
cd apple_surfaces
swift test
swift build --product Ag
bash scripts/package-ag-mac.sh
bash scripts/install-ag-mac.sh
```

The package command creates a versioned QA ZIP and SHA-256 under
`apple_surfaces/dist/`. The app has no packaged gateway: configure the user's
canonical origin and gateway token from its command panel. This artifact is not
Developer ID signed or notarized.

The install command installs a verified QA build as `/Applications/Ag.app` only
when that target is absent. It refuses to overwrite an existing installation.

Packaging does not launch the application or request Accessibility/Screen
Recording. Real TCC QA and production distribution require an isolated account,
stable Developer ID signing, notarization, and rollback evidence.

Extension deploys package the version in
`browser_extension/extension/manifest.json`; bump that version for changed
extension releases.

Android OTA artifact:

```sh
android_app/deploy/ota/build-ota-artifact.sh
```

VPS Android OTA publish:

```sh
bash scripts/deploy.sh android --direct-deploy --target chief-moa-production
```

Android uses OTA-only direct distribution through the gateway and Android
package installer. Every build must use the same continuity certificate. Read
[DEPLOYMENT.md](DEPLOYMENT.md) before release work. The default command runs
locally and writes an exact SHA-256 receipt. Publication requires the explicit
direct-deploy command above and the continuity key on this Mac.

Locally verify and package committed target changes:

```sh
bash scripts/deploy.sh auto
```

Plan a cross-surface release without publishing or installing anything:

```sh
bash scripts/deploy.sh plan scripts/release/release-evidence.example.json
```

The planner keeps build, QA, signing, publication, installation, and smoke
evidence distinct and requires every receipt to name the exact candidate digest.

Deploys record target version metadata under the git deploy marker directory, so
`scripts/deploy.sh` output shows the deployed version and deploy sequence.
