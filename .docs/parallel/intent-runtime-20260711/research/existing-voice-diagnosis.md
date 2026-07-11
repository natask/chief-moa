# Existing Chief Moa voice diagnosis: reuse before rebuilding

Inspected: 2026-07-11. This is a read-only inventory of the current gateway,
not a claim that the desired daily operations product is complete.

## What already exists

Chief Moa already has a meaningful first failure-attribution layer:

- authenticated `GET /v1/voice/diagnosis` for a bounded session/turn query;
- conservative attribution across capture, transport, context, STT, reasoning,
  TTS, playback emission, and archive storage;
- one ordered primary fault plus explicit `unknown` evidence gaps, rather than
  inventing a root cause;
- stage timings, provider/model metadata, audio existence/size checks, and
  canonical-turn/voice-session reconciliation;
- an allowlisted, bounded diagnostic event view that removes transcript and
  assistant text and redacts secret-like values;
- deterministic anti-gaming, reasoning, TTS, storage, no-speech, context-fault,
  auth, and query-bound tests in `gateway/test/voice-diagnosis.test.js` and
  `gateway/scripts/smoke-voice-diagnosis.js`.

This means “at least tell me what failed” is not a greenfield idea. The current
endpoint can already answer it for one known session or turn.

## The actual missing product

The gap is the temporal and operational layer above per-turn diagnosis:

1. enumerate recent owned turns across sessions without unbounded filesystem
   scans;
2. group stable failure signatures and distinguish new, recurring, worsening,
   recovered, and insufficient-evidence cases;
3. calculate bounded latency distributions and tail regressions by stage,
   release, provider, and surface without putting user/high-cardinality data in
   metric dimensions;
4. join diagnoses to canonical intent, code revision, deployment, CI evidence,
   repair proposal, and repair result;
5. persist a versioned brief with source receipts and a watermark so a retry is
   deterministic and an agent cannot silently rewrite history;
6. deliver the brief on a chosen schedule/channel independently of the brief's
   durable record.

## Reuse decision

Do not replace the conservative attribution functions with a generic trace
backend. Extract or wrap them behind a bounded diagnosis interface after the
canonical intent/voice integration is stable. The first daily brief should be
deterministic from owned evidence; an LLM may explain or propose a repair only
after the grouped facts, gaps, and source receipts are frozen.

```text
owned turns + voice-session metadata + provider events
  -> existing conservative per-turn diagnosis
  -> bounded signature/time-window projection
  -> intent/release/code/CI join
  -> durable evidence-backed brief
  -> optional agent explanation / repair proposal / notification
```

This is a follow-on implementation intent, not another observability platform.
