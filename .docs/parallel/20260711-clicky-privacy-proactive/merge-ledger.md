# Merge Ledger: 20260711 Clicky Privacy / Proactive Assistance

| Time | Lane | Branch/worktree | State | Evidence |
| --- | --- | --- | --- | --- |
| 2026-07-11 | T0 forensics | read-only local app/cache | complete | Installed HeyClicky 1.0.33 inspected without launch; actual cached proactive POST schemas recovered without payload values. |
| 2026-07-11 | T2 repo/privacy research | shared read-only lanes | complete | Chief Moa browser/Android context flows and OpenClicky/HeyClicky mechanisms mapped. |
| 2026-07-11 | T3 implementation contract | `privacy_contract` | complete / BLOCK baseline | P0 audit found silent hosted seeding, startup traffic, default-on/fail-open automation, ungated tool claims, and heartbeat page metadata. Contract expanded to remove those trust failures before adding cards. |
| 2026-07-11 | T0 contract consolidation | isolated browser worktree | complete | Durable implementation contract saved in `implementation-contract.md`; scope remains browser-only. |
| 2026-07-11 | T1 browser slice | `agent/privacy-proactive-helper-20260711` | scoped | Isolated worktree fast-forwarded to starting ref `f08e489`. |
| 2026-07-11 | Baseline verification | isolated browser worktree | passed | `npm run verify`: 7/7 focused tests plus static verification; `npm run smoke`: real extension/headless Chrome pass. |
| 2026-07-11 | OpenClicky reference build | isolated `/tmp` DerivedData | passed | Unsigned arm64 Debug `OpenClicky.app` built from the clean public checkout with Xcode; not launched and no TCC/live app state touched. |
| 2026-07-11 | Auditor ring 1 | isolated browser worktree | BLOCK | Page-owned authorization, generic voice-route agent-launch risk, stale-document/hash races, config/destination mismatch, receipt races, unbounded collection, and gameable smoke identified with file/line evidence. |
| 2026-07-11 | Browser repair | isolated browser worktree | complete | Extension-owned final confirmation, exact document/frame checks, origin-only destination, atomic state transitions, bounded collector, and serialized protocol-violation receipts implemented and re-smoked. |
| 2026-07-11 | Gateway slice | `agent/proactive-gateway-20260711` in separate worktree | verified / integration pending | Strict non-persisting `/v1/proactive/turns` route and isolated smoke completed; no live deployment authorized. |
| 2026-07-11 | Gateway auditor ring | separate gateway worktree | BLOCK -> repaired -> PASS | Tokenless-local provider-cost abuse and unbounded provider-body/token-exchange paths were blocked; repair `65fac68` adds exact bearer auth, exact OpenAI/Vertex envelopes, byte/time/output caps, executable-output rejection, provider parity, and malicious-provider smoke. `npm run check`: 190 pass, 1 DB-gated skip. |
| 2026-07-11 | Browser auditor ring 2 | isolated browser worktree | BLOCK -> repaired -> PASS | Added active confirmation expiry/restart status, bounded gateway response parsing/property scan, startup migration gate, side-panel revocation, decoded/overlong sensitive-route handling, canonical origin validation, packaged/data-only companion images, and removed gateway/connectivity state from host DOM. Independent re-audit found no blocking issue after repair. |
| 2026-07-11 | Browser runtime QA | throwaway Chrome/profile/gateway | passed | Verify, base smoke, full 35s proactive privacy/hostile/concurrency/redirect/migration smoke, agent-loop, unified-browser-agent, and ambient 200ms smoke passed; no live browser touched. |
| 2026-07-11 | Dependency audit | isolated gateway install | existing blocker recorded | `npm audit --omit=dev` reports high-severity CLI-only `glob` advisory through `node-pg-migrate`; no `glob -c` path is used here, but lockfile upgrade remains separate maintenance before claiming a clean dependency audit. |

## Forensic claims retained for the final report

- Cached HeyClicky transactions prove `/proactive-agents`,
  `/proactive-agents/resolution`, and `/proactive-buddy` calls to the vendor
  worker while no contemporaneous explicit prompt was required.
- The captured proactive request bodies contain accessibility context plus
  recent app/site/window activity. The recovered schemas contain no screenshot
  or image field.
- Separate explicit help/agent routes support screenshots; that does not prove
  periodic proactive screenshot upload.

## Integration rule

Only the root orchestrator may merge or promote this slice. A green report
requires committed code, independent audit, rerun verification in this worktree,
and a release artifact or a plainly recorded promotion blocker.
