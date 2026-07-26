import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  decodeProductRef,
  IntentLauncherClient,
  IntentLauncherError,
  stableIdempotencyKey,
} from "../src/index.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "x-request-id": "request-test" },
  });
}

function recorder(replies = []) {
  const requests = [];
  return {
    requests,
    fetch: async (url, init) => {
      requests.push({
        url: String(url),
        method: init.method,
        headers: Object.fromEntries(new Headers(init.headers)),
        body: init.body ? JSON.parse(init.body) : undefined,
      });
      return replies.shift() || response({ ok: true });
    },
  };
}

function client(mock) {
  return new IntentLauncherClient({
    baseUrl: "http://127.0.0.1:8787",
    token: randomBytes(24).toString("base64url"),
    fetch: mock.fetch,
  });
}

test("stable idempotency keys ignore object insertion order", () => {
  assert.equal(
    stableIdempotencyKey("intent:create", { a: 1, b: [2, 3] }),
    stableIdempotencyKey("intent:create", { b: [2, 3], a: 1 }),
  );
});

test("message, intent, relation, claim, release, and progress use PR63 routes", async () => {
  const mock = recorder();
  const sdk = client(mock);
  await sdk.createMessage({ message: "hello", idempotency_key: "message-v1" });
  await sdk.createIntent({
    statement: "ship", normalized_objective: "ship safely", idempotency_key: "intent-v1",
  });
  const mutation = { idempotency_key: "mutation-v1", expected_intent_version: 3 };
  await sdk.relateIntents("intent_a", {
    ...mutation, target_intent_id: "intent_b", relation_type: "depends_on",
  });
  await sdk.claimWork("intent_a", {
    ...mutation, agent_id: "agent_a", run_id: "run_a",
  });
  await sdk.releaseWork("intent_a", mutation);
  await sdk.reportProgress("intent_a", {
    ...mutation, agent_id: "agent_a", run_id: "run_a", progress: "working",
  });
  assert.deepEqual(mock.requests.map(({ method, url }) => [
    method,
    new URL(url).pathname,
  ]), [
    ["POST", "/v1/intent-runtime/messages"],
    ["POST", "/v1/intent-runtime/intents"],
    ["POST", "/v1/intent-runtime/intents/intent_a/connect"],
    ["POST", "/v1/intent-runtime/intents/intent_a/claim"],
    ["POST", "/v1/intent-runtime/intents/intent_a/transition"],
    ["POST", "/v1/intent-runtime/intents/intent_a/progress"],
  ]);
  assert.equal(mock.requests[4].body.type, "intent.waiting");
});

test("fork routes a message with parent provenance", async () => {
  const mock = recorder();
  await client(mock).forkIntent("intent_parent", {
    message: "child outcome",
    idempotency_key: "fork-v1",
    routing: { reason: "bounded child" },
  });
  assert.deepEqual(mock.requests[0].body.routing, {
    reason: "bounded child",
    action: "fork_intent",
    parent_intent_id: "intent_parent",
  });
});

test("candidate completion requires evidence and remains progress", async () => {
  const mock = recorder();
  const sdk = client(mock);
  const base = {
    agent_id: "agent_a",
    run_id: "run_a",
    idempotency_key: "candidate-v1",
    expected_intent_version: 5,
  };
  assert.throws(() => sdk.proposeCompletion("intent_a", base), /evidence_ref/);
  await sdk.proposeCompletion("intent_a", { ...base, evidence_refs: ["git:repo@commit:test"] });
  assert.equal(new URL(mock.requests[0].url).pathname, "/v1/intent-runtime/intents/intent_a/progress");
  assert.match(mock.requests[0].body.next_step, /Independent verifier/);
});

test("Product attachment preserves exact revision, digest, and provenance", async () => {
  const mock = recorder([
    response({ intent: { intent_id: "intent_a" } }),
    response({
      items: [{
        intent_id: "intent_a",
        artifact_refs: [],
      }],
    }),
  ]);
  const sdk = client(mock);
  const product = {
    product_id: "cli",
    revision: "git:abc123",
    locator: "git:chief-moa@abc123:intent_launcher",
    digest: `sha256:${"a".repeat(64)}`,
    media_type: "application/vnd.chief-moa.package",
    provenance: { run_id: "run_a", source: "build" },
  };
  await sdk.attachProduct("intent_a", {
    agent_id: "agent_a",
    run_id: "run_a",
    idempotency_key: "product-v1",
    expected_intent_version: 6,
    progress: "Attached exact Product revision.",
    product,
  });
  const ref = mock.requests[0].body.artifact_refs[0];
  assert.deepEqual(decodeProductRef(ref), { ...product, artifact_ref: ref });
});

test("status derives bounded agents, runs, and attention items", async () => {
  const projection = {
    schema: "moa.intent-plane.v1",
    agents: [{
      agent_id: "agent_a", intent_id: "intent_a", current_run_id: "run_a",
      status: "running", recovery_state: "healthy", lease_expires_at: "2026-07-26T00:00:00.000Z",
    }],
    notifications: [{
      notification_id: "notification_a", kind: "needs_user", intent_id: "intent_a",
    }],
  };
  const mock = recorder([response(projection), response(projection)]);
  const sdk = client(mock);
  assert.equal((await sdk.searchRuns()).items[0].run_id, "run_a");
  assert.equal((await sdk.searchAttentionItems()).items[0].notification_id, "notification_a");
});

test("API conflicts are actionable and credentials are not exposed", async () => {
  const mock = recorder([response({ error: "intent version conflict: expected 2, current 3" }, 400)]);
  const sdk = client(mock);
  await assert.rejects(
    sdk.updateIntent("intent_a", {
      type: "intent.enriched", expected_intent_version: 2, idempotency_key: "update-v1",
    }),
    (error) => {
      assert.ok(error instanceof IntentLauncherError);
      assert.equal(error.code, "VERSION_CONFLICT");
      assert.match(error.message, /read the intent again/);
      assert.doesNotMatch(JSON.stringify(error.toJSON()), /authorization/i);
      return true;
    },
  );
});

test("CLI help is executable and machine-readable commands reject unknown input", () => {
  const help = spawnSync(process.execPath, ["src/cli.js", "--help"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /intent-launcher/);

  const invalid = spawnSync(process.execPath, ["src/cli.js", "bad", "command"], {
    cwd: root,
    encoding: "utf8",
    input: "{}",
  });
  assert.equal(invalid.status, 1);
  const output = JSON.parse(invalid.stderr);
  assert.equal(output.ok, false);
  assert.equal(output.error.code, "INVALID_INPUT");
});
