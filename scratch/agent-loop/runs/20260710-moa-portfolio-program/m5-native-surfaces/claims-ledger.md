# M5 claims ledger

Measured claims require named commands. Architecture-confidence targets are not
benchmarks. No paid models, external evaluations, signed builds, physical-device
tests or production traffic were used in this lane.

| Implementer claim | Status | Evidence checked | Auditor verdict |
|---|---|---|---|
| Protocol validator accepts typed N/N-1 envelopes and rejects tested malformed semantics | verified | `cd gateway && node --test test/aggie-surface-protocol.test.js`: 12/12 pass; full `npm run check`: 193 pass, 1 skip | repair verification passed; fresh audit pending |
| Approval eligibility binds session, surface, time, proposal message and canonical proposal digest | verified for module | hostile mutation/scope tests in focused suite; no effect executor exists in module | repair verification passed; fresh security audit pending |
| Echo adapter is deterministic, bounded and external-I/O-free | verified for module | focused test and `node scripts/smoke-aggie-surface-protocol.js` PASS | repair verification passed; fresh audit pending |
| macOS/iOS/Windows behavior works | unproven | no signed/device evidence | out of protocol scope |
| Device or actor identity is authenticated | unproven | protocol correlation only; no signing/transport/device evidence | explicitly not claimed |
| Fresh audit after `94f0764` | refuted/block | missing approval `reply_to` validation; client types admitted to replay; unbounded echo map; complexity gate absent; dangerous additive semantics unresolved | repair required |
| Repair 2 closes those audit reproductions | verified by implementer, auditor pending | focused 13/13; quality gate max cyclomatic 9 and max CRAP 9.47; echo retention/replay/security hostile tests | fresh independent audit required |
| Repair 2 preserves the gateway gate | verified | `npm run check`: 194 pass, 1 skip, 0 fail; strict OpenSpec PASS | fresh independent audit required |
| Dependency audit is clean | refuted / not claimed | package-lock-only install reported 2 existing high-severity dependency advisories; no `audit fix --force` attempted | residual repo dependency risk outside this repair |
| Fresh final audit at `21536c9` | refuted/block | credential-authority key families incomplete; approval checked only surface ID; quality script allowed CRAP 30 rather than contract 15 | repair required |
| Repair 3 closes final-audit reproductions | implementer verification pending | normalized hostile credential corpus; full surface mismatch matrix; CRAP threshold 15 | fresh audit required |
| Repair 3 verification is green | verified by implementer | focused 13/13; quality PASS max cyclomatic 9 / CRAP 9.47 against <=10/<=15; echo smoke PASS; strict OpenSpec PASS; full gateway 194 pass, 1 skip | fresh audit required |
| Adjacent voice-audio-storage failure persists | refuted in writable lane | `node scripts/smoke-voice-audio-storage.js` passed twice consecutively; full gateway instance also passed | prior failure not reproduced; no concealment or code change |
| Fresh audit at `5869ff9` | refuted/block | current execution context checked only `surface_id`, permitting same-ID wrong mode/device | repair required |
| Repair 4 binds current execution surface | implementer verification pending | full canonical context surface validation/match; missing/wrong kind/mode/device hostile tests | fresh audit required |
| Repair 4 verification is green | verified by implementer | focused 13/13; quality max cyclomatic 9 / CRAP 9.15 under 10/15; echo/audio-storage/OpenSpec PASS; full gateway 194 pass, 1 skip | fresh audit required |
