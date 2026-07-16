# Voice-First Orb Gestures

## Why

The browser mascot's cheapest gestures must make voice predictable. The prior
implementation left the intended interaction behind an off-by-default setting,
used a different review-draft contract, and allowed microphone setup failures to
look like gesture navigation. That made the implemented behavior difficult to
exercise and easy to misdiagnose.

Android retains its separately staged reviewable-draft behavior until an
Android-specific product revision is accepted and verified. This change makes
the browser contract explicit without changing Android.

## Accepted Browser Contract (2026-07-16)

- First single click starts a non-auto-committing capture in the current thread;
  the next single click stops and sends it exactly once.
- Double-click starts a fresh-thread capture while prior provider generation may
  continue with its device audio suppressed.
- Either a single click or another double-click stops and sends that fresh-thread
  capture exactly once.
- Triple-click opens chat without cancelling active capture or provider work.
- A still hold remains push-to-talk and release sends.
- Drag still repositions the mascot.
- The mapping is canonical browser behavior. It has no experimental flag,
  user-visible gesture setting, click-to-type fallback, migration preference, or
  review-draft side controls.
- Microphone failure remains visible in the active surface. Options opens only
  after the user chooses the explicit microphone-recovery action.

The browser owns gesture detection and local capture state. The existing gateway
voice and fresh-thread contracts are reused unchanged.

## Settings Boundary

An ordinary product request SHALL NOT create a setting or hidden preference.
The removed `ageeVoiceFirstGesturesEnabled` key is not part of the current
contract. Experiment rollout controls, when needed, are operator/release policy
rather than end-user settings unless the user explicitly asks for a setting.

## Separate Follow-Up: Clean Voice Into The Current Text Field

Speaking rough text, cleaning it, and inserting it into the currently focused
field is distinct from sending an agent turn. The destination surface must own
focus validation and insertion, the gateway may only propose cleaned text, and
insertion must never imply submit, click, or form completion. Its invocation
gesture remains unresolved.

## Non-Goals

- No Android gesture or default change in this browser unit.
- No removal of chat; triple-click keeps it reachable.
- No change to Cmd+./Cmd+, gateway voice-session protocol, or providers.
- No new browser gesture setting or feature flag.

## Verification

- `cd browser_extension && npm run verify && npm run smoke`
- Strict OpenSpec validation for this change.
- Manual browser QA: single starts current capture and the next single sends;
  double starts fresh capture and either single or double sends; triple opens
  chat without cancelling work; hold-release sends; a microphone error stays in
  place until the explicit recovery action is selected.
