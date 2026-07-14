# Runtime authority claims ledger

| Implementer claim | Evidence checked | Auditor verdict |
|---|---|---|
| Unverified legacy companion routes cannot mutate profile | `applyCompanionToProfile` guard; legacy companion/pet smokes assert rejection and unchanged profile version | verified / PASS |
| Verified package apply is trust, license, moderation, compatibility and revocation bound | M6 verifier plus runtime hostile unknown-signer test | verified / PASS for configured local policy |
| Approval is bound and not caller-invented | canonical package/preview/profile/scope/time binding plus Ed25519 approver signature; mutation tests | verified / PASS |
| Apply/rollback is idempotent and restart recoverable | durable state adapter recreation test; profile effect/rollback receipts | verified / PASS for file-backed single-process seam |
| Billing runtime fails closed and enforces entitlement/budget/price/usage | inactive, estimate-mismatch and over-budget hostile tests | verified / PASS for sandbox seam |
| Runtime can charge | sandbox mode and route response `charged:false`; no provider SDK/call | refuted by design / PASS no-charge boundary |
| Production durability/atomicity is proven | JSONL/file state and skipped disposable-Postgres tests do not prove multi-process transactionality | unproven / BLOCK any production-payment or production-marketplace claim |

Measured checks: focused authority 4/4; combined gateway 237 pass, 1 skip, 0
fail. Architecture confidence: medium-high for the bounded provider-neutral seam,
not a benchmark. Residual unknowns: public policy, tenant/device PKI lifecycle,
Postgres restore/concurrency, real provider/payment behavior and live rollout.
