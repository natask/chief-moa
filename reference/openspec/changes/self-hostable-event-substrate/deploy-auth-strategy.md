## Deployment And Auth Strategy

Date: 2026-07-02

## Decision

Chief Moa should keep one deployable gateway for now. The gateway owns routing,
provider credentials, durable state, agent runs, event storage, auth, and OTA
artifacts. Android and the browser extension remain thin clients pointed at a
configured gateway URL plus token.

The current remote target is the main-machine gateway:

```text
http://10.147.17.10:8787
ws://10.147.17.10:8787/v1/voice/sessions
```

This Mac's local gateway remains a development override:

```text
http://10.147.17.6:8787
ws://10.147.17.6:8787/v1/voice/sessions
```

## Why Not Microservices Yet

Splitting this into many services now would make deployment, auth, restore, and
debugging harder before the core product boundaries are stable. Keep the gateway
modular internally and extract only stateless adapters later, such as provider
bridges, transcription workers, or integration tool runners.

Cloud-function-style code is still compatible with this direction: small
adapter modules should keep narrow inputs and outputs so they can run inside the
gateway today and move to a worker/function later without changing Android or
extension protocols.

## GitHub Deployment Path

GitHub-triggered deployment should run on a self-hosted runner inside the
ZeroTier/main-machine network. GitHub-hosted runners cannot directly reach
`10.147.17.10`.

The workflow should:

- verify gateway changes with `cd gateway && npm run check`
- verify Android changes with `cd android_app && ./gradlew assembleDebug`
- deploy the selected target through `scripts/deploy.sh`
- smoke-check `GET http://10.147.17.10:8787/health`

Browser extension deployment remains package/reload based. GitHub can verify and
package it, but it cannot reload a user's already-loaded local browser extension.

## Auth Path

Current auth is a single `MOA_GATEWAY_TOKEN` bearer token for protected gateway
routes. The next auth slice should layer user identity over that boundary
without changing the client trust model:

1. Keep local loopback/private deployments simple: no auth only when explicitly
   configured for a trusted local network.
2. Keep remote single-user mode as bearer-token auth with all writes attributed
   to one owner.
3. Add hosted multi-user mode by introducing users, sessions, and tenant scoped
   event streams/projections.
4. Gate export/import/sync by auth mode while preserving the event-envelope and
   projection contracts.

## Lane Tickets

Lane: Gateway/deploy
Outcome: main-machine deploy scripts and docs use port `8787`.
Files: `scripts/deploy.sh`, `gateway/deploy/main-machine/*`.
Boundary: deploy code must not read or print `.env`.
Acceptance: deploy smoke targets `http://10.147.17.10:8787/health`.
Verification: `bash -n scripts/deploy.sh gateway/deploy/main-machine/sync-when-online.sh`.
Deploy target or blocker: deploy blocked while `10.147.17.10` is unreachable.

Lane: Browser extension
Outcome: packaged default points at the main-machine gateway; local development
uses `npm run configure:local` or Options override.
Files: `browser_extension/extension/config.js`, extension scripts/docs.
Boundary: extension holds only gateway URL/token, never provider keys.
Acceptance: `npm run verify` passes and config preserves local overrides.
Verification: `cd browser_extension && npm run verify`.
Deploy target or blocker: extension package/reload remains local.

Lane: Android
Outcome: Android defaults to the main-machine gateway while retaining settings
override for this Mac's local gateway.
Files: `android_app/app/src/main/java/ai/moa/assistant/MoaPrefs.java`,
`android_app/app/src/main/java/ai/moa/assistant/MoaVoiceGatewaySocket.java`.
Boundary: Android stores no provider keys.
Acceptance: debug APK compiles.
Verification: `cd android_app && ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew assembleDebug`.
Deploy target or blocker: OTA publish blocked while `10.147.17.10` is unreachable.

Lane: GitHub automation
Outcome: GitHub Actions can verify and deploy gateway/Android changes from a
self-hosted runner inside the ZeroTier network.
Files: `.github/workflows/deploy-main-machine.yml`.
Boundary: no secrets are committed; deployment target comes from repo defaults
or GitHub variables.
Acceptance: workflow exists with push and manual dispatch triggers.
Verification: inspect workflow syntax and target selection shell.
Deploy target or blocker: requires a GitHub self-hosted runner on/near the main
machine before it can deploy.
