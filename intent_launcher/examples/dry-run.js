import { randomBytes } from "node:crypto";
import { IntentLauncherClient, stableIdempotencyKey } from "../src/index.js";

const requests = [];
const fakeFetch = async (url, init) => {
  requests.push({ url: String(url), method: init.method, body: init.body && JSON.parse(init.body) });
  return new Response(JSON.stringify({ accepted: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

const input = {
  intent_id: "intent_example",
  statement: "Create the example",
  normalized_objective: "Show a credential-free SDK call",
};
const client = new IntentLauncherClient({
  baseUrl: "http://127.0.0.1:8787",
  token: randomBytes(32).toString("base64url"),
  fetch: fakeFetch,
});
await client.createIntent({
  ...input,
  idempotency_key: stableIdempotencyKey("example:create", input),
});
process.stdout.write(`${JSON.stringify(requests, null, 2)}\n`);
