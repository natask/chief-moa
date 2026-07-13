# Voice continuity and profile repair

Run id: `20260713-voice-continuity-profile`
Base ref: `691c244` (`master`)
Branch: `agent/voice-continuity-profile-20260713`
Worktree: `/Users/natnaelkahssay/projs/chief-moa-worktrees/voice-continuity-profile-20260713`

## Outcome

Make an interrupted voice reply resumable from endpoint-observed playback,
keep Agee's configured identity separate from the underlying provider, and
turn long-answer continuation plus companion/voice-cloning direction into
bounded product contracts.

## Non-goals

- No mutation or restart of `https://api.agee.app` during diagnosis.
- No claim that queued or server-emitted audio was actually heard.
- No unbounded autonomous generation loop; continuation stays interruptible,
  resource-bounded, and observable.
- No cloning a person's or character's voice from scraped audio. Enrollment
  requires the speaker/rightsholder's authorization and consent evidence.
- No arbitrary generated companion code in Android or the extension.

## Live evidence (read-only, 2026-07-13)

- `/health` returned `ok: true`; voice activity was empty and `drain_safe: true`.
- The active pipeline was `chirp -> gateway -> gemini-tts`, with streaming
  reasoning and streaming TTS enabled.
- The effective input-language set was only `am-ET`, which cannot recognize an
  ordinary English mobile turn by contract.
- Stored profile provider fields named `vertex-live` while the effective
  runtime was cascaded; health exposed both but did not explain the drift.
- The global profile was overridden by draft companion `custom-shigmi-feel`.
- `voice_max_chars` was 260. The gateway streaming ceiling was separate.
- Interrupted turns persisted partial server-side text/audio, but clients sent
  no endpoint playback checkpoint, so the next turn could not know the point
  actually presented to the user.

## Implementation contract

1. Gateway interruption checkpoint
   - Add an additive client `playback_progress` event scoped to the active turn.
   - Persist bounded endpoint-observed PCM progress and the corresponding
     assistant-text estimate on interrupted/canceled/closed turns.
   - Include that checkpoint in the next durable context pack.
   - Treat it as endpoint-observed evidence, never proof of hearing.
2. Segment correlation
   - Streaming TTS identifies each emitted segment with stable index, text
     bounds, and PCM duration/bytes before the binary frame.
   - Old clients remain compatible and ignore the additive event.
3. Clients
   - Android and browser report a final checkpoint before cancel/close/barge-in.
   - Progress is derived from actual playback clocks where available, not from
     server-write time or the full queued duration.
4. Profile identity and health
   - Provider/model identity never overrides configured assistant identity or
     creator attribution.
   - Health/diagnosis calls out stored-provider/runtime drift and a single
     restricted input language without silently rewriting user settings.
5. Long answers
   - Record the continuation requirement and terminal reasons. Automatic
     continuation is a later bounded loop after finish-reason evidence is
     available; this unit must not fake "speak forever" by merely raising a cap.

## Acceptance

- An interrupted synthetic two-segment reply stores a checkpoint whose played
  position is before the full reply and the next context names the unheard
  suffix.
- No checkpoint may claim more PCM/text than the gateway emitted.
- A stale/cross-turn progress event is rejected without mutating another turn.
- Existing clients and existing voice-session tests remain green.
- Identity tests prove "who created you" is answered from profile ownership,
  never Google/Gemini/provider identity.

## Verification

```sh
cd gateway && npm run check && npm run smoke:live-interrupt-handoff && node scripts/smoke-cascaded-voice.js && npm run eval:voice
cd browser_extension && npm run verify && npm run smoke
cd android_app && ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew assembleDebug
```

OpenSpec validation runs when the CLI is initialized. Live provider and phone
QA remain separate evidence and are not inferred from deterministic smokes.

## Ledger

- 2026-07-13: created isolated worktree from `master`.
- 2026-07-13: completed read-only production health diagnosis; no active state
  was changed.
- 2026-07-13: implementation pending.
