# Mobile voice failure incident

## Scope

This incident evaluates the recurring generic Android overlay message that a
voice turn failed. The production inspection used only turn identifiers,
timestamps, source, status, byte/chunk counts, provider-event types, bounded
error summaries, and stage labels. It did not read audio or transcript content.

## Affected surface and version

- Confirmed affected client source: `android-overlay`.
- The same server-side defect also appears for `agee-extension`.
- Production gateway checkout and container source:
  `0c4b3899befb72794573972a7e71e60abd6629d1`.
- There is no iOS client in this checkout, so iOS is not evaluated.
- No Android device was attached during this investigation. Installed Android
  app version and real-device reproduction therefore remain unmeasured.

## Production evidence

From 2026-07-03 through 2026-07-26, the self-hosted voice metadata contained
1,273 turns and 114 records whose final stored status was `error`.

The most common attributable Android error was a `processing` stage error with
summary `websocket is not open` (22 records). Recent examples occurred on
2026-07-14, 2026-07-16, and 2026-07-21. Those records had already stored user
audio and, in the observed event order, frequently contained successful STT,
reasoning, TTS, assistant output, and `turn_completed` before the later
`stage_error` and `turn_error`.

Other independently real failures remain:

- two Android recordings exceeded the synchronous Chirp 60-second limit;
- several reasoning calls reached the 45-second timeout;
- one STT operation was aborted;
- one TTS request was rejected by the provider.

The fix in this change addresses only the false terminal rewrite. It does not
claim to repair those separate provider and duration failures.

## Root cause

`completeTurnWithProviderResult` durably recorded `completed`, then emitted
`turn_done` with a throwing WebSocket send. If the phone or extension closed
after receiving assistant output but before that final receipt, `sendEvent`
rejected with `websocket is not open`. The outer committed-turn catch then ran
`failCommittedTurn`, overwriting the already-completed turn as `error` and
adding false processing-failure telemetry.

This is a server lifecycle race, not a microphone-permission, upload, auth,
capture, STT, reasoning, TTS, or rendering failure for the affected records.
The stored audio byte counts exclude capture failure for those samples, and the
successful stage events exclude the provider stages that had already completed.

## Correction

- Terminal completion and no-speech receipts use the existing best-effort
  `sendTurnDone` path after durable persistence.
- `failCommittedTurn` refuses to mutate a turn that already has a terminal
  status.
- A real WebSocket regression closes immediately after `assistant_text` and
  asserts the metadata remains `completed`, contains `turn_completed`, and
  contains no false `websocket is not open` fault.

## Remaining evidence gaps

- Client-only failures before gateway admission are not represented in the
  server turn store.
- Android logcat has correlation IDs, but there was no attached phone from
  which to collect a failing invocation.
- Real-device permission, audio-session interruption, backgrounding, and
  lifecycle QA therefore remain required.
- The correction requires independent review and guarded deployment before it
  can be called shipped.
