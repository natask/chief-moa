import assert from "node:assert/strict";
import { parseVoiceSamplerAction } from "../extension/voice-sampler.js";

const parsed = parseVoiceSamplerAction({
  type: "voice_sampler",
  version: "voice-sampler/v1",
  voices: [
    { id: "Kore", sample_text: "Hello" },
    { id: "bad voice", sample_text: "ignored" },
    { id: "Puck" },
  ],
});
assert.deepEqual(parsed, [
  { voice: "Kore", text: "Hello" },
  { voice: "Puck", text: "This is Puck. This is a Moa voice sample." },
]);
assert.deepEqual(parseVoiceSamplerAction({ type: "voice_sampler", version: "future", voices: [{ id: "Kore" }] }), []);
assert.equal(parseVoiceSamplerAction({ type: "voice_sampler", version: "voice-sampler/v1", voices: Array.from({ length: 30 }, (_, i) => ({ id: `v${i}` })) }).length, 16);
console.log("voice sampler smoke passed");
