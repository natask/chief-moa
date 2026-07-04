# Chief Moa

Chief Moa is a cross-platform assistant for delegated work. The phone is the
control surface. The browser extension brings the same command surface to web
pages. The gateway routes model calls, voice turns, memory, and agent runs.

Chief Moa treats model output as a proposal. The device or browser checks the
proposal before any local action runs.

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
