# Voice Pipeline Agent Orchestration

Run id: `20260708-voice-pipeline-agent-orchestration`
Base ref: `a130637` on `master`
Date: 2026-07-08

## Outcome

Investigate and improve the voice/audio pipeline where long generated text can
break audio delivery, make failures visible in self-hostable logs/events, and
turn the user's broader direction into concrete product contracts for low
latency, runtime configuration, voice sampling, gestures/shortcuts, and cache
friendly per-turn context.

## Live App Risk

The production gateway is `https://api.agee.app` on the VPS. Do not restart or
mutate the active service during investigation. Work happens in isolated
branches/worktrees. Promotion requires gateway verification, preview or smoke
evidence, rollback evidence, no active voice/session interruption, and persisted
state compatibility.

## Verification Gate

Primary gateway gate:

```sh
cd gateway && npm run check
```

Voice-specific gates when gateway voice code changes:

```sh
cd gateway && node scripts/smoke-cascaded-voice.js && npm run eval:voice
```

Docs/OpenSpec gate:

```sh
openspec validate <change-id> --strict
```

Run only if the CLI is initialized in this checkout; otherwise inspect
structure and record the blocker.

## Lanes

1. `current-voice-diagnosis`: read-only live/local evidence lane for the
   current "voice is broken on long text" symptom.
2. `voice-observability`: code-changing gateway lane for voice stage logs,
   provider events, errors, and stage latency evidence.
3. `latency-streaming-research`: read-only source and spec audit for the
   sub-100 ms time-to-first-audio goal and current streaming-cascaded tasks.
4. `stt-incremental-prechunk`: read-only/product lane for continuous
   utterance chunking and partial STT before final commit.
5. `tts-long-output-reliability`: read-only/source lane for long generated
   text, TTS caps, chunking, retries, and degradation.
6. `interrupt-context-memory`: read-only lane for preserving already-spoken
   assistant output after interruption.
7. `agent-config-profile`: read-only contract audit for user-editable
   configurations, modes, voice/speed/language/profile tools, and voice
   sampling.
8. `gestures-shortcuts`: read-only browser/Android shortcut and gesture
   feasibility research, especially Chrome command key constraints.
9. `cache-context-design`: read-only design audit for stable system prompts,
   per-turn volatile context, surface skills, and cache-friendly context packs.
10. `test-strategy-voice`: read-only test planning lane for deterministic and
    live voice verification.
11. `deploy-safety-rollback`: read-only release lane for preview, rollback,
    backup/restore, and active-session interruption gates.
12. `observability-backend-research`: read-only research lane for self-hostable
    logs/events/traces that agents can query without Datadog lock-in.
13. `product-contract`: docs/OpenSpec lane for capturing the user's direction as
   durable requirements and implementation tickets.

## Merge Notes

- Main orchestrator integrates serially.
- Subagent self-reports are not proof; rerun verification locally after merge.
- Gateway code changes and architecture/OpenSpec changes must agree before
  commit.
- Do not deploy from a dirty tree.
