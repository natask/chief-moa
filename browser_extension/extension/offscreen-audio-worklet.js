class AggieVoiceCaptureProcessor extends AudioWorkletProcessor {
  process(inputs, outputs) {
    for (const output of outputs) {
      for (const channel of output) channel.fill(0);
    }

    const input = inputs[0]?.[0];
    if (input?.length) {
      const samples = new Float32Array(input.length);
      samples.set(input);
      this.port.postMessage({ samples }, [samples.buffer]);
    }
    return true;
  }
}

registerProcessor("aggie-voice-capture", AggieVoiceCaptureProcessor);
