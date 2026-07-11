# Claims ledger

| Implementer claim | Status | Evidence checked | Auditor verdict |
|---|---|---|---|
| Envelope uses closed semantic/attribute vocabularies | verified for foundation unit | `gateway/lib/semantic-telemetry.js`; focused test and full gateway check | pass for unit |
| Correlation IDs cannot become metric labels | verified for exported helper API | `metricDimensions`; focused assertion excludes trace/canary IDs | pass for unit; no backend mapping exists |
| Exporter down/slow/overflow cannot fail caller or accumulate unresolved work | repaired after independent BLOCK; pending fresh audit | cooperative abort test 5/5; non-cooperative adapter stays at one active export with bounded queue/circuit | deterministic evidence only; production behavior unmeasured |
| Sensitive/token/identity-shaped values are excluded | repaired after independent BLOCK; pending fresh audit | forbidden attributes plus hostile release/correlation field-format tests | tested formats only; broader scrubbed corpus unavailable |
| Vendor/backend quality or resource performance | unproven | no preview or benchmark run | no claim permitted |
| Frontend/backend cross-surface ingestion works | unproven | no client adapters or isolated Collector/backend preview | overall MT integration block |

Independent Tier 0 audit refuted the initial unit PASS: free-form release and
correlation values admitted identity-shaped data, and timed-out non-cooperative
exports accumulated unresolved work. The repair uses field-specific prefixed
UUIDs plus semantic versions and a single-flight abort/quarantine circuit. This
ledger does not call that repair PASS until a fresh auditor verifies it.
