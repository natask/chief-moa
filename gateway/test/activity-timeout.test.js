"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { withActivityTimeout } = require("../lib/activity-timeout");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("activity extends a streamed operation beyond one timeout window", async () => {
  const startedAt = Date.now();
  const result = await withActivityTimeout(async (touch) => {
    await delay(20);
    touch();
    await delay(20);
    touch();
    await delay(20);
    return "complete";
  }, 30, "voice reasoning");

  assert.equal(result, "complete");
  assert.ok(Date.now() - startedAt >= 55);
});

test("an inactive operation still fails at the bounded deadline", async () => {
  await assert.rejects(
    withActivityTimeout(() => new Promise(() => {}), 20, "voice reasoning"),
    /voice reasoning inactivity timeout after 20ms/
  );
});

test("a source failure wins before the inactivity deadline", async () => {
  await assert.rejects(
    withActivityTimeout(async () => {
      await delay(5);
      throw new Error("provider failed");
    }, 100, "voice reasoning"),
    /provider failed/
  );
});
