"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createWritingStyleRewriteHandlers } = require("../lib/writing-style-rewrite-handlers");

function harness({ rewrite = async () => ({ text: "fixed", actions: [], persisted: false }) } = {}) {
  const sent = [];
  const headers = {};
  const { route } = createWritingStyleRewriteHandlers({
    readJsonBody: async (request) => request.body,
    sendJson: (_response, status, body) => sent.push({ status, body }),
    service: { rewrite },
  });
  return { headers, route, sent, response: { setHeader: (name, value) => { headers[name] = value; } } };
}

test("the dedicated route returns a no-store rewrite response", async () => {
  const state = harness();
  assert.equal(await state.route({ method: "POST", body: { source: "literal" } }, state.response, new URL("http://test/v1/writing-style/rewrite")), true);
  assert.deepEqual(state.sent, [{ status: 200, body: { text: "fixed", actions: [], persisted: false } }]);
  assert.equal(state.headers["cache-control"], "no-store");
});

test("the route declines other paths and reports contract failures", async () => {
  const declined = harness();
  assert.equal(await declined.route({ method: "GET" }, declined.response, new URL("http://test/other")), false);
  assert.deepEqual(declined.sent, []);
  const error = new Error("binding failed"); error.code = "source_binding_mismatch"; error.statusCode = 409;
  const failed = harness({ rewrite: async () => { throw error; } });
  assert.equal(await failed.route({ method: "POST", body: {} }, failed.response, new URL("http://test/v1/writing-style/rewrite")), true);
  assert.deepEqual(failed.sent, [{ status: 409, body: { error: "binding failed", code: "source_binding_mismatch" } }]);
});

test("handler construction requires all privacy-boundary dependencies", () => {
  assert.throws(() => createWritingStyleRewriteHandlers({}), /dependencies are required/);
});
