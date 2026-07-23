import assert from "node:assert/strict";
import test from "node:test";

import { createVoicePreRollBuffer } from "../extension/voice-preroll-buffer.js";

test("voice pre-roll retains the newest bounded PCM bytes in order", () => {
  const buffer = createVoicePreRollBuffer(8);
  buffer.append(Uint8Array.from([1, 2, 3, 4]));
  buffer.append(Uint8Array.from([5, 6, 7, 8]));
  buffer.append(Uint8Array.from([9, 10, 11, 12]));

  assert.equal(buffer.byteLength, 8);
  assert.deepEqual([...buffer.drain()], [5, 6, 7, 8, 9, 10, 11, 12]);
  assert.equal(buffer.byteLength, 0);
});

test("voice pre-roll trims an individual oversize PCM chunk to its newest tail", () => {
  const buffer = createVoicePreRollBuffer(4);
  buffer.append(Uint8Array.from([1, 2, 3, 4, 5, 6]));

  assert.deepEqual([...buffer.drain()], [3, 4, 5, 6]);
});
