# Client Onboarding Tasks

This file records the exact follow-up implementation work for stable VPS client
onboarding. No Android or extension source is changed in this pass.

## 1. Shared Gateway URL Contract

- [ ] 1.1 Pick the hosted canonical origin, expected to be
  `https://api.agee.app` once DNS and TLS are live, and document the self-host
  alternative as `https://api.<domain>`.
- [ ] 1.2 Update client default configuration to prefer the stable HTTPS origin
  in hosted builds while keeping `http://10.147.17.6:8787` as an explicit local
  dev override only.
- [ ] 1.3 Normalize saved gateway URLs by trimming whitespace/trailing slashes
  and rejecting endpoint paths such as `/health`, `/v1/chat`,
  `/v1/voice/turns`, and `/v1/voice/sessions`.
- [ ] 1.4 Add stale URL recognition for both old ZeroTier addresses:
  `http://10.147.17.10:8787` and `http://10.147.17.6:8787`, including `ws://`
  voice variants and old port/path variants.

Acceptance: a client configured with a stable VPS origin derives HTTP and WSS
endpoints correctly, while either ZeroTier IP produces an intentional local-dev
or stale-address diagnostic.

## 2. Device Registration And Token Flow

- [ ] 2.1 Gateway: add a device registration start endpoint returning
  `registration_id`, `user_code`, `verification_uri`, and `expires_at`.
- [ ] 2.2 Gateway UI: let the signed-in user approve a pending Android or
  browser device by code, label, device id, and surface type.
- [ ] 2.3 Gateway: mint a per-device token bound to user id, device id, surface
  type, label, creation time, and revocation state.
- [ ] 2.4 Gateway: expose device token last-seen and revocation status in the
  account UI.
- [ ] 2.5 Android and browser: keep storing only `gatewayUrl` plus token; replace
  bootstrap/manual token with the approved per-device token.
- [ ] 2.6 Migration: keep the single `MOA_GATEWAY_TOKEN` path as bootstrap/owner
  mapping until both clients can register devices.

Acceptance: a registered Android device and browser extension can call a
protected route and voice setup route with device-scoped tokens, with no
provider key or account password stored in either client.

## 3. Android Source Tasks

- [ ] 3.1 `android_app/app/src/main/java/ai/moa/assistant/MoaPrefs.java`: replace
  the hosted default `DEFAULT_GATEWAY_URL` with the stable VPS origin or a
  build-time config value; keep ZeroTier IPs as explicit local-dev choices only.
- [ ] 3.2 `android_app/app/src/main/java/ai/moa/assistant/MoaVoiceGatewaySocket.java`:
  replace `DEFAULT_URL` or derive it from the configured gateway URL so hosted
  voice uses `wss://.../v1/voice/sessions` instead of a hard-coded ZeroTier
  `ws://` URL.
- [ ] 3.3 `MoaPrefs` or a small shared helper: add URL classification for
  stable, local-dev, stale-main-machine, missing-scheme, and endpoint-path
  inputs.
- [ ] 3.4 `MainActivity.java`: update the Voice agent setup card to show
  stale-IP warnings for `10.147.17.10` and `10.147.17.6` before running health.
- [ ] 3.5 `MainActivity.java`: after `GET /health` succeeds, run a protected
  lightweight auth probe such as `GET /v1/sessions`; show bad-token guidance
  separately from network failure.
- [ ] 3.6 `MainActivity.java`: add a "Register this device" path once the
  gateway registration endpoint exists. Use the existing `androidDeviceId()`
  value as the device id.
- [ ] 3.7 `MoaStreamingVoiceSessionController.java` and
  `MoaVoiceGatewaySocket.java`: decide the Android migration path for voice auth
  before hosted mode. Either keep direct bearer WebSocket auth with user-scoped
  token attribution, or mint a one-use `/v1/voice/session-ticket` like the
  browser path.
- [ ] 3.8 `MoaVoiceGatewaySocket.java`: extend failure messages to include stale
  IP guidance, Cloudflare/TLS/WebSocket proxy guidance for pre-open close, and
  "voice route missing" for HTTP 404.

Acceptance: Android setup can tell "wrong URL", "gateway reachable but token
bad", and "voice unavailable" apart before the user starts a voice turn.

## 4. Browser Extension Source Tasks

- [ ] 4.1 `browser_extension/extension/config.js`: replace the hosted default
  with the stable VPS origin or a generated config value, and expand
  `STALE_DEFAULT_GATEWAY_URLS` to include the old main-machine and local-dev
  ZeroTier URLs when they were auto-seeded.
- [ ] 4.2 `browser_extension/extension/agee.config.example.json`: update the
  example gateway URL to the stable VPS shape.
- [ ] 4.3 `browser_extension/scripts/configure.mjs`: default to the stable VPS
  origin for hosted onboarding; keep `configure:local` for
  `http://10.147.17.6:8787`.
- [ ] 4.4 `browser_extension/scripts/doctor.mjs`: report `10.147.17.10` and
  `10.147.17.6` as ZeroTier/local choices, not silent success for hosted
  onboarding; keep token redaction.
- [ ] 4.5 `browser_extension/extension/options.js`: before testing `/health`,
  classify stale/local/malformed URLs and show an actionable message.
- [ ] 4.6 `options.js`: keep the current two-step probe (`/health`, then a
  protected route), and make bad-token output say re-register or paste a fresh
  device token.
- [ ] 4.7 `browser_extension/extension/background.js`: make `callGateway`
  distinguish fetch/DNS/TLS failures from HTTP failures and include the redacted
  gateway origin in user-visible errors.
- [ ] 4.8 `background.js`: in `startVoiceSessionProxy`, replace generic pre-open
  "Live voice connection failed/closed" with diagnostics for ticket denied,
  missing voice route, and WebSocket/TLS/proxy failure. Include the gateway URL
  from config, not the opaque ticket token.
- [ ] 4.9 `browser_extension/extension/manifest.json`: confirm the packaged
  extension can fetch the stable HTTPS origin and open the stable WSS voice URL;
  add explicit `wss://api.agee.app/*` or self-host permission coverage if the
  current host permissions are insufficient.
- [ ] 4.10 `browser_extension/extension/manifest.json`: bump the extension
  version when source changes ship.

Acceptance: browser Options and overlay errors guide the user to the stable URL,
fresh token registration, microphone grant, or gateway voice route without
mentioning provider keys or old browser-side model paths.

## 5. Gateway Diagnostics Tasks

- [ ] 5.1 `GET /health`: include deployment mode, public base URL if configured,
  token requirement, and voice runtime summary without requiring auth.
- [ ] 5.2 Protected auth probe route: return structured 401/403 error codes for
  missing, invalid, expired, revoked, and wrong-scope device tokens.
- [ ] 5.3 `/v1/voice/session-ticket`: return structured errors for missing auth,
  bad token, voice disabled, and provider unavailable.
- [ ] 5.4 `/v1/voice/sessions`: keep 404 for missing route, 401/403 for auth
  failure, and structured `error` events after socket open for provider/runtime
  failures.

Acceptance: clients do not need to infer every setup failure from a generic
network exception.

## 6. Smoke Checks

- [ ] 6.1 VPS reachability:
  `curl -fsS https://api.agee.app/health`.
- [ ] 6.2 VPS auth:
  `curl -fsS -H "authorization: Bearer <device-token>" https://api.agee.app/v1/sessions`.
- [ ] 6.3 Browser gateway smoke:
  `cd browser_extension && AGEE_GATEWAY_URL=https://api.agee.app AGEE_GATEWAY_TOKEN=<device-token> npm run smoke:gateway`.
- [ ] 6.4 Browser live voice smoke:
  `cd browser_extension && AGEE_GATEWAY_URL=https://api.agee.app AGEE_GATEWAY_TOKEN=<device-token> npm run smoke:live-voice-main`.
- [ ] 6.5 Browser package checks after source changes:
  `cd browser_extension && npm run verify && npm run smoke`.
- [ ] 6.6 Android build after source changes:
  `cd android_app && ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew assembleDebug`.
- [ ] 6.7 Android manual smoke: save stable URL/token, check setup status, send a
  typed turn, start/release a voice turn, and confirm transcript plus either
  audio or a specific voice diagnostic.

Acceptance: the hosted/VPS URL path has one automated browser smoke, one
authenticated gateway smoke, and one mobile smoke before active promotion.

## 7. Promotion Boundary

- [ ] 7.1 Do not change the active user URL, restart the active gateway, publish
  OTA/browser packages, or apply a Master Orch deployment from this client
  onboarding pass.
- [ ] 7.2 Before any future active promotion, run the remote-hosted-gateway
  backup and read-only restore check for Postgres plus `DATA_DIR`.

Acceptance: client onboarding can be reviewed as an isolated preview plan
without mutating the live app.
