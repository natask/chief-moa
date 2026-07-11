# Claims ledger

| Implementer claim | Status | Evidence checked | Auditor verdict |
|---|---|---|---|
| Envelope uses closed semantic/attribute vocabularies | verified for foundation unit | `gateway/lib/semantic-telemetry.js`; focused test and full gateway check | pass for unit |
| Correlation IDs cannot become metric labels | verified for exported helper API | `metricDimensions`; focused assertion excludes trace/canary IDs | pass for unit; no backend mapping exists |
| Exporter down/slow/overflow cannot fail caller | verified for deterministic local cases | rejection, queue overflow, and hung-export timeout tests | pass for unit; production behavior unmeasured |
| Sensitive/token-shaped values are excluded | verified for explicit default-deny boundary | forbidden-key, finite-value and token-shaped tests | pass for tested corpus; broader scrubbed corpus unavailable |
| Vendor/backend quality or resource performance | unproven | no preview or benchmark run | no claim permitted |
| Frontend/backend cross-surface ingestion works | unproven | no client adapters or isolated Collector/backend preview | overall MT integration block |
