# Voice-First Orb Gestures (Experimental)

## Why

The product goal is a voice-driven interface: speaking alone gets things done.
Today the cheapest orb gesture (single click) opens the typed chat surface, and
push-to-talk costs a double-click plus a hold on both surfaces. The user
proposed inverting that: promote voice gestures one tier up, demote chat to
triple click, and remove chat from the primary position over time. Assessment
and gesture contract: `scratch/agent-loop/voice-first-orb-gestures-20260706.md`.

## What Changes

Behind an experimental flag, off by default, one contract on both surfaces:

- Single tap: interrupt. Stops assistant speech immediately (fires on first
  tap-up with no double-tap deferral), then dismisses the open panel if no
  further tap follows. Never opens chat.
- Single press-and-hold, still: push-to-talk. Mic warms at press-down where the
  surface supports it; release commits the turn. Movement past the drag slop
  before the hold threshold stays a drag.
- Double-click, quick: toggle talk mode. Browser: one conversation session
  (silence commits each turn, mic re-arms after the reply) with a visible amber
  ring on the mark while on. Android: the existing continuous voice loop with a
  visible orb listening state.
- Triple click: opens the chat/text surface (demoted, still reachable).
- Drag and (browser) wheel resize: unchanged.

Flags:

- Browser: `ageeVoiceFirstGesturesEnabled` in `chrome.storage.local`, checkbox
  under Experimental in options.
- Android: `MoaPrefs` boolean `voice_first_gestures`, toggle in the settings
  app.

## Non-Goals

- No chat removal yet; triple click keeps it reachable.
- No change to the Cmd+./Cmd+, hotkeys (they already match the proposed shape).
- No gateway, voice-session protocol, or provider changes.
- No default-on flip; that decision follows the experiment.

## Boundaries

- Android and the browser extension own gesture detection and local UI state.
- The gateway voice contract is reused untouched.
- With the flag off, both surfaces keep the legacy contract byte-for-byte.

## Verification

- Browser extension: `cd browser_extension && npm run verify && npm run smoke`.
- Android: `cd android_app && ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew assembleDebug`.
- Manual QA per surface with the flag on: hold-to-talk release commits,
  double-click toggles with visible state, triple click opens chat, single
  click interrupts; flag off restores today's behavior.
