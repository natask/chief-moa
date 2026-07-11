# M4 repair 001: fail-closed authority and rebuild

Repair all eight audit blockers: guarded-request-only apply; preview and
verification claim binding; receipt/effect authority with durable explicit
adoption; domain-separated idempotency with returned-event validation; paged
rebuild beyond 500; receipt identity propagation; and typed bounded non-secret,
non-shell references.

Owned paths are `gateway/lib/work-history.js`, `gateway/lib/event-substrate.js`,
focused tests and work-history smokes. No adapter, deployment script, active
service or production state may be used.

Acceptance commands:

```sh
cd gateway
node --test test/work-history-deployment-control.test.js
npm run smoke:work-history-intent
npm run smoke:work-history
npm run check
```

Fresh hostile audit must return PASS; otherwise create another targeted repair.
