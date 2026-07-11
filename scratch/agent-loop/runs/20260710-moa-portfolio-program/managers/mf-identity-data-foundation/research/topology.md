# Topology pass

- `gateway/server.js` authenticates one exact bearer token and derives an
  account scope from the configured token. It has no request-scoped hosted user.
- `gateway/lib/remote-mode.js` distinguishes local, self-host and hosted but
  labels any non-token `MOA_AUTH` value as a future mode; that is configuration
  readiness, not implemented authentication.
- Migration `1783296000001_relational-v1.js` adds `user_id` to business tables
  and RLS policies for `moa_app`.
- `gateway/lib/relational-store.js` currently trusts record-supplied `user_id`
  and defaults to `owner`; its pool does not establish `moa.user_id`.
- `product_events`, checkpoints and blobs in `gateway/schema.sql` predate the
  relational tenant model and have no tenant column/RLS.

Conclusion: schema scaffolding exists, but the application/database boundary is
not yet end-to-end tenant enforcing.
