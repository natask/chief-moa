# Design: Chief Moa Persistent Intent Plane

## Storage and projection

Records are additive `product_events` in the existing event substrate. JSONL is
the supported local substrate and Postgres `product_events` is the hosted
substrate; no migration is required. A fresh gateway process rebuilds the
`moa.intent-plane.v1` projection by reducing those events.

Streams and events:

| Stream | Events |
| --- | --- |
| `intent-plane:intent:{intent_id}` | `intent_plane.intent.created`, `intent_plane.intent.updated` |
| `intent-plane:agent:{agent_id}` | `intent_plane.agent.registered`, `intent_plane.agent.progressed` |
| `intent-plane:notification:{notification_id}` | `intent_plane.notification.created`, `intent_plane.notification.received` |

Every mutation has a global idempotency key and an expected stream version.

## API

All routes require normal gateway Bearer authentication.

| Method and route | Purpose |
| --- | --- |
| `POST /v1/intent-plane/intents` | Admit one explicitly confirmed intention |
| `GET /v1/intent-plane` | List a bounded unified projection; optional `status`, `limit` and `offset` |
| `GET /v1/intent-plane/intents/{id}` | Read one intention |
| `PATCH /v1/intent-plane/intents/{id}` | Update status, owner, next action or artifact refs |
| `POST /v1/intent-plane/intents/{id}/agents` | Manual/fixture agent registration |
| `POST /v1/intent-plane/agents/{id}/progress` | Append idempotent progress/blocked/completed state |
| `GET /v1/intent-plane/intents/{id}/explain` | Explain intent, agent, run and artifact links |
| `POST /v1/intent-plane/notifications/{id}/receipt` | Record that the user ping was received |

Completion and `needs_user` transitions create durable pending pings. Receipt
events move the projection to `received`.

## Authority and privacy

- `user_confirmed: true` is mandatory for admission; inferred intent is rejected.
- Sensitive values are bounded and sensitivity is explicit (`normal`,
  `sensitive`, or `restricted`).
- Source and launcher provenance are metadata, not action authority.
- The plane performs no external action.
- Capabilities and authority are summaries, never credentials.
- This slice has one authenticated gateway principal. Sensitivity is durable
  classification for that principal, not a separate authorization scope;
  multi-user/scope enforcement is future work and restricted records must not
  be described as independently access-controlled.
- First-class agent persistence requires explicit registration. A future
  gateway launcher adapter should register immediately after allocating its
  stable agent/run identities and before launch; it must not guess or scrape
  current Codex subagent ids.
