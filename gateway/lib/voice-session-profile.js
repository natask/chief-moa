// Session-scoped profile overrides from session_start, validated into the
// turn's effective profile: voice, modality, delivery, and speak-forever.
// The client payload is untrusted input — sanitized, hard-capped,
// session-scoped, never written to the stored profile. Extracted from
// voice-session-server.js (source-size policy).

const { canonicalVoice } = require("./profile-options");

function sanitizeOverrideText(value, max) {
  return String(value || "")
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function effectiveProfileForSession(profile, event) {
  const base = profile && typeof profile === "object" ? profile : {};
  const override = event?.profile_override && typeof event.profile_override === "object" && !Array.isArray(event.profile_override)
    ? event.profile_override
    : event?.profileOverride && typeof event.profileOverride === "object" && !Array.isArray(event.profileOverride)
      ? event.profileOverride
      : {};
  const next = { ...base };
  const voice = canonicalVoice(String(override.voice || event?.voice || ""));
  if (voice) {
    next.voice = voice;
  }
  const modality = String(override.response_modality || override.responseModality || "").trim().toLowerCase();
  if (modality === "speech" || modality === "text" || modality === "auto") {
    next.response_modality = modality;
  }
  // Session-scoped delivery controls (a pet that talks fast, a slow-reader
  // mode): same validation band as the profile store, never persisted.
  const rate = Number(override.speaking_rate ?? override.speakingRate);
  if (Number.isFinite(rate) && rate >= 0.5 && rate <= 2) {
    next.speaking_rate = Math.round(rate * 100) / 100;
  }
  const tone = sanitizeOverrideText(override.voice_tone ?? override.voiceTone ?? "", 160);
  if (tone) {
    next.voice_tone = tone;
  }
  // Session-scoped speak-forever narration opt-in: like response_modality,
  // never persisted. The VOICE_SPEAK_FOREVER master env still gates the loop
  // server-side, so this flag alone engages nothing.
  const speakForever = override.speak_forever ?? override.speakForever;
  if (speakForever === true) {
    next.speak_forever = true;
  }
  return next;
}

module.exports = {
  effectiveProfileForSession,
};
