## 1. Typed companion loop

- [x] 1.1 Add bounded canonical `/v1/chat` request and inert reply decoding.
- [x] 1.2 Share the gateway origin and Keychain token between the command
      surface and the existing screen-context settings.
- [x] 1.3 Add the menu-bar shell, global summon shortcut, compact command panel,
      loading/error/reply states, and Escape dismissal.
- [x] 1.4 Prove typed turns contain no AX or screenshot evidence and redirects,
      invalid origins, oversized input, oversized responses, and missing tokens
      fail closed.

## 2. QA artifact

- [x] 2.1 Build and test `MoaMac`, scan for packaged destinations/provider
      credentials, and create a versioned ad-hoc-signed ZIP plus SHA-256.
- [x] 2.2 Add macOS CI for the exact build/test/package/scan path.
- [ ] 2.3 Install the QA bundle only when it will not disturb an existing app or
      TCC identity; otherwise record the installation blocker and artifact.

## 3. Parity stages

- [ ] 3.1 Add ticketed `WS /v1/voice/sessions` push-to-talk and gateway audio
      playback without local provider keys.
- [ ] 3.2 Add shared Aggie thread/history/run event presentation.
- [ ] 3.3 Add visual pointer/caption guidance as inert overlays.
- [ ] 3.4 Complete semantic AX proposal validation, approval, execution, and
      durable receipts from `privacy-first-macos-surface`.
- [ ] 3.5 Produce a Developer ID-signed, hardened, notarized, stapled universal
      artifact with rollback and isolated TCC evidence.
- [ ] 3.6 Add explicit local subscription-harness adapters and self-host
      provisioning without extracting vendor CLI OAuth tokens.
