# Client Onboarding Contract

## Scope

This contract covers the Android app and browser extension path from a
ZeroTier/local gateway to a stable VPS gateway. It does not promote an active
deployment, change client source, or change the live gateway. The client
boundary remains unchanged: Android and the extension store only a gateway URL
and a token; provider keys, account passwords, model routing, voice routing, and
state stay on the gateway.

## Current Client Evidence

- Android stores `gateway_url` and `gateway_token` in `MoaPrefs`.
- Android currently defaults to `http://10.147.17.10:8787`.
- Android voice currently derives or defaults to
  `ws://10.147.17.10:8787/v1/voice/sessions` and sends the bearer token in the
  WebSocket request header.
- Android setup checks `GET /health`, but a healthy `/health` does not prove the
  saved token can call protected routes.
- The browser extension stores `ageeGatewayUrl` and `ageeGatewayToken`.
- The browser extension defaults to `http://10.147.17.10:8787`, has
  `http://10.147.17.6:8787` as the explicit local-dev URL, and currently treats
  only `http://10.147.17.10:8788` as a stale seeded default.
- The browser Options page already checks `/health` and then an authenticated
  route, which is the target diagnostic shape for both clients.
- Browser voice mints `/v1/voice/session-ticket`, then opens the returned
  headerless WebSocket URL. Its pre-open WebSocket errors are currently too
  generic for VPS onboarding.

## Stable Gateway URL

The remote gateway URL is a stable HTTPS origin, not a ZeroTier IP and not a
dev-server URL.

```text
hosted default:     https://api.agee.app
self-host example:  https://api.<your-domain>
local dev only:     http://10.147.17.6:8787
legacy main only:   http://10.147.17.10:8787
```

Client storage keeps the normalized origin without a trailing slash and without
endpoint paths. Endpoint URLs are derived from that origin:

```text
GET  <gateway>/health
GET  <gateway>/v1/sessions
POST <gateway>/v1/voice/turns
POST <gateway>/v1/voice/session-ticket
WS   wss://<gateway-host>/v1/voice/sessions
```

The VPS URL replaces the stale `10.147.17.10` vs `10.147.17.6` split. The old
failure mode was that one client was pointed at the main-machine ZeroTier IP
while another or the live gateway was on the local Mac IP, producing either
network timeouts or token 401s against the wrong process. In hosted/self-hosted
onboarding, both clients use the same stable HTTPS origin. The ZeroTier IPs stay
available only as explicit local-development choices.

## Onboarding State Machine

1. `missing_config`
   - No gateway URL is saved.
   - Client asks for the gateway URL and explains that provider keys stay on the
     gateway.

2. `stale_or_local_url`
   - URL is `10.147.17.10`, `10.147.17.6`, or an old port/path variant.
   - Client warns that this is a local/ZeroTier address and offers to replace it
     with the stable VPS URL.

3. `reachable`
   - `GET /health` returns `2xx` and `{ ok: true }`.
   - This proves only network/DNS/TLS reachability, not auth.

4. `registered`
   - The device has a per-device token bound to user id, device id, surface
     type, and a human-readable label.
   - Registration can be completed by a short code, approval URL, or manual
     token paste during the migration.

5. `authenticated`
   - A protected route succeeds with the saved token. Use `GET /v1/sessions` or
     another lightweight protected route.
   - A bad token must be shown separately from a bad URL because `/health` can
     still succeed without auth.

6. `voice_ready`
   - The gateway reports voice support in health/runtime status.
   - The client can mint a voice ticket or open an authenticated voice socket.
   - Browser microphone permission and Android microphone permission are checked
     separately from gateway voice readiness.

## Per-Device Token Flow

The target remote flow keeps client storage unchanged: URL plus token.

```text
client has stable gateway URL
  -> client asks gateway to start device registration
  -> gateway returns registration id, short code, verification URL, and expiry
  -> user signs in to the gateway UI and approves the device
  -> gateway mints a per-device token bound to user id + device id + surface
  -> client receives or the user pastes the token
  -> client replaces any bootstrap token with the per-device token
```

Device ids are client-owned and stable:

- Android: `android_<Settings.Secure.ANDROID_ID>` as already used by
  `MainActivity`.
- Browser: `browser_<uuid>` as already used by `background.js` and `options.js`.

Token requirements:

- Tokens are not provider keys and must not be shown after save.
- Tokens have labels, creation time, last-seen time, and revocation status in
  the gateway UI.
- A token authorizes one surface/device class by default. Worker tokens remain
  separate and cannot be used as device tokens.
- During migration, the single `MOA_GATEWAY_TOKEN` may seed or bootstrap the
  owner account, but remote hosted mode should prefer device tokens.

## Diagnostics

### Wrong Gateway URL

The client must identify these cases before reporting a generic network error:

| Case | Signal | Required message |
| --- | --- | --- |
| Stale main-machine URL | URL host is `10.147.17.10` | "This points at the old main-machine ZeroTier gateway. Use the VPS URL unless you are intentionally testing local dev." |
| Local Mac URL | URL host is `10.147.17.6` | "This points at the local Mac gateway. Use the VPS URL for mobile/browser onboarding." |
| Missing scheme | URL does not start with `http://` or `https://` | "Enter the full gateway URL, for example `https://api.agee.app`." |
| Endpoint path saved as origin | URL ends in `/health`, `/v1/chat`, `/v1/voice/turns`, or `/v1/voice/sessions` | "Save only the gateway origin, not an endpoint path." |
| DNS/TLS failure | Fetch fails before HTTP status | "Could not reach the gateway host. Check DNS, TLS, and the saved URL." |
| Wrong server | `/health` returns non-JSON or `{ ok: false }` | "The URL responded, but it is not a healthy Moa gateway." |
| Voice path missing | WS or ticket route returns 404 | "Gateway is reachable, but voice routes are not deployed at this URL." |

### Bad Token

The client must check auth after reachability:

| Case | Signal | Required message |
| --- | --- | --- |
| Missing token | `/health` succeeds, protected route returns 401 | "Gateway reachable, but this route requires a device token." |
| Wrong token | protected route returns 401 or 403 with a saved token | "Gateway reachable, but the saved token was rejected. Re-register this device or paste a fresh token." |
| Token for another gateway | stale/local URL plus 401 | "The token may belong to a different gateway. Confirm the stable VPS URL, then re-register." |
| Expired/revoked token | protected route returns a structured expiry/revocation code | "This device token is expired or revoked. Re-register this device." |

Clients may log token length and whether a token is set. They must not print the
token value.

### Voice Unavailable

Voice readiness is a separate diagnostic from chat readiness:

| Case | Signal | Required message |
| --- | --- | --- |
| Browser microphone blocked | extension offscreen capture fails or permission is denied | "Grant microphone access to the A.G. extension from Options or Chrome extension settings." |
| Android microphone blocked | Android permission missing | "Grant microphone permission in Android settings." |
| Ticket denied | `/v1/voice/session-ticket` returns 401/403 | "Gateway reachable, but the voice ticket was denied. Check the device token." |
| Voice route missing | `/v1/voice/session-ticket` or `/v1/voice/sessions` returns 404 | "Gateway reachable, but voice is not deployed at this URL." |
| Provider unavailable | health/runtime status reports voice provider unconfigured or unhealthy | "Gateway reachable, but voice provider is unavailable. Text chat may still work." |
| WebSocket blocked | ticket succeeds but WebSocket closes before `session_ready` | "Voice socket could not connect. Check Cloudflare WebSocket proxying, TLS, and the gateway voice route." |
| Native audio text mirror empty | audio returns without assistant text | Treat as successful audio if `turn_done` arrives; do not report a voice failure. |

## Smoke Checks

Run these against the preview/stable VPS URL before asking a user to switch
clients:

```sh
curl -fsS https://api.agee.app/health
curl -fsS -H "authorization: Bearer <device-token>" https://api.agee.app/v1/sessions
```

Browser:

```sh
cd browser_extension
AGEE_GATEWAY_URL=https://api.agee.app AGEE_GATEWAY_TOKEN=<device-token> npm run smoke:gateway
AGEE_GATEWAY_URL=https://api.agee.app AGEE_GATEWAY_TOKEN=<device-token> npm run smoke:live-voice-main
```

Android:

```sh
cd android_app
ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew assembleDebug
```

Manual Android smoke:

- Save the stable VPS URL and device token.
- Confirm setup shows gateway `Reachable` and an authenticated status once that
  source change is implemented.
- Send a typed test turn.
- Double-click-and-hold the orb, speak, release, and confirm transcript plus
  `turn_done` or a clear voice diagnostic.

## Acceptance

- A fresh browser and Android setup can point at one stable VPS URL.
- A stale `10.147.17.10` or `10.147.17.6` URL produces a specific warning, not a
  generic voice/network failure.
- `/health` success is never treated as token success.
- Bad tokens produce a re-register/fresh-token path.
- Voice failures distinguish microphone permission, auth, missing voice routes,
  provider unavailability, and WebSocket reachability.
- The same client storage shape still works: gateway URL plus device token.
