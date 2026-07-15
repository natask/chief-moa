# Repair contract: browser final-audit-6 blockers

## Required fixes

1. Structurally disable silence/max-duration auto-commit for every draft-mode
   session inside the background authority boundary. Caller omission or
   `autoCommit:true` must not schedule or emit `commit_turn`; only explicit user
   SEND can commit a draft.
2. Emit the exact frozen eight-key draft SEND envelope. Never copy `reason` or
   any legacy/extra caller field into the wire payload.
3. Add a bounded ticket/socket setup deadline covering the period after fresh
   capture starts and before WebSocket admission settles. Timeout must
   atomically close/unregister the session, stop and drain capture, settle the
   caller response, and retire pending state. A valid open must atomically clear
   the deadline. Timeout-first and open-first callbacks must be harmless when
   invoked again.

## Required shipped-path regressions

- draft start with omitted, false, and true `autoCommit` never arms silence or
  duration timers and never emits implicit SEND;
- every draft commit call site yields exactly the eight canonical keys and
  strips `reason`/unknown extras;
- a forever-CONNECTING WebSocket has one deterministic setup deadline and ends
  with no registered session or capture; both timeout-first and open-first
  orderings prove one settlement and no late callback effects;
- preserve all previous authority, direct-ID, capture-drain, ACK/no-ACK,
  capability-generation, gesture-latching, dependency-order, no-LiveKit,
  offscreen-bound, and real-headless-smoke cases.

## Ownership and constraints

Own only `browser_extension/**` and this browser lane's durable notes. Do not
touch gateway, Android, active tree, or the live browser. Do not commit,
package, reload, merge, or deploy.

## Verification

```sh
cd browser_extension
npm run verify
npm run smoke
git diff --check
```

Write `repair-audit-7-result.md` with exact file:line and shipped-function
evidence. Return PASS/BLOCK; root will assign a fresh final audit.
