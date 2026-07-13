# Merge ledger

| Time (PT) | Step | Evidence | Result |
|---|---|---|---|
| 2026-07-10 19:09 PT | Manager packet created | `goal.md`, research, contract, ledgers | done |
| 2026-07-10 19:11 PT | Bounded CLI subagent attempt | blocked by no-network sandbox after isolated `CODEX_HOME` retry; local audit substituted and blocker recorded | blocked by environment |
| 2026-07-10 19:18 PT | Implementation unit | `gateway/lib/work-history.js`; `gateway/test/work-history-deployment-control.test.js` | done |
| 2026-07-10 19:20 PT | Focused verification | `node --check gateway/lib/work-history.js`; `node --check gateway/test/work-history-deployment-control.test.js`; `cd gateway && node --test test/work-history-deployment-control.test.js`; `cd gateway && npm run smoke:work-history-intent` | pass |
| 2026-07-10 19:22 PT | Broader verification | `cd gateway && npm run smoke:work-history` -> `listen EPERM`; `cd gateway && npm run check` -> missing `pg`/`ws`/`@executor-js/sdk`/`livekit-server-sdk` plus `listen EPERM` smokes | blocked by environment |
| 2026-07-10 19:25 PT | Conventional commit | `git add ...` blocked: `Unable to create .../.git/worktrees/m4-deployment-control-plane/index.lock: Operation not permitted` | blocked by environment |
| 2026-07-10 19:47 PT | Fail-closed repair 001 | focused 4/4; intent + HTTP smokes pass; full gateway 176 pass, 1 skip | fresh audit running |
| 2026-07-10 19:56 PT | Audit repair 002 | preview expiry recovery, request fingerprint, stable pagination tie-break; focused 6/6; full gateway 178 pass, 1 skip | fresh re-audit PASS |
