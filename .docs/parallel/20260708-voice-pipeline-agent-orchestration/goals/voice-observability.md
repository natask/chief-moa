# Goal: voice-observability

Branch: `agent/voice-observability`
Worktree: `/Users/natnaelkahssay/projs/chief-moa-worktrees/voice-observability`

## Goal

Make the gateway voice pipeline easier for agents to diagnose when long
assistant replies or TTS generation break. Prefer existing event substrate,
provider-event records, and structured logs over introducing Datadog or a
hosted-only dependency.

## Target Files

- `gateway/lib/voice-providers.js`
- `gateway/lib/voice-session-server.js`
- `gateway/server.js`
- `gateway/scripts/smoke-cascaded-voice.js`
- `gateway/scripts/smoke-voice-session-events.js`
- supporting gateway tests/scripts only if needed

## Acceptance Criteria

- Voice stage failures emit structured evidence with turn/session/provider
  identifiers and a bounded error summary.
- Stage timing is queryable or visible in existing provider-event/event
  substrate records for STT, reasoning, TTS, first audio, and completion.
- Long-response TTS faults degrade to text or a clear `turn_done` error instead
  of silent breakage.
- Tests or smoke coverage prove the new evidence path.

## Verification

```sh
cd gateway && npm run check
node scripts/smoke-cascaded-voice.js
```

## Do Not Touch

- Android app files.
- Browser extension files.
- OpenSpec docs, except if a code behavior change strictly requires a small
  matching note. Prefer leaving docs to the product-contract lane.
- `.env` files.

## Live App Constraints

No active gateway restart. No provider keys in logs. No raw audio or transcript
dumping in logs unless an existing retention/event path already stores it under
the user's configured retention policy.

