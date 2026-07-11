# Intent domain fresh audit

## Disposition

`BLOCK`.

The focused and full gateway gates pass, and the exact current-process-instance
branch of stale-lock detection is fail-closed. Two adversarial contract failures
remain.

## Blocker 1: configured stale age is shortened

`gateway/lib/event-substrate.js` computes the complete-lock age threshold as
`Math.min(options.staleMs, 1_000)`. This violates repair contract 5's requirement
to wait for the normal configured stale-age threshold before treating a
same-host, same-PID, different-instance lock as stale.

A real JSON append using `jsonLockStaleMs: 30000` against a complete lock aged
only 1,500 ms succeeded in 29 ms and assigned stream version 1. It should have
timed out while the lock remained below the configured threshold.

A direct evaluation of the shipped predicate with a 60-second-old lock showed:

- exact PID plus exact process-instance ID: not stale;
- same PID plus a different non-empty process-instance ID: stale;
- same PID without an instance ID: not stale;
- remote host: not stale.

Thus the exact-instance safety rule is implemented, but
`gateway/test/event-substrate-lock.test.js` contains only the prior-instance
recovery case. The required executable exact-live-instance non-reaping case is
missing.

## Blocker 2: a partial focus pair can become unrecoverable

Repair contract 2 requires paired focus events to remain retry-safe and never
leave an unrecoverable pair. `pushFocus` durably appends the return-target
suspension before the child focus event. If the child append fails, normal
`transition` still permits the active child to complete. A retry then rebuilds
the missing child focus event from terminal state and rejects it, while the
return target remains suspended.

Reproduction result:

```json
{
  "first_error": "injected child-half failure",
  "parent_after_partial_pair": "suspended",
  "retry_error": "intent is terminal: completed",
  "final_parent_focus_state": "suspended",
  "final_parent_focus_child_intent_id": "child",
  "final_child_lifecycle": "completed",
  "final_child_focus_state": "unfocused"
}
```

The existing half-failure tests retry immediately and therefore do not cover an
intervening legal command or independent-runtime race. The repair needs either a
recoverable/compensating focus protocol or a guard that prevents an intervening
mutation from making a durable half-pair impossible to reconcile, plus an
executable adversarial test.

## Verification evidence

- Syntax checks for the event substrate and all three intent modules: pass.
- `node --test gateway/test/event-substrate-lock.test.js`: 7 passed.
- `node --test gateway/test/intent-runtime.test.js`: 17 passed.
- `node gateway/scripts/smoke-event-substrate.js`: pass.
- `cd gateway && npm run check`: 211 passed, 1 skipped, 0 failed.
- Tracked diff check and trailing-whitespace scan over all slice files: pass.

No product or test code was changed by this audit. No commit, merge, deploy, or
live-state operation was performed.
