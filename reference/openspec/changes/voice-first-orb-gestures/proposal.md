# Voice-First Orb Gestures (Experimental)

## Why

The product goal is a voice-driven interface: speaking alone gets things done.
Today the cheapest orb gesture (single click) opens the typed chat surface, and
push-to-talk costs a double-click plus a hold on both surfaces. The user
proposed inverting that: promote voice gestures one tier up, demote chat to
triple click, and remove chat from the primary position over time. Assessment
and gesture contract: `scratch/agent-loop/voice-first-orb-gestures-20260706.md`.

## What Changes

Behind an experimental flag, off by default, one contract on both surfaces
(v2, approved 2026-07-06 after the v1 trial mapping):

- Single click/tap: talk toggle with barge-in. If idle, it arms hands-free
  talk mode immediately (starting the turn stops any playing assistant
  audio; that is the interrupt). If already listening, the click means "send
  and end talk mode", deferred by the double-click window so a double click
  can supersede it. A tap-armed turn that captured no speech disarms quietly
  with no "didn't catch that" cue, so a silent tap doubles as "shut up".
  Talk mode shows a visible active state (browser: amber ring; Android:
  listening rim).
- Single press-and-hold, still: push-to-talk. Mic warms at press-down where
  the surface supports it; release commits the turn. Movement past the drag
  slop before the hold threshold stays a drag, and a large movement after the
  hold confirms cancels the capture and escapes into a drag (hold-then-move
  muscle memory).
- Double-click, quick: opens the chat/text surface (demoted, still
  reachable). If the first click armed the mic milliseconds earlier, that
  session is cancelled; if it deferred a send, the send is cancelled and talk
  mode stays on.
- Triple click and beyond: nothing.
- Drag and (browser) wheel resize: unchanged.

The v1 trial mapping (single tap = interrupt, double = talk toggle, triple =
chat) is superseded; interrupt folded into the tap-toggle's barge-in.

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
- Manual QA per surface with the flag on: single click arms talk mode with a
  visible active state and a second click sends, a silent tap disarms
  quietly, hold-to-talk release commits and a big mid-hold move becomes a
  drag, double-click opens chat; flag off restores today's behavior.
