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
