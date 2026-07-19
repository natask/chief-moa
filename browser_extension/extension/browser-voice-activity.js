const INITIAL_RMS_THRESHOLD = 0.008;
const INITIAL_PEAK_THRESHOLD = 0.055;
const CONTINUATION_RMS_THRESHOLD = 0.004;
const CONTINUATION_PEAK_THRESHOLD = 0.025;

function pcm16VoiceActivity(buffer, { continuing = false } = {}) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 2) {
    return { speech: false, rms: 0, peak: 0 };
  }
  const view = new DataView(buffer);
  const samples = Math.floor(buffer.byteLength / 2);
  let sumSquares = 0;
  let peak = 0;
  for (let offset = 0; offset + 1 < buffer.byteLength; offset += 2) {
    const sample = view.getInt16(offset, true) / 32768;
    const absolute = Math.abs(sample);
    sumSquares += sample * sample;
    if (absolute > peak) peak = absolute;
  }
  const rms = Math.sqrt(sumSquares / samples);
  const rmsThreshold = continuing ? CONTINUATION_RMS_THRESHOLD : INITIAL_RMS_THRESHOLD;
  const peakThreshold = continuing ? CONTINUATION_PEAK_THRESHOLD : INITIAL_PEAK_THRESHOLD;
  return { speech: rms >= rmsThreshold || peak >= peakThreshold, rms, peak };
}

export {
  CONTINUATION_PEAK_THRESHOLD,
  CONTINUATION_RMS_THRESHOLD,
  INITIAL_PEAK_THRESHOLD,
  INITIAL_RMS_THRESHOLD,
  pcm16VoiceActivity,
};
