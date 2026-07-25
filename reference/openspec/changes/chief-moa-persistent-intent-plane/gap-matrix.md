# Global Intent Authority Gap Matrix

Comparison baseline: deployed commit `ffb62dc1`.

| Capability | Baseline | This candidate | Remaining gap |
| --- | --- | --- | --- |
| Hosted authority | authenticated API; Postgres when configured | unchanged | verify production substrate after deploy |
| One logical database | shared product-event substrate | explicit contract | no measured need for partitioning |
| Stable intent IDs | yes | unchanged | strict transition graph absent |
| Logical placement | absent | placement fields, filters, reversible updates | labels are not authorization scopes |
| Agent provenance | reason, launcher, capabilities | adds runtime, location, endpoint, parent, recovery | reachability is adapter-specific |
| Liveness/recovery | progress only | heartbeat lease and recovery projection | no exclusive recovery claim/resume |
| Local/remote registration | manual API | explicit execution metadata | runtime adapters are separate |
| Routing | bounded list | placement filters | routing-decision aggregate absent |
| Steering | absent | contract specified | addressed message API absent |
| Context compaction | recap string | bundle contract specified | source-bounded bundle API absent |
| Relations | absent | contract specified | typed edge API absent |
| Artifacts | opaque refs | version contract specified | typed artifact/version API absent |
| Notifications | pending/received | unchanged | delivery attempts/retry absent |
| Security | one shared principal | limitations explicit | scoped identities and row auth absent |
| Audit | append-only events | policy explicit | actor is gateway, not client identity |
| Retention | store retention | policy explicit | heartbeat checkpoints absent |
| Export | bounded projection | contract specified | ordered export manifest absent |
| Partitioning | absent | reversible protocol specified | router/dual-write/reconciler absent |
| UI | raw API | minimum surface specified | Mac/browser/phone/web views absent |

