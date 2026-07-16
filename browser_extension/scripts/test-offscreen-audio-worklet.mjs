import assert from "node:assert/strict";

const original = {
  AudioWorkletProcessor: globalThis.AudioWorkletProcessor,
  registerProcessor: globalThis.registerProcessor,
};
let Processor = null;
class BaseProcessor {
  constructor() {
    this.messages = [];
    this.port = { postMessage: (message, transfer) => this.messages.push({ message, transfer }) };
  }
}
globalThis.AudioWorkletProcessor = BaseProcessor;
globalThis.registerProcessor = (name, value) => {
  assert.equal(name, "aggie-voice-capture");
  Processor = value;
};

await import(`../extension/offscreen-audio-worklet.js?test=${Date.now()}`);
const processor = new Processor();
const output = new Float32Array([1, 2, 3]);
assert.equal(processor.process([], [[output]]), true);
assert.deepEqual([...output], [0, 0, 0]);
assert.equal(processor.messages.length, 0);

const input = new Float32Array([0.25, -0.5]);
assert.equal(processor.process([[input]], [[new Float32Array(2)]]), true);
assert.deepEqual([...processor.messages[0].message.samples], [0.25, -0.5]);
assert.equal(processor.messages[0].transfer[0], processor.messages[0].message.samples.buffer);

globalThis.AudioWorkletProcessor = original.AudioWorkletProcessor;
globalThis.registerProcessor = original.registerProcessor;

console.log("offscreen audio worklet tests passed");
