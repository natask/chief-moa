# Repair contract: browser final-audit-10 blockers

## Required fixes

1. Make pending-start ownership resource-aware immediately after each stage.
   Once `getUserMedia` returns, the pending generation owns that stream; once an
   AudioContext exists, it owns that context. Check cancellation after every
   await. Bound worklet admission and context close; a late resolution can never
   publish a cancelled generation. Stop all provisional tracks/ports/contexts
   before reporting exact disposal. `cleanupPending:true` is not success and
   strict background stop must reject it.
2. Preserve retry/reconciliation authority until cleanup is proved. A failed or
   indeterminate disposer remains addressable by local session ID and in one
   bounded persisted cleanup tombstone. Retry must be idempotent. On service-
   worker start, query the offscreen document for active/pending ownership and
   retire any capture not backed by recovered authority; clear the tombstone
   only after exact no-capture/retired evidence. Do not turn ephemeral socket
   state into canonical product history.
3. Declare and verify the supported Chrome floor deliberately. This candidate
   depends on offscreen documents, `runtime.getContexts`, offscreen activity,
   and worker WebSocket lifecycle; set `minimum_chrome_version` to the official
   shared floor (`116`) and client-gate draft capability when required APIs are
   absent. Static verification and real smoke must assert the floor/capability.

## Required executable regressions

- getUserMedia resolves, worklet add never settles, then stop: track/context/
  port are retired within a fixed bound; start cannot later publish; strict
  stop does not report clean while cleanup remains pending;
- AudioContext close never settles: hardware stops immediately, bounded cleanup
  remains retryable/visible, late close is idempotent, and no caller receives a
  false exact-disposal receipt;
- runtime-channel stop rejection keeps retry-by-ID and a bounded persisted
  tombstone; simulated worker restart queries complete offscreen status,
  reconciles active and provisional captures, then clears only after proof;
- ordinary active capture after worker restart still self-stops on rejected PCM;
- manifest/version and capability probes cover Chrome 116 assumptions;
- retain every prior browser invariant and real headless smoke.

## Ownership and constraints

Own only `browser_extension/**` and this browser lane's durable notes. Do not
touch gateway/Android/active tree/live browser. Do not commit, package, reload,
merge, or deploy.

## Verification

```sh
cd browser_extension
npm run verify
npm run smoke
git diff --check
```

Write `repair-audit-11-result.md` with full-file/offscreen/worker-restart
evidence and exact residuals. Root will assign a fresh auditor.
