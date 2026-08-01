# macOS Companion Parity Surface

## Why

`Ag.app` already proves a privacy-scoped Accessibility observation and
focused-window capture boundary, but it is not yet an everyday companion. The
next product slice needs the interaction that makes Clicky useful: a quiet
menu-bar application, a system-wide summon gesture, a compact command surface,
and immediate replies from the same user-owned Chief Moa gateway used by the
other surfaces.

## What Changes

- Turn `Ag` into a menu-bar application with no persistent Dock presence.
- Add a global `Control+Space` summon shortcut and one compact floating command
  panel for voice capture and typed turns. App launch and first summon begin
  latched capture; the next summon commits it.
- Render gateway assistant text and play its bounded hosted PCM reply in that
  same panel. Keep capture state obvious with a boundary pulse and native
  haptic feedback, without repetitive interface cue sounds.
- Persist only the non-secret configured gateway origin. Keep the bearer token
  in process memory for the current app session, default it to empty, and clear
  it on disconnect or termination. Raw provider credentials and
  consumer-subscription tokens never enter the app.
- Send typed turns to the existing authenticated `POST /v1/chat` contract and
  render returned text as inert presentation data.
- Keep screen/Accessibility evidence completely separate. A normal command
  turn attaches no screen data unless a future, explicitly approved contract
  adds it.
- Preserve distinct Moa/Aggie branding and use OpenClicky only as MIT-licensed
  behavioral prior art. Do not copy proprietary Clicky assets, prompts,
  credentials, telemetry, routes, or binary implementation.

## Milestone

The first artifact is a private QA application. It proves the daily typed and
assistant voice companion loop against a configured self-hosted or hosted
gateway. Full session-event history, semantic actions, signed universal
distribution, and conversational self-host provisioning remain separately
reviewable stages.
