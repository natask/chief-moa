# Agent Switchboard

Agent Switchboard is the routing layer between chronological conversational
capture and Chief MOA's intent and execution systems. It is deliberately not an
execution harness.

```js
import {
  createDeterministicRouter,
  createMemoryDecisionStore,
  createSwitchboardClient,
} from "@chief-moa/agent-switchboard";

const switchboard = createSwitchboardClient({
  intentManagement,
  router: createDeterministicRouter(),
  decisionStore: createMemoryDecisionStore(),
  launcher,
  durableMessages,
});

const review = await switchboard.inspect([envelope]);
console.log(review.decisions[0]);
const receipt = await switchboard.apply(review.decisions[0].decision_id, {
  confirmed: true,
});
```

`inspect` always reads current intents and pending attention before routing.
`apply` is a separate call. See [CONTRACT.md](CONTRACT.md),
[routing-schema.md](routing-schema.md), and [system-prompt.md](system-prompt.md).

Run:

```sh
npm test
npm run example
```
