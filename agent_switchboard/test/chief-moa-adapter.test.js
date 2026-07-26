import assert from "node:assert/strict";
import test from "node:test";
import { createChiefMoaIntentAdapter } from "../src/index.js";

test("Chief MOA seam maps projection, inbox, status and mutations without launcher coupling", async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    if (url.includes("/explain")) return Response.json({ intent: { intent_id: "intent_1" }, agents: [] });
    if (init?.method === "POST") return Response.json({ intent: { intent_id: "intent_2" } }, { status: 201 });
    if (init?.method === "PATCH") return Response.json({ intent: { intent_id: "intent_1", status: "active" } });
    return Response.json({
      page: { total: 1 },
      intents: [{ intent_id: "intent_1" }],
      agents: [],
      notifications: [
        { notification_id: "pending", receipt_state: "pending" },
        { notification_id: "seen", receipt_state: "received" },
      ],
    });
  };
  const adapter = createChiefMoaIntentAdapter({ baseUrl: "https://moa.test/", token: "redacted", fetchImpl });
  assert.equal((await adapter.readSnapshot()).revision, 1);
  assert.deepEqual((await adapter.readAttention()).map((item) => item.notification_id), ["pending"]);
  assert.equal((await adapter.readIntent("intent_1")).intent.intent_id, "intent_1");
  assert.equal((await adapter.createIntent({ title: "x" })).intent_id, "intent_2");
  assert.equal((await adapter.updateIntent("intent_1", { next_action: "x" })).intent_id, "intent_1");
  assert.ok(requests.every((item) => item.init.headers.authorization === "Bearer redacted"));
  await assert.rejects(adapter.mergeIntents({}), /no merge mutation/);
});
