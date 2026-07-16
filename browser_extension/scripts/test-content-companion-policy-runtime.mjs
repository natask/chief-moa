import assert from "node:assert/strict";

globalThis.chrome = { runtime: { id: "self-extension-id" } };
await import(`../extension/content-companion-policy-runtime.js?test=${Date.now()}`);
const policy = globalThis.AgeeContentCompanionPolicyRuntime;

assert.ok(Object.isFrozen(policy));

assert.equal(policy.compactText(null), "");
assert.equal(policy.compactText("  hello\n  companion  "), "hello companion");
assert.equal(policy.compactText("abcdef", 3), "abc");

assert.equal(policy.safePetImageSource(""), "");
assert.equal(policy.safePetImageSource("x".repeat(350 * 1024 + 1)), "");
assert.equal(policy.safePetImageSource("data:image/png;base64,aGVsbG8="), "data:image/png;base64,aGVsbG8=");
assert.equal(policy.safePetImageSource("data:image/svg+xml;base64,PHN2Zz4="), "");
assert.equal(
  policy.safePetImageSource("chrome-extension://self-extension-id/assets/pet.png"),
  "chrome-extension://self-extension-id/assets/pet.png",
);
assert.equal(
  policy.safePetImageSource("chrome-extension://explicit-id/assets/pet.webp", "explicit-id"),
  "chrome-extension://explicit-id/assets/pet.webp",
);
assert.equal(policy.safePetImageSource("chrome-extension://other-id/assets/pet.png"), "");
assert.equal(policy.safePetImageSource("chrome-extension://self-extension-id/assets/pet.png", ""), "");
assert.equal(policy.safePetImageSource("https://example.test/pet.png"), "");
assert.equal(policy.safePetImageSource("not a url"), "");

assert.equal(policy.sanitizeActiveCompanionPet(null), null);
assert.equal(policy.sanitizeActiveCompanionPet("pet"), null);
assert.equal(policy.sanitizeActiveCompanionPet({}), null);

assert.deepEqual(policy.sanitizeActiveCompanionPet({
  active_companion: {
    companion_id: " pet-1 ",
    companion_name: "  Nova\n Cat ",
    companion_summary: "  Friendly   guide ",
    source: "  gallery ",
    pet: {
      palette: "violet",
      motion: "hover",
      scale: 1.25,
      sprite: { image_data_url: "data:image/webp;base64,YQ==" },
    },
  },
}), {
  id: "pet-1",
  name: "Nova Cat",
  summary: "Friendly guide",
  source: "gallery",
  palette: "violet",
  motion: "hover",
  scale: 1.25,
  imageSrc: "data:image/webp;base64,YQ==",
});

assert.deepEqual(policy.sanitizeActiveCompanionPet({
  activeCompanion: {
    id: "fallback-id",
    summary: "summary",
    pet: {
      name: "Fallback name",
      palette: "unknown",
      motion: "unknown",
      scale: 99,
      sprite: { asset_url: "chrome-extension://self-extension-id/pet.gif" },
    },
  },
}), {
  id: "fallback-id",
  name: "Fallback name",
  summary: "summary",
  source: "",
  palette: "blue",
  motion: "walk",
  scale: 1.6,
  imageSrc: "chrome-extension://self-extension-id/pet.gif",
});

assert.deepEqual(policy.sanitizeActiveCompanionPet({
  id: "direct-id",
  pet: { scale: -2, asset_url: "data:image/jpeg;base64,YQ==" },
}), {
  id: "direct-id",
  name: "A.G. companion",
  summary: "",
  source: "",
  palette: "blue",
  motion: "walk",
  scale: 0.65,
  imageSrc: "data:image/jpeg;base64,YQ==",
});

const noPet = policy.sanitizeActiveCompanionPet({ companion_id: "no-pet", pet: null });
assert.equal(noPet.scale, 1);
assert.equal(noPet.imageSrc, "");
const noSprite = policy.sanitizeActiveCompanionPet({
  companion_id: "no-sprite",
  pet: { sprite: "bad", scale: "not-a-number" },
});
assert.equal(noSprite.scale, 1);
assert.equal(noSprite.imageSrc, "");

assert.equal(policy.shortLangTag(" EN-us "), "en");
assert.equal(policy.shortLangTag("am_ET"), "am");
assert.equal(policy.shortLangTag(""), "");
assert.deepEqual(policy.parseLanguageCodes("en-US, am-ET, ,fr"), ["en", "am", "fr"]);
assert.deepEqual(policy.parseLanguageCodes(null), []);
assert.equal(
  policy.formatLanguageChipText({ input_languages: "en-US,en-GB,am-ET", language_primary: "am-ET" }),
  "Hears en·am · Speaks am",
);
assert.equal(
  policy.formatLanguageChipText({ input_language_primary: "fr-FR", language: "en-US" }, "am-ET"),
  "Hears fr · Speaks am",
);
assert.equal(policy.formatLanguageChipText({ input_languages: "en-US" }), "Hears en");
assert.equal(policy.formatLanguageChipText({ language_primary: "am-ET" }), "Speaks am");
assert.equal(policy.formatLanguageChipText(null), "");

const validAvatar = {
  version: 1,
  active: {
    avatar_behavior: {
      type: "avatar_behavior",
      artifact_id: "avatar-1",
      spec: { motion: "pulse", trigger: "speaking" },
    },
  },
};
assert.equal(policy.sanitizeAvatarBehaviorRuntime(null), null);
assert.equal(policy.sanitizeAvatarBehaviorRuntime({ ...validAvatar, version: 2 }), null);
assert.equal(policy.sanitizeAvatarBehaviorRuntime({
  ...validAvatar,
  active: { avatar_behavior: { ...validAvatar.active.avatar_behavior, type: "other" } },
}), null);
assert.equal(policy.sanitizeAvatarBehaviorRuntime({
  ...validAvatar,
  active: { avatar_behavior: { ...validAvatar.active.avatar_behavior, spec: null } },
}), null);
assert.equal(policy.sanitizeAvatarBehaviorRuntime({
  ...validAvatar,
  active: { avatar_behavior: { ...validAvatar.active.avatar_behavior, spec: "invalid" } },
}), null);
assert.equal(policy.sanitizeAvatarBehaviorRuntime({
  ...validAvatar,
  active: { avatar_behavior: { ...validAvatar.active.avatar_behavior, spec: { motion: "invalid", trigger: "speaking" } } },
}), null);
assert.equal(policy.sanitizeAvatarBehaviorRuntime({
  ...validAvatar,
  active: { avatar_behavior: { ...validAvatar.active.avatar_behavior, spec: { motion: "pulse", trigger: "invalid" } } },
}), null);
assert.deepEqual(policy.sanitizeAvatarBehaviorRuntime(validAvatar), {
  id: "avatar-1",
  motion: "pulse",
  trigger: "speaking",
  intensity: "normal",
  duration: "while_active",
});
assert.deepEqual(policy.sanitizeAvatarBehaviorRuntime({
  version: 1,
  active: {
    avatar_behavior: {
      type: "avatar_behavior",
      artifact_id: "x".repeat(100),
      spec: { motion: "float", trigger: "idle", intensity: "strong", duration: "while_active" },
    },
  },
}), {
  id: "x".repeat(80),
  motion: "float",
  trigger: "idle",
  intensity: "strong",
  duration: "while_active",
});
assert.equal(policy.sanitizeAvatarBehaviorRuntime({
  version: 1,
  active: {
    avatar_behavior: {
      type: "avatar_behavior",
      artifact_id: 42,
      spec: { motion: "still", trigger: "done", intensity: "invalid", duration: "invalid" },
    },
  },
}).id, "");

console.log("content companion policy runtime tests passed");
