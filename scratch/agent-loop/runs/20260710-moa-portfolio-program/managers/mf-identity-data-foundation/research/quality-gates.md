# Quality and gates pass

Required tests for the first unit:

- reject missing/empty trusted store identity;
- reject record identity different from trusted identity;
- prove every store method passes trusted identity to SQL/event construction;
- preserve explicit owner import compatibility;
- with disposable Postgres, prove two principals cannot overwrite/probe each
  other's identifier and transaction rollback leaves no event.

Targets: new decision functions complexity <= 10 and CRAP <= 15. No CRAP tool
is configured, so that target remains unmeasured; review and narrow tests are
evidence, not a numeric measurement.
