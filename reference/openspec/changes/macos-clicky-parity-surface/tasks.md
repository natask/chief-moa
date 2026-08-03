## 1. Typed companion loop

- [x] 1.1 Add bounded canonical `/v1/chat` request and inert reply decoding.
- [x] 1.2 Share the gateway origin while keeping each entered token
      session-only and clearing it on explicit disconnect/stop.
- [x] 1.3 Add the menu-bar shell, global summon shortcut, compact command panel,
      loading/error/reply states, and Escape dismissal.
- [x] 1.4 Prove typed turns contain no AX or screenshot evidence and redirects,
      invalid origins, oversized input, oversized responses, and missing tokens
      fail closed.
- [x] 1.5 Add a static Apple-source gate that rejects platform credential-store
      APIs, legacy service labels, generic-password commands, and provider keys.
- [x] 1.6 Replace the pasted gateway token with browser-backed Ag device sign-in
      and one narrowly scoped portable Ag auth file (`AG_HOME/auth.json`,
      default `~/.ag/auth.json`) with owner-only permissions.
      Both the Mac connection card and browser approval page must visibly
      distinguish waiting, approved, connected, denied, expired, and failed
      states; browser approval alone is not a completed Mac connection.
      Source acceptance requires the production image to include the Better
      Auth runtime and migrations, Compose to pass its bounded configuration,
      and an isolated device-flow smoke. Active acceptance additionally requires
      `api.agee.app` to report Better Auth enabled and a real Mac device session
      to authenticate both a protected read and a voice ticket.

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
- [x] 3.3 Request assistant-voice delivery, render streamed assistant text, and
      play bounded gateway PCM audio through the native output device.
- [x] 3.4 Make summon and the microphone control toggle capture, with a visible
      active boundary/pulse and native haptics but no repetitive cue sounds.
- [x] 3.5 Route the double-Command macOS helper directly to `Ag.app` without
      raising Chrome or attaching browser, Accessibility, or pixel context.
- [x] 3.6 Attach the compact panel to the notch/menu-bar edge, keep Cancel left
      and Finish right of the current-turn content, retain the submitted user
      text, wrap the full reply, and expose microphone denial recovery without
      implying Screen Recording is required for dictation.
- Acceptance: one explicit launch/summon produces one visible capture surface,
  repeating the summon commits the same turn, and no active capture becomes
  hidden.

## 4. Later parity stages

- [x] 4.1a Keep durable history gateway-owned and out of the compact Mac island;
      the island presents only the current submitted message and reply.
- [ ] 4.1b Add full shared Aggie thread/run event and retained audio-attachment
      presentation beyond the live assistant reply.
- [x] 4.1c Add local PCM-derived waveform feedback alongside existing live
      partial/final transcript presentation.
- [x] 4.1d Add a movable Clicky-style Agents workspace and an all-Spaces parked
      agent rail backed by bounded gateway run summaries. Include project
      search, running/recent status, selected-run detail, refresh, and stop.
      Keep full event timelines, artifact actions, and retained audio under
      4.1b.
- [x] 4.1e Make the panel content-sized at rest, hover-expanded, and interaction-
      pinned until explicit collapse, Hide, or Escape. Verify compact and Agents
      states with offscreen bitmap snapshots that never open a QA window.
- [ ] 4.2 Add visual pointer/caption guidance as inert overlays.
- [ ] 4.3 Complete semantic AX proposal validation, approval, execution, and
      durable receipts from `privacy-first-macos-surface`.
- [ ] 4.4 Produce a Developer ID-signed, hardened, notarized, stapled universal
      artifact with rollback and isolated TCC evidence.
- [ ] 4.5 Add explicit local subscription-harness adapters and self-host
      provisioning without extracting vendor CLI OAuth tokens.
