# Routing schema

## Message envelope v1

```json
{
  "schema": "chief-moa.agent-switchboard.message-envelope.v1",
  "envelope_id": "env_001",
  "occurred_at": "2026-07-26T10:00:00.000Z",
  "message": { "role": "user", "text": "status intent_alpha" },
  "context": {
    "product": {},
    "page": {},
    "screen": {},
    "selection": {},
    "file": {},
    "provenance": {}
  },
  "hints": {}
}
```

Optional context values are bounded structurally to objects by the client
contract. Integrators should additionally redact and size-bound their own
surface payloads before constructing an envelope.

## Route decision v1

```json
{
  "schema": "chief-moa.agent-switchboard.route-decision.v1",
  "decision_id": "route_<stable digest>",
  "source_envelope_id": "env_001",
  "snapshot_revision": "42",
  "action": { "type": "status", "intent_id": "intent_alpha" },
  "confidence": 1,
  "reasons": ["status request names or matches an existing intent"],
  "visibility": "required",
  "state": "proposed",
  "reversible": true,
  "links": {
    "source_envelope_id": "env_001",
    "intent_ids": ["intent_alpha"],
    "message_ids": [],
    "run_ids": []
  }
}
```

States are `proposed`, `applied`, and `reversed`. An applied decision can name
an `applied_at` timestamp and execution receipt under `result`. A reversed
decision names `reversed_by`; its compensating decision names `reverses`.

## Actions

| Action | Required fields | Execution port |
|---|---|---|
| observation | `note`; optional `intent_id` | Intent Management |
| new | `title`, `objective` | Intent Management |
| update | `intent_id`, `next_action` | Intent Management |
| fork | `parent_intent_id`, `title`, `objective` | Intent Management |
| merge | `source_intent_ids`, `target_intent_id` | Merge-capable Intent Management |
| status | optional `intent_id` | Read-only Intent Management |
| steer | `intent_id`, `agent_id`, `message` | Durable-message capability |
| launch | `intent_id`, `reopen` | Launcher capability |
