# Device-Reachable Preview Evidence — 2026-07-23

## Candidate

- Coordinating branch: `feat/device-preview-delivery-20260723`
- Gateway candidate: `421ca1d4667a6a1c8d4ae4e5984af9586515c13d`
- Dictation boundary fix: `7dc9de68`
- Preview delivery and observability: `421ca1d4`
- Stable gateway before promotion: `c0572df2fc9e9449ade983ec307e89e173ce24ec`
- Verified stable ref before promotion: `3af1a798f86cc5d55c1f75b32b21fc87687edda2`

## Gateway Preview

- State: published, persistent, isolated, and smoke-tested.
- Device URL: `http://10.0.0.229:8791`
- Credential path: `/private/tmp/chief-moa-gateway-preview-8791/gateway.token`
- Isolated state: `/private/tmp/chief-moa-gateway-preview-8791/data`
- Rollback: stop the preview launch service; stable `https://api.agee.app` is
  unchanged.
- Verification: full `gateway npm run check` passed. Health, unauthenticated
  rejection, and a real Vertex model turn passed on the exact candidate SHA.
- Live dictation QA: session `qa_dictation_fixed_en_mrykcazs`, turn
  `turn_mrykcazs`. The English transcript was exact. The 3.67-second fixture
  completed in 3.281 seconds, including 3.067 seconds in Chirp 3 STT.
- Cost boundary: one Chirp 3 STT operation, zero Gemini/reasoner operations,
  zero TTS operations, zero assistant text/audio/actions, and no generated
  conversation or model-turn record.
- Language provenance: both the canonical turn and inert capture block retain
  `en-US` and `am-ET`. The checked-in Amharic tone fixture was not submitted as
  speech QA.

## Android Preview

- State: published on the LAN and waiting for physical-phone install/QA.
- Install QR: `/private/tmp/moa-android-preview-YiSdY0/install-preview-qr.png`
- Server: `http://10.0.0.229:41739`
- Credential path: `/private/tmp/moa-android-preview-YiSdY0/bearer-token`
- Release: `ai.moa.assistant-1784873061`
- Version: `0.1.1784873061-preview`
- APK SHA-256:
  `76c60747e4f2b50f2a0372279c704de08d42304ec9a30a91a2770b4e2ed933a5`
- Signer SHA-256:
  `8f0b62c73777a961687041f6faac24597830127d1f0ca9841aa6f7c70fe6ae0d`
- Source: `3af1a798`; the later candidate commits do not change Android app
  sources.
- Verification: continuity signing, v2 signature, zip alignment, manifest/APK
  digest agreement, authenticated download, full `check assembleDebug`, and
  preview-server authentication smoke passed.
- Rollback: uninstall the preview candidate or reinstall the previous stable
  OTA artifact. Stable OTA files were not changed.

## Browser And macOS Preview

- Browser extension: version `0.1.87`.
- Package:
  `browser_extension/dist/A.G.-0.1.87.zip`
- Package SHA-256:
  `fbd84ee999d4f72c364d8d30eea9d99f8193c2daa2213e954ab52fcc56013206`
- Verification: all 133 extension tests passed, real Chrome smoke passed, the
  package was created, and the loaded unpacked extension reload was confirmed.
- Isolated Chrome QA against the LAN preview passed health, authenticated
  browser/voice turns, and generated-speech voice behavior.
- macOS invocation: the repository Karabiner rule is installed in both local
  profiles; double Command maps to Command-Shift-9, and Chrome owns that
  extension shortcut.
- Daily Chrome remains on `https://api.agee.app`. Switching its extension
  credential requires either manual Options entry or explicit permission for
  Accessibility and clipboard automation.
- Physical shortcut, microphone, and paste-target QA remain a user/device check.

## Stable Promotion

- GitHub previously published `3af1a798` to `vps-deploy`, but the active VPS
  remained on `c0572df2`. The pull worker therefore did not apply the verified
  ref.
- This candidate adds exact live-SHA observation after publication and a manual,
  read-only VPS worker audit.
- Stable promotion is blocked until DigitalOcean console access or restricted
  SSH ingress can repair or prove the timer worker. No active gateway process,
  persisted gateway state, or stable OTA artifact was changed by these previews.
