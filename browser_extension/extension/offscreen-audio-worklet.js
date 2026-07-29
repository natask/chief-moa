// Emit one amplitude number every LEVEL_BLOCKS render quanta. A quantum is 128
// frames, so at 16-24kHz eight of them is ~42-64ms: roughly 24 levels a second,
// which is what the companion rim reads (overlay spec 2026-07-28 section 3.1).
// The accumulator is a running sum on the processor, so this adds no allocation
// and no copy on top of the capture path that was already here.
const LEVEL_BLOCKS = 8;

class AggieVoiceCaptureProcessor extends AudioWorkletProcessor {
  constructor(...args) {
    super(...args);
    this.levelSum = 0;
    this.levelCount = 0;
    this.levelBlocks = 0;
  }

  process(inputs, outputs) {
    for (const output of outputs) {
      for (const channel of output) channel.fill(0);
    }

    const input = inputs[0]?.[0];
    if (input?.length) {
      const samples = new Float32Array(input.length);
      samples.set(input);
      for (let i = 0; i < input.length; i += 1) this.levelSum += input[i] * input[i];
      this.levelCount += input.length;
      this.levelBlocks += 1;
      this.port.postMessage({ samples }, [samples.buffer]);
      if (this.levelBlocks >= LEVEL_BLOCKS) {
        this.port.postMessage({ level: Math.sqrt(this.levelSum / this.levelCount) });
        this.levelSum = 0;
        this.levelCount = 0;
        this.levelBlocks = 0;
      }
    }
    return true;
  }
}

registerProcessor("aggie-voice-capture", AggieVoiceCaptureProcessor);
