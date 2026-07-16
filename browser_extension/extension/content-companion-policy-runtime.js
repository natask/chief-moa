(function installContentCompanionPolicyRuntime(global) {
  "use strict";

  const PET_PALETTES = new Set(["graphite", "green", "blue", "violet", "red", "amber", "teal", "mono"]);
  const PET_MOTIONS = new Set(["hover", "peek", "tap", "trail", "float", "walk", "climb", "spark"]);
  const AVATAR_MOTIONS = new Set(["still", "pulse", "hop", "orbit", "float", "shake", "glow"]);
  const AVATAR_TRIGGERS = new Set(["idle", "editing", "listening", "thinking", "speaking", "done", "error", "attention", "busy"]);
  const AVATAR_INTENSITIES = new Set(["subtle", "normal", "strong"]);
  const AVATAR_DURATIONS = new Set(["while_active"]);
  const root = global || globalThis;

  function compactText(value, max = 120) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
  }

  function safePetImageSource(value, extensionId = root.chrome?.runtime?.id || "") {
    const raw = String(value || "").trim();
    if (!raw || raw.length > 350 * 1024) return "";
    if (/^data:image\/(?:png|jpeg|jpg|webp|gif);base64,[a-z0-9+/=\s]+$/i.test(raw)) return raw;
    try {
      const url = new URL(raw);
      if (url.protocol === "chrome-extension:" && extensionId && url.hostname === extensionId) return url.href;
    } catch {}
    return "";
  }

  function sanitizeActiveCompanionPet(payload, extensionId) {
    const record = payload?.active_companion || payload?.activeCompanion || payload;
    if (!record || typeof record !== "object") return null;
    const pet = record.pet && typeof record.pet === "object" ? record.pet : {};
    const sprite = pet.sprite && typeof pet.sprite === "object" ? pet.sprite : {};
    const name = compactText(record.companion_name || record.name || pet.name, 80);
    const id = compactText(record.companion_id || record.id, 100);
    if (!name && !id) return null;
    const palette = PET_PALETTES.has(String(pet.palette || "")) ? String(pet.palette) : "blue";
    const motion = PET_MOTIONS.has(String(pet.motion || "")) ? String(pet.motion) : "walk";
    const imageSrc = safePetImageSource(sprite.image_data_url || sprite.asset_url || pet.asset_url, extensionId);
    const scale = Number(pet.scale);
    return {
      id,
      name: name || "A.G. companion",
      summary: compactText(record.companion_summary || record.summary, 140),
      source: compactText(record.source, 40),
      palette,
      motion,
      scale: Number.isFinite(scale) ? Math.min(Math.max(scale, 0.65), 1.6) : 1,
      imageSrc,
    };
  }

  function shortLangTag(code) {
    const value = String(code || "").trim();
    if (!value) return "";
    return value.split(/[-_]/)[0].toLowerCase();
  }

  function parseLanguageCodes(value) {
    return String(value || "").split(",").map(shortLangTag).filter(Boolean);
  }

  function formatLanguageChipText(profile, replyOverride) {
    const source = profile && typeof profile === "object" ? profile : {};
    const configuredInput = parseLanguageCodes(source.input_languages);
    const heard = configuredInput.length ? configuredInput : parseLanguageCodes(source.input_language_primary);
    const spoken = parseLanguageCodes(replyOverride || source.language_primary || source.language);
    const parts = [];
    if (heard.length) parts.push(`Hears ${[...new Set(heard)].join("·")}`);
    if (spoken.length) parts.push(`Speaks ${spoken[0]}`);
    return parts.join(" · ");
  }

  function sanitizeAvatarBehaviorRuntime(runtime) {
    const behavior = runtime?.active?.avatar_behavior;
    const spec = behavior?.spec;
    if (runtime?.version !== 1 || behavior?.type !== "avatar_behavior" || !spec || typeof spec !== "object") return null;
    const motion = String(spec.motion || "");
    const trigger = String(spec.trigger || "");
    if (!AVATAR_MOTIONS.has(motion) || !AVATAR_TRIGGERS.has(trigger)) return null;
    const intensity = AVATAR_INTENSITIES.has(String(spec.intensity || "")) ? String(spec.intensity) : "normal";
    const duration = AVATAR_DURATIONS.has(String(spec.duration || "")) ? String(spec.duration) : "while_active";
    return {
      id: typeof behavior.artifact_id === "string" ? behavior.artifact_id.slice(0, 80) : "",
      motion,
      trigger,
      intensity,
      duration,
    };
  }

  root.AgeeContentCompanionPolicyRuntime = Object.freeze({
    compactText,
    formatLanguageChipText,
    parseLanguageCodes,
    safePetImageSource,
    sanitizeActiveCompanionPet,
    sanitizeAvatarBehaviorRuntime,
    shortLangTag,
  });
})(typeof globalThis !== "undefined" ? globalThis : this);
