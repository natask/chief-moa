# Runtime authority final repair

Branch `agent/runtime-authority-final-repair`; worktree
`chief-moa-worktrees/runtime-authority-final-repair`; base `caba6a1`.

Close the final integration gaps between the verified M6 package seam and the
mutable profile runtime, and between the MB billing domain and runtime resource
authorization. Keep every effect provider-neutral, reversible and no-charge.
No real payment/provider, public marketplace policy, deployment or live service
mutation is permitted.

Acceptance: legacy or unverified companion input cannot mutate profile state;
verified preview/apply/rollback binds package digest, trusted policy, profile
version, scope, approval window and durable receipts. Runtime usage requires an
active tenant entitlement and accepted immutable budget reservation before a
usage fact is recorded. Focused hostile tests and full gateway check pass.
