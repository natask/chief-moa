# Intent Launcher CLI and SDK

This standalone, dependency-free Node.js package calls the PR63 Intent
Management System contract without changing the gateway. It provides JSON-only
CLI output and a typed library surface for messages, intents, agents, runs,
Products, claims, progress, attention, candidate completion, and status.

## Security

Set credentials in the environment:

```sh
export MOA_INTENT_PLANE_TOKEN="$(security find-generic-password -w -s moa-intent-plane)"
export MOA_INTENT_PLANE_URL="https://api.agee.app"
```

The CLI has no token flag. It never includes the token in output or errors.
Do not put credentials in input JSON. HTTPS is required except for localhost.

## CLI

Install from this directory with your package manager, or run:

```sh
node src/cli.js --help
```

Input is one JSON object from stdin or `--input <path>`. Output is one compact
JSON object. Errors go to stderr and use a nonzero exit status.

```sh
printf '%s' '{
  "intent_id":"intent_cli_example",
  "statement":"Build a bounded example",
  "normalized_objective":"Demonstrate Intent Launcher",
  "project_id":"chief-moa",
  "idempotency_key":"intent-cli-example-create-v1"
}' | node src/cli.js intent create

printf '%s' '{
  "agent_id":"agent_example",
  "run_id":"run_example",
  "expected_intent_version":4,
  "progress":"Checks passed.",
  "evidence_refs":["git:repo@commit:test-results.md"],
  "idempotency_key":"intent-cli-example-candidate-v1"
}' | node src/cli.js intent propose-completion intent_cli_example
```

Commands are `message create`; `intent create|search|get|update|fork|relate|
claim|release|progress|propose-completion`; `agent search|get`; `run search|get`;
`product attach|search|get`; `attention create|search|get`; and `status read`.

## SDK

```js
import { IntentLauncherClient, stableIdempotencyKey } from "@chief-moa/intent-launcher";

const client = new IntentLauncherClient({
  baseUrl: process.env.MOA_INTENT_PLANE_URL,
  token: process.env.MOA_INTENT_PLANE_TOKEN,
});
const command = { message: "Capture this outcome", workspace_id: "personal" };
const result = await client.createMessage({
  ...command,
  idempotency_key: stableIdempotencyKey("message:create", command),
});
```

Mutations require an explicit stable `idempotency_key`. Runtime mutations also
require `expected_intent_version`; on a conflict, reread and decide whether the
command is still valid before retrying.

## PR63 compatibility notes

PR63 has no first-class Product endpoint. `attachProduct` writes an immutable,
validated `product:v1:` artifact reference containing Product id, exact
revision, SHA-256 digest, locator, media type, and JSON provenance.
`searchProducts` derives records from bounded intent projections.

Attention items are `needs_user` notifications from `/v1/intent-plane`.
Candidate completion is deliberately a progress/evidence proposal; it does not
complete an intent. `releaseWork` moves the intent to `waiting`. The prior run
claim remains in the append-only audit trail and its lease may remain visible
until expiry.

Agent and run search use the bounded plane projection. A get can return
`NOT_FOUND` when filters exclude the item. Pagination should be handled by the
caller with `limit` and `offset`.
