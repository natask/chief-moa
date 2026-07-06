# Gateway Migrations

Migrations live in `migrations/` and are an explicit deploy step; they are
never run on gateway boot.

Run pending migrations against a disposable or approved target database:

```sh
DATABASE_URL=postgres://... npm run migrate
```

Create the next CommonJS migration with:

```sh
npm run migrate:create -- my-change
```

File names must start with a 13-digit epoch-milliseconds prefix
(`<timestamp>_name.js`) — node-pg-migrate derives ordering from it and refuses
files it cannot parse, which is also why this document does not live inside
`migrations/`.

`initial-schema` reads `schema.sql` at runtime so the current event-substrate
schema remains the single source of truth. `relational-v1` adds the relational
v1 tables and RLS scaffolding.

The gateway/importer/migrations connect as the database owner or superuser and
bypass RLS. The app role is `moa_app`, a non-owner role intended for future app
connections. App requests must set `SET moa.user_id = '<uid>'` per request; RLS
policies then scope rows to that user.
