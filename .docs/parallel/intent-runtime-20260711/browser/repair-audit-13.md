# Repair contract: browser final-audit-12 blockers

## Required fixes

1. Bind every tab-owned voice session to the initiating top-level document
   identity and dispose it through the existing exact shared offscreen cleanup
   path when that document is replaced. Background-owned top-level navigation
   or document lifecycle is authoritative; a content `pagehide` message may be
   additive only. Navigation before or after gateway readiness must stop the
   exact capture/socket and must never SEND. A stale signal from the old
   document must not close a newer same-tab session.
2. Reject a resume before socket creation unless `context_action` is exactly
   `continue` and the stored session and branch exactly match the ticket/branch
   authority. `new`, `fork`, and `incognito` must create a fresh draft without
   old draft ID/revision authority; they may not move a parked draft. No
   cross-branch `session_start` may reach the WebSocket.
3. Enforce a hard bound on pending offscreen capture acquisitions and cleanups
   before `getUserMedia()` or another owner operation is allocated. Limit+1
   fails visibly without a browser acquisition. Status must remain complete
   for every admitted owner. Exact cleanup/retry and a new start after backlog
   retirement must remain possible under adversarial settlement order.

## Required regressions

- top-level navigation before ready and after ready produces exact cleanup,
  zero commit, zero stale event effects, and does not touch a replacement
  document/session;
- a stored branch-1 resume plus `new|fork|incognito` or branch-2 expectation is
  rejected before WebSocket construction/session_start;
- exact pending-start limit admits and reports every owner; limit+1 allocates no
  media request; reverse/partial resolution remains complete; retry after
  retirement succeeds.

Tests must execute shipped background/offscreen code and production-consumed
helpers. Do not prove the behavior only with an unused policy function.

## Verification

```sh
cd browser_extension
npm run verify
npm run smoke
git diff --check
```

Run per-untracked-file whitespace checks. Record evidence in
`repair-audit-13-result.md`. Do not commit, merge, package, reload, preview, or
deploy. A different fresh auditor must return PASS.
