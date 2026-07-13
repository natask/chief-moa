# Trust and data pass

Hostile findings:

1. A caller of `createRelationalStore` can supply another `user_id` in a record.
2. `ON CONFLICT (id) DO UPDATE SET user_id = excluded.user_id` can transfer a
   globally addressed row between tenants when the database owner role is used.
3. Audit event idempotency keys and stream identities are globally shared and
   lack tenant identity, allowing collision/omission across future users.
4. File stores and blobs are not comprehensively tenant-scoped.
5. Better-auth and per-device credentials are specified but not implemented.

The first repair must bind writes to a trusted store identity and reject record
identity mismatch. Event-schema tenant migration is a separate staged unit
because it changes durable production schema and restore compatibility.
