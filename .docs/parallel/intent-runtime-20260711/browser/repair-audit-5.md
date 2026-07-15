# Repair contract: browser final-audit blockers

## Required fixes

1. Pointer validation must distinguish absence from falsy values. Numeric zero
   for draft, session, branch, or turn authority is malformed and must never
   normalize to a missing/valid pointer.
2. Every direct `voiceSessionId` lifecycle lookup must validate exact canonical
   `turn_id` binding before stop, drain, commit, cancel, discard, state mutation,
   or media teardown. Wrong-turn commands must have zero side effects.
3. Cancel-before-start late disposal must be bounded even when background
   discard returns a queued/awaiting-ACK success. The late-start session must be
   closed or otherwise terminally retired on a deterministic timer; it cannot
   remain registered indefinitely.

## Required regressions

- actual exported validator rejects numeric zero independently for every
  authority field;
- exact shipped lifecycle function rejects wrong-turn direct-ID commit, cancel,
  and discard with no capture, session, or pending-state effects;
- queued pre-ready discard with no ACK closes/retires a late-start session within
  the bounded deadline;
- preserve already-green pre-ID SEND drain ordering, endpoint capability
  generation isolation, feature-latched chords/holds, programmatic dependency
  injection, offscreen bounds, and the no-LiveKit draft path.

## Ownership and constraints

Own only `browser_extension/**` plus this lane's durable notes. Do not touch the
gateway, Android, active tree, or live browser. Do not package, reload, or deploy.

## Verification

```sh
cd browser_extension
npm run verify
npm run smoke
git diff --check
```

Return exact PASS/BLOCK evidence. Do not commit; the root orchestrator performs
serial integration.
