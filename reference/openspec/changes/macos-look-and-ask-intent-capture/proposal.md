# macOS Look & Ask Intent Capture

## Status

Proposed as a narrow Mac capture milestone. This change authorizes specification
only. It does not authorize source implementation, native action execution, an
agent run, or deployment.

## Why

The native Mac companion can already be summoned for voice and can separately
manage privacy-scoped Accessibility and focused-window capture. The missing
everyday loop is deliberate situated asking: while another app is frontmost,
the user summons Ag, chooses whether to attach the exact visible app/window
context, reviews what will leave the Mac, and files what they said plus that
evidence as one durable intent.

Without a narrow contract, the summon could accidentally inherit a proactive
observation grant, capture a window after focus has moved to Ag, or turn screen
content into action or implementation authority.

## What Changes

- Define **Look & Ask** as an explicit, one-turn activity invoked while the
  source application is frontmost. Invocation records that exact app/process
  generation and focused-window identity before Ag takes focus.
- Keep **Attach context** off by default for every turn. Enabling it is an
  explicit current-turn choice, not a remembered grant and not inherited from
  the proactive macOS surface.
- When attachment is enabled, collect one bounded, locally redacted AX snapshot
  for the bound app/window. A focused-window screenshot is a second, independent
  off-by-default choice.
- Show a review surface containing the transcript, source app/window identity,
  exact redacted semantic evidence, redaction/truncation report, and optional
  screenshot metadata/preview before submission.
- Mark the evidence stale and block submission if the frontmost app, process
  generation, or focused window changes after binding. The user must recapture
  or submit without context.
- Submit the user-owned transcript and approved evidence refs as one durable,
  non-executable intent. Capture alone starts no action, agent run, code change,
  deployment request, release switch, or promotion.

## Capability

### New Capability

- `macos-look-and-ask-intent-capture`: explicit current-turn Mac transcript and
  evidence capture, preview, freshness binding, and durable non-executable
  intent submission.

## Related Contracts

- `privacy-first-macos-surface` owns AX/ScreenCaptureKit grants, local bounds,
  redaction, exact release preview, and native proposal/action boundaries.
- `macos-clicky-parity-surface` owns the singleton summon panel, microphone
  lifecycle, gateway connection, and inert reply presentation.
- `in-app-modification-requests` establishes that captured screen context and
  derived interpretations are evidence rather than repository or execution
  authority.
- `durable-intent-delivery-pipeline` supplies the canonical durable intent
  identity and prevents an intent, task, run, candidate, or release fact from
  standing in for a later lifecycle fact.

## Non-Goals

- No ambient observation, proactive suggestion loop, background screenshot, or
  remembered attach-context default.
- No whole-desktop capture, coordinate input, synthetic keyboard/mouse input,
  Apple Events, or private frameworks.
- No native AX action proposal, approval, execution, or receipt implementation.
- No automatic task creation, worker claim, agent launch, code edit, commit,
  preview, deployment, promotion, or completion claim.
- No change to shared `ARCHITECTURE.md` until implementation is authorized and
  architecture-significant behavior actually lands.
