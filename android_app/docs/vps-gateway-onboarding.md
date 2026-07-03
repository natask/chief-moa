# VPS Gateway Onboarding - Android

## Target Setup

Android should point at one stable gateway origin:

```text
https://api.agee.app
```

For self-hosting, use the same shape with your domain:

```text
https://api.<your-domain>
```

Do not use the old ZeroTier addresses for hosted/VPS onboarding:

- `http://10.147.17.10:8787` was the main-machine gateway default.
- `http://10.147.17.6:8787` is the local Mac dev gateway.

Those IPs are useful only when intentionally testing on a local/ZeroTier
gateway. The VPS URL replaces the "which 10.147 address is live?" failure mode
with one HTTPS endpoint reachable by both phone and browser.

In Android source, `MoaPrefs.ONBOARDING_GATEWAY_URL` is the visible hosted
onboarding origin and `MoaPrefs.DEFAULT_GATEWAY_URL` currently points to it.
Local/ZeroTier gateway URLs remain explicit developer choices, not implicit
defaults.

## What The App Stores

The Android app stores only:

- Gateway URL
- Gateway token
- Local preferences such as conversation id, language/profile cache, and spoken
  replies

It must not store provider keys, account passwords, worker tokens, or harness
credentials.

When the app finds an old tokenless seeded main-machine default such as
`http://10.147.17.10:8787`, it migrates that saved URL to the hosted onboarding
origin. If a token is already saved, the URL is left alone because it may belong
to an intentional local gateway.

## First Run Flow

1. Open A.G. on the phone.
2. Grant overlay permission.
3. Grant microphone permission.
4. Grant Screen access if screen context or local actions are needed.
5. Save the stable gateway URL.
6. Register the phone or paste the per-device token.
7. Tap `Start assistant circle`.
8. Send a typed test turn.
9. Double-click-and-hold the orb, speak, release, and confirm the transcript or
   a specific voice diagnostic.

Until device registration is implemented, the migration path is manual token
paste. The final flow should let the app show a short code or verification URL,
then replace the bootstrap token with a per-device token after gateway approval.

## Required Diagnostics

### Wrong URL

The setup screen should classify the saved URL before running health:

- `10.147.17.10`: old main-machine ZeroTier gateway. Use the VPS URL unless this
  is intentional local testing.
- `10.147.17.6`: local Mac dev gateway. Use the VPS URL for phone onboarding.
- Missing scheme: enter the full URL, for example `https://api.agee.app`.
- Endpoint path saved: save the origin only, not `/health` or
  `/v1/voice/sessions`.
- DNS/TLS failure: gateway host is unreachable; check DNS, TLS, and the saved
  URL.

### Bad Token

`GET /health` proves reachability only. A bad or missing token can still pass
health and then fail during chat, profile, OTA, or voice.

After health succeeds, Android should run a lightweight protected auth probe,
such as `GET /v1/sessions`, with the saved bearer token.

Expected messages:

- Health fails: "Gateway unreachable at this URL."
- Health succeeds but auth returns 401 without a token: "Gateway reachable, but
  a device token is required."
- Health succeeds but auth returns 401/403 with a token: "Gateway reachable, but
  this token was rejected. Re-register this phone or paste a fresh token."
- URL is stale/local and auth fails: "The token may belong to a different
  gateway. Confirm the VPS URL, then re-register."

### Voice Unavailable

Voice should be diagnosed separately from text chat:

- Android microphone permission missing: grant microphone permission.
- Voice WebSocket 401/403: token rejected for voice.
- Voice WebSocket 404: gateway reachable, but voice routes are not deployed at
  this URL.
- WebSocket timeout or pre-open close: check Cloudflare WebSocket proxying, TLS,
  and the gateway voice route.
- Gateway provider unavailable: text chat may work, but the voice provider is
  not configured or healthy.

Native-audio providers may return assistant audio without assistant text. That
is not a failure if the turn receives audio and `turn_done`.

## Android Smoke Check

Terminal checks:

```sh
curl -fsS https://api.agee.app/health
curl -fsS -H "authorization: Bearer <device-token>" https://api.agee.app/v1/sessions
cd android_app
ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew assembleDebug
```

Manual phone checks:

- Save `https://api.agee.app` and the device token.
- Confirm setup reports gateway reachable.
- Confirm the authenticated check reports token valid once implemented.
- Tap the orb, send a typed `test` turn, and confirm a gateway reply.
- Double-click-and-hold, speak, release, and confirm final transcript plus
  `turn_done` or a clear voice diagnostic.

Debug log focus:

```sh
adb logcat -s MoaVoiceSocket
```

Expected voice setup logs should show the redacted WSS URL and whether a token
is set by length only. They must not print the token value.

## Source Follow-Ups

- `MoaPrefs.java`: add build-time generation if hosted/self-hosted release
  variants need different defaults.
- `MoaVoiceGatewaySocket.java`: consider moving Android to the same one-use
  `/v1/voice/session-ticket` flow as browser voice before hosted mode.
- `MainActivity.java`: add URL classification, auth probe after health, and a
  registration path using the existing Android device id.
