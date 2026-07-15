"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { COMMAND_VERBS, createCompanionCatalogStore } = require("../lib/companion-catalog");

function fixture(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-companion-catalog-test-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return { dataDir, store: createCompanionCatalogStore({ dataDir, ...options }) };
}

test("lists, searches, previews, and compiles builtin companions", (t) => {
  const { store } = fixture(t);
  const all = store.list();
  assert.ok(all.length >= 10);
  assert.equal(store.version, "companion-catalog/v1");
  assert.deepEqual(store.commandVerbs(), [...COMMAND_VERBS]);
  assert.equal(store.list({ q: "research", limit: 1 }).length, 1);
  assert.equal(store.list({ query: "no such companion", limit: "bad" }).length, 0);
  assert.equal(store.list({ limit: 999 }).length, all.length);
  assert.equal(store.get("!!!"), null);
  assert.equal(store.get("missing"), null);
  const steward = store.get("shigmi-steward");
  assert.equal(steward.source, "builtin");
  assert.equal(steward.voice_binding.provider, "gemini-tts");
  assert.equal(steward.voice_binding.custom_voice.status, "not_configured");
  const preview = store.preview("shigmi-steward");
  assert.equal(preview.mutates_profile, false);
  assert.equal(preview.profile_overrides.active_companion_id, "shigmi-steward");
  assert.equal(store.compileProfilePatch({ companionId: "shigmi-scout" }).voice, "Orus");
  assert.throws(() => store.preview({ id: "missing" }), /not found/);
  assert.throws(() => store.preview(""), /not found/);
  assert.throws(() => store.compileProfilePatch("missing"), /not found/);
});

test("reports every custom voice binding readiness state", (t) => {
  const cases = [
    [{ customVoice: { access_configured: true, enrollment_id: "enroll", consent_granted: true } }, "ready"],
    [{ customVoice: { access_configured: true, enrollment_id: "enroll", consent_required: true } }, "consent_required"],
    [{ customVoice: { access_configured: true, enrollment_id: "enroll", last_error: "provider failed" } }, "error"],
    [{ provider: " CHIRP 3 ", customVoice: { provider: " Custom Provider ", consent_required: false } }, "not_configured"],
  ];
  for (const [voiceBinding, expected] of cases) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-companion-voice-test-"));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const binding = createCompanionCatalogStore({ dataDir, voiceBinding }).get("shigmi-steward").voice_binding;
    assert.equal(binding.custom_voice.status, expected);
  }
  const presets = new Map([
    ["shigmi-scribe", "warm"], ["shigmi-tinker", "bright"], ["shigmi-builder", "steady"],
    ["shigmi-scout", "formal"], ["shigmi-steward", "measured"],
  ]);
  for (const [id, preset] of presets) assert.equal(createCompanionCatalogStore({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "moa-preset-")) }).get(id).voice_binding.style.preset, preset);
});

test("creates rich drafts and sanitizes manifest and pet fields", (t) => {
  const { store } = fixture(t);
  const draft = store.createDraft({
    text: "I want you to act as my playful research coding writing browser screen coach from now on",
    name: "'Nova!'",
    voice: "Puck",
    persona: "calm\u0000 persona\nwith controls",
    voiceProfile: { kind: "custom", voiceId: "Leda", customVoiceRef: "clone-ref" },
    provenance: {
      characterName: "Nova",
      referenceMediaUrls: ["https://example.test/ref.png", "http://bad.test", "not a url"],
      licenseNote: "owned",
      consent_state: "approved",
    },
    commandVerbs: ["walk", "walk", "wave", "unknown"],
    visibility: "shared",
    imageDataUrl: "data:image/png;base64,AAAA",
    rules: [
      { trigger: "user asks", action: "propose a plan", summary: "plan", enabled: true },
      { id: "disabled", trigger: "later", action: "wait", enabled: false },
      { trigger: "", action: "invalid" },
    ],
    pet: {
      family: "Custom Family",
      skin: "Scout Skin",
      palette: "green",
      motion: "climb",
      scale: 9,
      assetUrl: "https://example.test/sprite.png",
      frameWidth: 0.1,
      frameHeight: 9999,
      frameCount: 7,
      transparent: false,
      behaviors: [{ name: "watch", weight: 30, interruptible: false }, "idle", {}],
      actions: [{ name: "run", kind: "run", frames: 99, frameMs: 20, vx: 999, vy: -999, loop: false }, "idle", {}],
      generation: { imageModel: "model bad name", animationModel: "veo@test", prompt: "custom prompt" },
    },
  });
  assert.equal(draft.name, "Nova");
  assert.equal(draft.persona, "calm persona with controls");
  assert.deepEqual(draft.command_verbs, ["walk", "wave"]);
  assert.equal(draft.provenance.reference_media_urls.length, 1);
  assert.equal(draft.voice_profile.kind, "custom");
  assert.equal(draft.pet.scale, 1.6);
  assert.equal(draft.pet.sprite.type, "image-data-url");
  assert.equal(draft.pet.sprite.frame_width, 1);
  assert.equal(draft.pet.sprite.frame_height, 512);
  assert.equal(draft.pet.actions[0].vx, 600);
  assert.equal(draft.pet.actions[0].vy, -600);
  assert.match(draft.profile_patch.system_prompt, /Rule rule-1/);
  assert.equal(store.list({ q: "nova" })[0].id, draft.id);

  const duplicate = store.createDraft({ request: "be a calm terse assistant please", name: "Nova" });
  assert.equal(duplicate.id, `${draft.id}-2`);
  assert.equal(duplicate.voice, "Leda");
  assert.equal(duplicate.profile_patch.voice_max_chars, 160);
  const writing = store.createDraft({ prompt: "serve as a writing coach who explains details" });
  assert.equal(writing.voice, "Aoede");
  assert.equal(writing.profile_patch.voice_max_chars, 360);
  const coding = store.createDraft({ description: "make yourself into a coding builder" });
  assert.equal(coding.voice, "Charon");
  const formal = store.createDraft({ text: "research compare formal" });
  assert.equal(formal.voice, "Orus");
});

test("creates agents and idempotent bookmarks with scoped lookup", (t) => {
  const { store } = fixture(t);
  const first = store.createAgent({ name: "Agent One", text: "coding helper" });
  const second = store.createAgent({ name: "Agent One", text: "coding helper" });
  assert.notEqual(first.id, second.id);
  assert.equal(store.listAgents({ q: "coding", limit: 1 }).length, 1);
  assert.ok(store.listAgents({ query: first.id }).length >= 1);
  assert.equal(store.getAgent(first.id).url, `/pets/?agent=${first.id}`);
  assert.equal(store.getAgent("!!!"), null);
  assert.equal(store.getAgent("missing"), null);
  const bookmark = store.createBookmark({ agentId: first.id });
  assert.equal(store.createBookmark({ agent_id: first.id }).id, bookmark.id);
  assert.equal(store.listBookmarks({ q: "coding", limit: 1 }).length, 1);
  assert.equal(store.listBookmarks({ query: bookmark.id }).length, 1);
  assert.equal(store.getBookmark(bookmark.id).url, `/pets/?agent=${first.id}`);
  assert.equal(store.getBookmark("!!!"), null);
  assert.equal(store.getBookmark("missing"), null);
  const builtinBookmark = store.createBookmark({ companionId: "shigmi-steward" });
  assert.match(builtinBookmark.url, /companion=shigmi-steward/);
  assert.throws(() => store.createBookmark({ companion_id: "missing" }), /not found/);
});

test("tracks clone jobs, safe references, fallback bindings, and publication consent", (t) => {
  const { store } = fixture(t);
  const approved = store.createDraft({
    name: "Cloneable",
    text: "voice pet",
    provenance: { consent_state: "approved" },
  });
  const dry = store.createVoiceCloneJob({
    companionId: approved.id,
    consent: { attested: true, subject: "voice owner" },
    reference: { kind: "audio", audio_bytes: 123.4, audio_sha256: "AA:bb!!", url: "https://example.test/audio" },
  });
  assert.equal(dry.job.status, "blocked_allowlist");
  assert.equal(dry.job.reference.audio_bytes, 123);
  assert.equal(dry.job.reference.audio_sha256, "aabb");
  assert.equal(dry.companion.voice_clone.job_id, dry.job.id);
  assert.equal(dry.companion.voice_binding.custom_voice.status, "blocked_allowlist");
  const live = store.createVoiceCloneJob({ id: approved.id, live: true, reference: { kind: "url", url: "http://unsafe.test" } });
  assert.equal(live.job.status, "not_implemented_live");
  assert.equal(live.job.mode, "live");
  assert.equal(store.listVoiceCloneJobs(approved.id).length, 2);
  assert.equal(store.getVoiceCloneJob(live.job.id).id, live.job.id);
  assert.equal(store.getVoiceCloneJob(), null);
  assert.equal(store.getVoiceCloneJob("missing"), null);
  assert.throws(() => store.createVoiceCloneJob({ id: "missing" }), /not found/);

  const published = store.publishCompanion({ companionId: approved.id });
  assert.equal(published.visibility, "shared");
  assert.equal(store.listShared({ q: "cloneable" }).length, 1);
  const rejected = store.createDraft({ name: "Rejected", provenance: { consent_state: "rejected" } });
  assert.throws(() => store.publishCompanion({ id: rejected.id }), (error) => error.code === "consent_not_approved" && error.reason === "rejected");
  assert.throws(() => store.publishCompanion({ id: "missing" }), /not found/);
});

test("reloads valid state and tolerates corrupt and legacy projections", (t) => {
  const { store, dataDir } = fixture(t);
  const agent = store.createAgent({ name: "Persisted", text: "calm assistant" });
  store.createBookmark({ agent_id: agent.id });
  store.createVoiceCloneJob({ id: agent.companion_id });
  const reloaded = createCompanionCatalogStore({ dataDir });
  assert.equal(reloaded.getAgent(agent.id).id, agent.id);
  assert.equal(reloaded.listBookmarks().length, 1);
  assert.equal(reloaded.listVoiceCloneJobs(agent.companion_id).length, 1);

  fs.writeFileSync(store.catalogPath, "not json");
  assert.equal(createCompanionCatalogStore({ dataDir }).listAgents().length, 0);
  fs.writeFileSync(store.catalogPath, JSON.stringify({
    companions: [null, { id: "bad" }, { id: "legacy", name: "Legacy" }],
    agents: [null, { id: "bad", companion_id: "missing" }, { id: "legacy-agent", companion_id: "legacy" }],
    bookmarks: [null, { id: "bad", companion_id: "missing" }, { id: "legacy-bookmark", companion_id: "legacy" }],
    voice_clone_jobs: [null, [], { id: 2 }, { id: "legacy-job", companion_id: "legacy" }],
  }));
  const legacy = createCompanionCatalogStore({ dataDir });
  assert.equal(legacy.get("legacy").manifest_version, "companion-manifest/v2");
  assert.equal(legacy.getAgent("legacy-agent").id, "legacy-agent");
  assert.equal(legacy.getBookmark("legacy-bookmark").id, "legacy-bookmark");
  assert.equal(legacy.getVoiceCloneJob("legacy-job").id, "legacy-job");
});

test("covers fallback manifest, role, asset, and persistence shapes", (t) => {
  const { store, dataDir } = fixture(t);
  const inline = store.preview({ companion: { id: "inline", name: "Inline" } });
  assert.equal(inline.companion.source, "builtin");
  assert.equal(inline.companion.version, "companion_v0001");
  assert.equal(inline.companion.summary, "Inline companion.");
  assert.equal(inline.profile_overrides.voice, "Kore");
  assert.equal(store.preview({ companion: { id: "inline-profile", name: "Inline Profile", profile_patch: { voice: "Leda" } } }).profile_overrides.voice, "Leda");

  const fallback = store.createDraft();
  assert.match(fallback.name, /^Shigmi/);
  assert.match(fallback.summary, /Custom companion/);
  assert.equal(fallback.voice, "Kore");
  const playful = store.createDraft({ text: "be my playful mascot" });
  assert.equal(playful.voice, "Puck");
  assert.equal(playful.appearance.mascot, "spark");
  const imageUrl = store.createDraft({
    text: "plain",
    pet: {
      asset_url: "http://example.test/pet.png",
      palette: "invalid",
      motion: "invalid",
      scale: "bad",
      image_data_url: "data:text/plain;base64,AAAA",
      behaviors: [],
      actions: [{ id: "mystery", kind: "unknown", vx: "bad", vy: null }],
      generation: { image_model: "!!!", animation_model: "" },
    },
  });
  assert.equal(imageUrl.pet.sprite.type, "image-url");
  assert.equal(imageUrl.pet.palette, "blue");
  assert.equal(imageUrl.pet.motion, "walk");
  assert.equal(imageUrl.pet.scale, 1);
  assert.equal(imageUrl.pet.actions[0].kind, "idle");
  assert.equal(imageUrl.pet.generation.image_model, "gemini-3.1-flash-image");
  const invalidAsset = store.createDraft({ pet: { asset_url: "not a url", source_image: "x", behaviors: [{}], actions: [{}] } });
  assert.equal(invalidAsset.pet.sprite.type, "css-shigmi");
  assert.ok(invalidAsset.pet.behaviors.length > 0);
  assert.ok(invalidAsset.pet.actions.length > 0);
  assert.equal(store.createDraft({ pet: { asset_url: "ftp://example.test/pet.png" } }).pet.sprite.type, "css-shigmi");

  const catalogPath = path.join(dataDir, "companion-catalog.json");
  fs.writeFileSync(catalogPath, JSON.stringify({ companions: {}, agents: {}, bookmarks: {}, voice_clone_jobs: {} }));
  const empty = createCompanionCatalogStore({ dataDir });
  assert.equal(empty.listAgents().length, 0);
  assert.equal(empty.listBookmarks().length, 0);
  assert.equal(empty.listVoiceCloneJobs("anything").length, 0);
});

test("covers list limits, unreviewed consent, and clone-reference omissions", (t) => {
  const { store } = fixture(t);
  const local = store.createDraft({ name: "Local Only", provenance: {}, command_verbs: "bad" });
  assert.deepEqual(local.command_verbs, [...COMMAND_VERBS]);
  assert.throws(
    () => store.publishCompanion({ id: local.id }),
    (error) => error.code === "consent_not_approved" && error.reason === "unreviewed",
  );
  const clone = store.createVoiceCloneJob({
    id: local.id,
    reference: { kind: "other", audio_bytes: -1, audio_sha256: "!!!", url: "x" },
  });
  assert.deepEqual(clone.job.reference, { kind: "" });
  assert.equal(store.listAgents({ q: "none", limit: 0 }).length, 0);
  assert.equal(store.listBookmarks({ q: "none", limit: "bad" }).length, 0);
  assert.equal(store.createVoiceCloneJob({ id: "shigmi-steward" }).job.status, "blocked_allowlist");
});

test("supports the default data directory without leaking test state", (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "moa-companion-default-dir-"));
  const previous = process.cwd();
  t.after(() => {
    process.chdir(previous);
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  process.chdir(cwd);
  const store = createCompanionCatalogStore();
  assert.ok(store.list().length > 0);
  process.chdir(previous);
});
