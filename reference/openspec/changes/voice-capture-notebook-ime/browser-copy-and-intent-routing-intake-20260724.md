# Browser Copy And Intent Routing Intake — 2026-07-24

## Raw Product Direction

- Keep the interface small. Do not add another mode selector or chat-shaped
  message manager.
- A completed browser/macOS dictation must keep its literal transcript visible
  and offer one click to copy it for paste anywhere.
- Preserve automatic copy, but do not make it the only recovery path.
- Single-click should continue current work; an explicit new gesture should
  create unrelated work. The long-term router should infer reuse versus new work
  from durable intent and active-agent evidence instead of relying only on click
  count.
- One spoken capture may contain several independent ideas. Preserve the source,
  propose an editable dependency graph, run independent lanes in parallel, reuse
  compatible active workers, and report durable results.
- Long dictation must survive pauses. Silence detection may omit silent audio,
  but it must not end a manual capture.
- Show transcription/provider cost per turn and annualized daily-use cost.
- Keep the system self-hostable and tenant-scoped. Consumer subscriptions are
  not equivalent to provider API authority.

## Current Smallest Implementation Unit

Browser extension version `0.1.88` adds one terminal dictation Copy control
bound to the exact final transcript. It retains automatic clipboard delivery,
preserves the transcript on copy failure, starts no reasoning or agent work, and
keeps the actionable card until dismissal or the next turn.

Acceptance:

1. A transcription-only terminal event renders exactly one Copy control.
2. Clicking Copy writes the exact final transcript and shows
   `Copied — clipboard replaced`.
3. The existing command draft remains unchanged.
4. No run or gateway reasoning request is created by Copy.

## Follow-Up DAG

```text
claims-ledger reconciliation
├─ universal broker + canonical-intent admission
│  └─ cross-surface current-intent pointer and explicit new-intent creation
│     └─ intent/project/run candidate resolver
│        └─ editable source-linked lane DAG with budgets and exclusions
│           └─ approved parallel coordinator with active-worker reuse
│              └─ durable result inbox and final synthesis
├─ manual dictation semantics across pauses
│  └─ durable local chunk spool and manifest
│     └─ stored-audio-first gateway transcription, rollover, and retry
│        └─ notebook, IME, and explicit capture dispatch
├─ provider-stage usage receipts
│  └─ STT/TTS/model/search/harness metering and annualized projection
└─ authenticated tenant resolver and remaining store isolation
   └─ connected-account execution adapters and guided self-host onboarding
```

The router must never treat screen context as instruction, and a routing plan
must remain inert until the relevant execution authority admits it.
