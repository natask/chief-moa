# Repair contract: Android final-audit blockers

## Required fixes

1. Gate transcript, assistant, progress, tool, and other execution-origin socket
   events behind canonical draft SEND admission. Before SEND, hostile or late
   gateway events must produce no history, model/provider, broker, tool, agent,
   or follow-up effect.
2. A canonically resumed parked draft must allow immediate SEND with zero new
   local PCM. The gateway, which owns assembled draft audio, decides whether the
   committed draft is empty.
3. Add a lifecycle epoch/terminal phase captured by every socket, capture,
   timer, and Overlay callback. Retire it before terminal teardown; advance the
   Overlay generation before destroying a failed controller. No ready, ACK,
   terminal, transcript, capture, or timer callback may mutate state afterward.
4. Make terminal receipt admission specific to the exact event. Never retain a
   sticky boolean that authorizes later terminal events.
5. Recheck lifecycle/epoch after every effectful enqueue or capture-start call
   and immediately before every callback, including synchronous callback paths.
6. Emit the exact alias-free v1 draft `session_start`; do not inherit
   `conversation_id` or any legacy alias.
7. Parse draft new/incognito branch authority as an exact string from the raw
   response. Reject numeric, whitespace-padded, coerced, missing, and malformed
   values before storing or using them.
8. Bound `/health` response bytes and total elapsed read time in addition to the
   existing per-read timeout.

## Required deterministic regressions

- hostile pre-SEND transcript/assistant/progress events cause zero application
  effects;
- park -> process restart -> authoritative resume -> immediate release emits
  exact SEND despite zero new PCM;
- timeout-wins and ACK-wins orderings, late ACK/ready/terminal/capture callbacks,
  and cross-authority terminal events cannot revive or mutate terminal state;
- synchronous control ACK and synchronous capture-start failure cannot be
  overwritten by the outer ready handler;
- exact draft start key set has no aliases;
- numeric and whitespace-padded switch authority is rejected;
- oversized and drip-fed health responses terminate within a fixed byte/time
  budget.

Tests must exercise production controller effects using injectable fake socket,
capture, and scheduler seams. A policy-object-only assertion is not proof.

## Ownership and constraints

The Android lane owns only `android_app/**` and this lane's durable notes. Do not
edit the gateway, browser extension, active tree, or live application. Do not
install or deploy. Preserve unrelated changes in the lane worktree.

## Verification

```sh
cd android_app
ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew testDebugUnitTest --rerun-tasks
ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew assembleDebug
git diff --check
```

Return exact PASS/BLOCK evidence. Do not commit; the root orchestrator audits and
integrates serially.
