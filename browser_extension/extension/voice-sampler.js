const MAX_SAMPLES = 16;
const MAX_VOICE_ID = 64;
const MAX_SAMPLE_TEXT = 300;
const SAFE_VOICE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function parseVoiceSamplerAction(action) {
  if (!action || action.type !== "voice_sampler" || action.version !== "voice-sampler/v1") return [];
  const voices = Array.isArray(action.voices) ? action.voices.slice(0, MAX_SAMPLES) : [];
  const samples = [];
  for (const voice of voices) {
    const id = String(voice?.id || "").trim();
    if (!id || id.length > MAX_VOICE_ID || !SAFE_VOICE_ID.test(id)) continue;
    const supplied = String(voice?.sample_text || "").trim();
    const text = (supplied || `This is ${id}. This is an Ag voice sample.`).slice(0, MAX_SAMPLE_TEXT);
    samples.push({ voice: id, text });
  }
  return samples;
}
