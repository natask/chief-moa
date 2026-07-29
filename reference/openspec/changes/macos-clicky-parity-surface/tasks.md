## 1. Typed companion loop

- [x] 1.1 Add bounded canonical `/v1/chat` request and inert reply decoding.
- [x] 1.2 Share the gateway origin while keeping each entered token
      session-only and clearing it on explicit disconnect/stop.
- [x] 1.3 Add the menu-bar shell, global summon shortcut, compact command panel,
      loading/error/reply states, and Escape dismissal.
- [x] 1.4 Prove typed turns contain no AX or screenshot evidence and redirects,
      invalid origins, oversized input, oversized responses, and missing tokens
      fail closed.
- [x] 1.5 Add a static Apple-source gate that rejects credential persistence
      APIs, service labels, and generic-password commands.
- [x] 1.6 Replace the pasted gateway token with browser-backed Ag device sign-in
      and one narrowly scoped macOS Keychain session item.

## 2. QA artifact

- [x] 2.1 Build and test `Ag`, scan for packaged destinations/provider
      credentials, and create a versioned ad-hoc-signed ZIP plus SHA-256.
- [x] 2.2 Add macOS CI for the exact build/test/package/scan path.
- [ ] 2.3 Install the QA bundle only when it will not disturb an existing app or
      TCC identity; otherwise record the installation blocker and artifact.

## 3. Voice invocation

- [x] 3.1 Add ticketed `WS /v1/voice/sessions` literal voice capture without
      local provider keys.
- [x] 3.2 Make app launch and global summon open the one compact panel directly
      in latched capture; a second summon commits, while Escape cancels before
      hiding.
- Acceptance: one explicit launch/summon produces one visible capture surface,
  repeating the summon commits the same turn, and no active capture becomes
  hidden.

## 4. Later parity stages

- [x] 4.1a Add a bounded authenticated recent-session history view backed only
      by the canonical gateway projection.
- [ ] 4.1b Add full shared Aggie thread/run event and audio-attachment
      presentation.
- [x] 4.1c Add local PCM-derived waveform feedback alongside existing live
      partial/final transcript presentation.
- [ ] 4.2 Add visual pointer/caption guidance as inert overlays.
- [ ] 4.3 Complete semantic AX proposal validation, approval, execution, and
      durable receipts from `privacy-first-macos-surface`.
- [ ] 4.4 Produce a Developer ID-signed, hardened, notarized, stapled universal
      artifact with rollback and isolated TCC evidence.
- [ ] 4.5 Add explicit local subscription-harness adapters and self-host
      provisioning without extracting vendor CLI OAuth tokens.
