# Chief Moa

Chief Moa is the cross-platform product and family of user-owned surfaces for
delegated work. **Aggie** is the canonical personal-agent identity and
cross-surface session/routing contract; **A.G.** is a presentation/spoken alias.
Android, browser, and future macOS/Windows/iOS clients are permission-scoped Moa
surfaces. The gateway routes Aggie turns, model calls, memory, and agent runs.

Chief Moa treats model output as a proposal. The owning Surface checks the
proposal before any platform-local action runs.

## Start here

- [ARCHITECTURE.md](ARCHITECTURE.md): system boundary and runtime flows.
- [ENGINEERING_STRATEGY.md](ENGINEERING_STRATEGY.md): contribution tracks,
  ownership strategy, and definition of done.
- [CONTRIBUTING.md](CONTRIBUTING.md): contributor setup, trust boundary, and
  pull request checklist.
- [AGENT_WORKFLOW.md](AGENT_WORKFLOW.md): how intent becomes specs, tickets,
  implementation, and verification.
- [AGENTS.md](AGENTS.md): operating contract for coding agents.
- [reference/openspec](reference/openspec): product maps and specs.
- [reference/scratch](reference/scratch): working notes and planning context.

## Components

- `android_app`: native Android overlay assistant.
- `browser_extension`: Chrome extension thin client.
- `gateway`: self-hosted gateway for model routing, storage, voice, and agent
  runs.
- `apple_surfaces`: shared Aggie authority library plus the native menu-bar
  `MoaMac` typed companion, privacy-scoped observation/suggestion surface, and
  ad-hoc-signed QA bundle tooling.

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
scripts/vps/push.sh --host root@203.0.113.10 --ref master
```

See [gateway/deploy/vps/README.md](gateway/deploy/vps/README.md) before using
this against active clients; this is an active gateway promotion, so the VPS
backup and scratch restore gate must pass first.

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
swift build --product MoaMac
bash scripts/package-moa-mac.sh
```

The package command creates a versioned QA ZIP and SHA-256 under
`apple_surfaces/dist/`. The app has no packaged gateway: configure the user's
canonical origin and gateway token from its command panel. This artifact is not
Developer ID signed or notarized.

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

Main-machine Android OTA sync:

```sh
android_app/deploy/ota/sync-main-machine.sh
```

Auto-deploy committed target changes:

```sh
bash scripts/deploy.sh auto
```

Deploys record target version metadata under the git deploy marker directory, so
`scripts/deploy.sh` output shows the deployed version and deploy sequence.
