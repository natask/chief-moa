# VPS Gateway Onboarding - Browser Extension

## Target Setup

The packaged extension should point at one stable gateway origin:

```text
https://api.agee.app
```

Self-hosted installs use the same shape:

```text
https://api.<your-domain>
```

The old ZeroTier URLs are local-development choices only:

- `http://10.147.17.10:8787`: old main-machine gateway default.
- `http://10.147.17.6:8787`: local Mac dev gateway.

The VPS URL replaces the stale `10.147.17.10` vs `10.147.17.6` failure mode.
Both the browser extension and Android should use the same HTTPS gateway origin
for hosted/self-hosted onboarding.

## What The Extension Stores

The extension stores only:

- `ageeGatewayUrl`
- `ageeGatewayToken`
- stable browser device/session ids
- local UI and runtime-profile cache

It must not store provider keys, account passwords, worker tokens, or harness
credentials. The gateway owns provider credentials, account sessions, device
tokens, voice tickets, and durable state.

## Onboarding Flow

1. Open the A.G. toolbar icon and choose Options.
2. Enter the stable gateway URL.
3. Register this browser device or paste the per-device token.
4. Click the gateway test button.
5. Grant microphone permission from Options if voice will be used.
6. Open a low-risk page.
7. Press Cmd+, or Ctrl+, and send a typed `test` turn.
8. Press Cmd+. or Ctrl+. for voice, or double-click-and-hold the mark and speak.

Until registration exists, manual token paste is the migration path. The final
flow should let Options open the gateway approval URL, show a short code, and
store the per-device token after approval.

## Required Diagnostics

### Wrong URL

Options should classify the URL before testing:

- `10.147.17.10`: old main-machine ZeroTier gateway. Use the VPS URL unless this
  is intentional local testing.
- `10.147.17.6`: local Mac dev gateway. Use the VPS URL for browser/mobile
  onboarding.
- Missing scheme: enter `https://api.agee.app`, not just a host name.
- Endpoint path saved: save only the origin, not `/health`, `/v1/chat`, or
  `/v1/voice/sessions`.
- Fetch failed before HTTP status: check DNS, TLS, and the saved gateway URL.
- Non-Moa response: the URL answered, but not as a healthy Moa gateway.

### Bad Token

The current Options test already has the right shape: first check `/health`,
then check a protected route. Keep that contract.

Required output:

- `/health` fails: gateway URL or network problem.
- `/health` succeeds but protected route returns 401 without a token: gateway
  reachable, token required.
- `/health` succeeds but protected route returns 401/403 with a token: token
  rejected; re-register this browser or paste a fresh token.
- Stale/local URL plus 401: token may belong to another gateway.

The extension may show token length or "set/missing"; it must never print the
token value.

### Voice Unavailable

Browser voice has two separate setup gates:

1. Authenticated HTTP mints a one-use `/v1/voice/session-ticket`.
2. The returned WebSocket URL opens and sends `session_start`.

Required output:

- Microphone denied: grant microphone to the A.G. extension from Options or
  `chrome://extensions`.
- Ticket 401/403: device token was rejected for voice.
- Ticket or socket 404: gateway reachable, but voice routes are not deployed at
  this URL.
- Ticket succeeds but socket closes before `session_ready`: check WSS, TLS,
  Cloudflare WebSocket proxying, and the gateway voice process.
- Provider unavailable: text chat may still work, but voice provider is not
  configured or healthy.

## Browser Smoke Checks

From the repo:

```sh
cd browser_extension
AGEE_GATEWAY_URL=https://api.agee.app AGEE_GATEWAY_TOKEN=<device-token> npm run smoke:gateway
AGEE_GATEWAY_URL=https://api.agee.app AGEE_GATEWAY_TOKEN=<device-token> npm run smoke:live-voice-main
npm run verify
npm run smoke
```

Operational doctor:

```sh
cd browser_extension
npm run doctor
```

`doctor` should confirm the baked gateway URL/token without printing the token,
hit `/health`, and run an authenticated gateway check. It should warn when a
daily browser profile is still running an old unpacked extension from a
different path.

Manual browser check:

- Open Options and save `https://api.agee.app`.
- Test gateway and confirm token valid.
- Grant microphone.
- Open a normal web page.
- Use Cmd+, or Ctrl+, to send `test`.
- Use Cmd+. or Ctrl+. to start voice and confirm transcript/audio or a specific
  voice diagnostic.

## Source Follow-Ups

- `extension/config.js`: update hosted default URL and stale URL handling for
  both ZeroTier IPs.
- `extension/options.js`: add URL classification before `/health` and keep the
  authenticated probe.
- `extension/background.js`: make fetch failures and pre-open voice socket
  failures actionable instead of generic.
- `extension/manifest.json`: confirm stable HTTPS/WSS permissions and bump the
  package version when source changes ship.
- `scripts/configure.mjs` and `scripts/doctor.mjs`: default to the stable VPS
  shape for hosted onboarding while keeping `configure:local` for local dev.
