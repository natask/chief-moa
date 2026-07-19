function pcm16Sample(value) {
  const sample = Math.max(-1, Math.min(1, Number(value) || 0));
  return sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
}

// Stateful area resampling. Downsampling averages the full source interval for
// each output sample instead of selecting/interpolating a single point, which
// suppresses aliases that can erase short consonants and acronym boundaries.
function createPcm16Resampler(inputRate, outputRate = 16000) {
  const sourceRate = Math.max(1, Number(inputRate) || 0);
  const targetRate = Math.max(1, Number(outputRate) || 0);
  const sourceSamplesPerOutput = sourceRate / targetRate;
  let remaining = sourceSamplesPerOutput;
  let weightedSum = 0;
  let accumulatedWeight = 0;

  function process(input) {
    if (!(input instanceof Float32Array) || input.length === 0) return new ArrayBuffer(0);
    const output = [];
    for (let index = 0; index < input.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, Number(input[index]) || 0));
      let available = 1;
      while (available > 1e-9) {
        const consumed = Math.min(available, remaining);
        weightedSum += sample * consumed;
        accumulatedWeight += consumed;
        available -= consumed;
        remaining -= consumed;
        if (remaining <= 1e-9) {
          output.push(pcm16Sample(weightedSum / Math.max(accumulatedWeight, 1e-9)));
          remaining = sourceSamplesPerOutput;
          weightedSum = 0;
          accumulatedWeight = 0;
        }
      }
    }
    return Int16Array.from(output).buffer;
  }

  function reset() {
    remaining = sourceSamplesPerOutput;
    weightedSum = 0;
    accumulatedWeight = 0;
  }

  return { inputRate: sourceRate, outputRate: targetRate, process, reset };
}

export { createPcm16Resampler, pcm16Sample };
