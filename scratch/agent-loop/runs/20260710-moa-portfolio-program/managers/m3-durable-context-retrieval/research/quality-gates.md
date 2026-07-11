# Research: quality gates

- Focused gate:
  `cd gateway && node scripts/smoke-context-artifact.js`
- Full gateway gate:
  `cd gateway && npm run check`
- Hostile audit targets:
  privacy leakage from incognito/deleted/secret-like text, cache-key collisions
  under adversarial duplicates, unbounded artifact growth, and ambiguous ranking
  ties.
- Complexity should stay concentrated in a pure artifact module rather than
  further inflating `server.js`.
