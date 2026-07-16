import assert from "node:assert/strict";

import {
  isMissingOffscreenReceiver,
  sendToOffscreenReceiver,
  waitForOffscreenReceiver,
} from "../extension/offscreen-voice-bridge.js";

assert.equal(isMissingOffscreenReceiver(new Error("Could not establish connection. Receiving end does not exist.")), true);
assert.equal(isMissingOffscreenReceiver(new Error("permission denied")), false);

let attempts = 0;
const ready = await waitForOffscreenReceiver(async () => {
  attempts += 1;
  if (attempts < 3) throw new Error("Could not establish connection. Receiving end does not exist.");
  return { ok: true, context: "offscreen" };
}, { attempts: 3, delayMs: 0 });
assert.deepEqual(ready, { ok: true, context: "offscreen" });
assert.equal(attempts, 3);

await assert.rejects(
  waitForOffscreenReceiver(async () => ({ ok: true, context: "background" }), { attempts: 2, delayMs: 0 }),
  (error) => error.code === "offscreen_runtime_unavailable" && /receiver unavailable/.test(error.message),
);
await assert.rejects(
  waitForOffscreenReceiver(async () => { throw new Error("permission denied"); }, { attempts: 2, delayMs: 0 }),
  /permission denied/,
);

let readinessChecks = 0;
let sends = 0;
const response = await sendToOffscreenReceiver(
  async () => {
    sends += 1;
    if (sends === 1) throw new Error("Could not establish connection. Receiving end does not exist.");
    return { ok: true };
  },
  async () => { readinessChecks += 1; },
  { cmd: "offscreenVoiceCaptureStart" },
);
assert.deepEqual(response, { ok: true });
assert.equal(readinessChecks, 2);
assert.equal(sends, 2);

await assert.rejects(
  sendToOffscreenReceiver(async () => { throw new Error("mic denied"); }, async () => {}, {}),
  /mic denied/,
);
await assert.rejects(
  sendToOffscreenReceiver(
    async () => { throw new Error("Could not establish connection. Receiving end does not exist."); },
    async () => {},
    {},
  ),
  (error) => error.code === "offscreen_runtime_unavailable",
);

console.log("offscreen voice bridge tests passed");
