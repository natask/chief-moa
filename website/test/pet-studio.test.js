import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createPetStudio } from "../public/pets/studio.js";

const htmlPath = new URL("../public/pets/index.html", import.meta.url);

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

async function setup(overrides = {}) {
  const html = await readFile(htmlPath, "utf8");
  const dom = new JSDOM(html, { url: overrides.url || "https://agee.app/pets/" });
  const calls = [];
  const pet = {
    id: "buddy", companion_id: "buddy", companion_name: "Buddy",
    companion_summary: "A calm blue scout", voice: "Kore", source: "custom",
    pet: { palette: "blue", motion: "peek", scale: 1, behaviors: [{ id: "idle", label: "Idle" }] },
    rules: [], tags: ["scout"], starters: [],
  };
  dom.window.requestAnimationFrame = (callback) => { dom.window.__frame = callback; return 1; };
  dom.window.cancelAnimationFrame = () => {};
  class AudioContextMock {
    constructor() { this.state = "running"; this.currentTime = 1; this.sampleRate = 48000; this.destination = {}; }
    resume() { this.state = "running"; return Promise.resolve(); }
    close() { return Promise.resolve(); }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createScriptProcessor() { return { connect() {}, disconnect() {}, onaudioprocess: null }; }
    createBuffer(channels, length, rate) {
      const data = new Float32Array(length);
      return { duration: length / rate, getChannelData() { return { set(values) { data.set(values); } }; } };
    }
    createBufferSource() {
      return { buffer: null, playbackRate: { value: 1 }, connect() {}, start() {}, stop() {}, onended: null };
    }
  }
  dom.window.AudioContext = AudioContextMock;
  class SocketMock {
    static instances = [];
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; SocketMock.instances.push(this); }
    send(value) { this.sent.push(value); }
    close() { this.readyState = 3; }
  }
  dom.window.WebSocket = SocketMock;
  Object.defineProperty(dom.window.navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) },
  });
  dom.window.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (overrides.fetch) {
      const answer = await overrides.fetch(url, init, pet);
      if (answer) return answer;
    }
    if (url === "/api/pets") return jsonResponse({ pets: [pet], generation: { configured: true } });
    if (url === "/api/pets/active") return jsonResponse({ active_companion: { companion: pet }, profile_voice: "Kore" });
    if (url.startsWith("/api/voice/turns")) return jsonResponse({ turns: [] });
    if (url === "/api/profile/options") return jsonResponse({ voices: [{ id: "Puck", description: "Bright" }, { id: "Kore", tone_tags: ["clear"] }] });
    if (url === "/api/pets/shared") return jsonResponse({ error: "missing" }, 404);
    return jsonResponse({ pet, agent: pet, profile: { active_companion_name: "Buddy" }, ok: true });
  };
  Object.defineProperty(dom.window.HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value() { return { left: 0, top: 0, width: 640, height: 480, right: 640, bottom: 480 }; },
  });
  dom.window.HTMLElement.prototype.setPointerCapture = () => {};
  const api = createPetStudio(dom.window, dom.window.document);
  await api.loadPets();
  await new Promise((resolve) => setTimeout(resolve, 5));
  return { dom, api, calls, pet };
}

test("pure pet normalization and prompt derivation cover bounded variants", async () => {
  const { dom, api } = await setup();
  const record = api.petRecord("id", "Name", "Summary", "red", "walk", "skin");
  assert.equal(record.pet.palette, "red");
  assert.equal(api.normalizePet({ companion: record }).id, "id");
  assert.equal(api.normalizePet({ id: "nested", pet: {} }).id, "nested");
  assert.equal(api.normalizePet({ companion_id: "c", name: "C", summary: "S", pet: null }).companion_name, "C");
  assert.equal(api.mergePets([record, record], [{ ...record, id: "two" }]).length, 2);
  assert.equal(api.cleanText("  hello\nthere  ", 7), "hello t");
  assert.equal(api.cleanBookmarkUrl("javascript:bad", "id"), "/pets/?agent=id");
  assert.equal(api.cleanBookmarkUrl("https://example.com/a", "id"), "/pets/?agent=id");
  assert.equal(api.cleanBookmarkUrl("/pets/?agent=other", "id"), "/pets/?agent=other");
  assert.equal(api.agentUrl("a b").includes("a%20b"), true);
  assert.deepEqual(api.sanitizeRules([{ id: "a", trigger: "  work ", action: "  focus ", enabled: false }, { trigger: "", action: "" }, null]), [{ id: "a", trigger: "work", action: "focus", enabled: false, summary: "work -> focus" }]);

  let draft = api.buildDraftFromPrompt("a gentle red fox named Ruby who loves to float");
  assert.equal(draft.palette, "red");
  assert.equal(draft.motion, "float");
  assert.equal(draft.voice, "Leda");
  assert.equal(draft.name, "Ruby");
  draft = api.buildDraftFromPrompt("mysterious robot builder");
  assert.equal(draft.palette, "graphite");
  assert.equal(api.titleCase("the quick-brown_fox"), "The Quick-Brown_fox");
  assert.equal(api.deriveName("a companion named"), "Named");
  assert.equal(api.matchHint("none", [], "fallback"), "fallback");

  dom.window.close();
});

test("voice, readiness, identity, and motion policies cover every state", async () => {
  const { dom, api, pet } = await setup();
  assert.equal(api.canonicalVoiceId("kore"), "Kore");
  assert.equal(api.canonicalVoiceId("unknown"), "");
  assert.equal(api.canonicalVoiceId(""), "");
  assert.equal(api.voiceBindingVoice({ voice_binding: { voice: "Puck" } }), "Kore");
  assert.equal(api.voiceBindingVoice({ voice_binding: { provider_voice_id: "Puck" } }), "Puck");
  assert.equal(api.voiceBindingVoice({ companion: { voice: "Leda" } }), "Kore");
  assert.equal(api.voiceBindingVoice({ voice: "Aoede" }), "Kore");
  assert.equal(api.customVoiceState({ voice_binding: { mode: "custom", custom_voice: { status: "ready" } } }).status, "ready");
  assert.equal(api.cloneJobStatus({ voice_clone: { status: "running" } }), "running");
  assert.equal(api.voiceReadiness({ voice_binding: { mode: "custom", custom_voice: { status: "ready" } } }).kind, "ready");
  assert.equal(api.voiceReadiness({ voice_binding: { mode: "custom", custom_voice: { status: "error", error: "bad" } } }).kind, "error");
  assert.equal(api.voiceReadiness({ voice_clone: { status: "queued" } }).kind, "waiting");
  assert.equal(api.voiceReadiness({ voice_clone: { status: "error" } }).kind, "error");
  assert.equal(api.voiceReadiness(pet).kind, "waiting");
  assert.equal(api.voiceDescription("Kore").length > 0, true);
  assert.equal(api.voiceDescription("missing"), "");

  for (const motion of ["float", "trail", "tap", "spark", "climb", "peek", "walk"]) {
    assert.ok(api.motionMode(motion));
    api.state.motion = motion;
    for (const random of [0, 0.99]) {
      const original = Math.random;
      Math.random = () => random;
      assert.ok(api.randomMode());
      Math.random = original;
    }
  }
  api.state.selected = null;
  assert.equal(api.petDisplayName(), "Pet");
  assert.equal(api.petPersona(), undefined);
  api.state.selected = pet;
  assert.deepEqual(api.petPersona(), { name: "Buddy", text: "A calm blue scout" });
  assert.equal(api.voiceSessionId(), "petweb_buddy");
  dom.window.localStorage.clear();
  const device = api.voiceDeviceId();
  assert.equal(api.voiceDeviceId(), device);
  assert.match(device, /^petweb_/);
  assert.equal(api.turnsSessionId(), "petweb_buddy");
  assert.equal(api.publishBlockMessage({ code: "not_publishable" }).includes("Built-in"), true);
  assert.equal(api.publishBlockMessage({ reason: "rejected" }).includes("rejected"), true);
  assert.equal(api.publishBlockMessage({ error: "Review" }), "Review");
  assert.equal(api.publishBlockMessage({}), "This character needs consent and provenance review before it can be shared.");
  dom.window.close();
});

test("dashboard initialization and controls render and dispatch network actions", async () => {
  const { dom, api, calls } = await setup();
  const d = dom.window.document;
  assert.equal(d.querySelectorAll("#catalog .pet-row").length, 1);
  assert.equal(d.querySelectorAll("#paletteControls button").length, 8);
  assert.equal(d.querySelectorAll("#motionControls button").length, 7);
  d.querySelector('[data-palette="red"]').click();
  d.querySelector('[data-motion="float"]').click();
  d.querySelector('#voiceControls [data-voice="Puck"]').click();
  assert.equal(api.state.palette, "red");
  assert.equal(api.state.motion, "float");
  assert.equal(api.state.voice, "Puck");
  d.getElementById("scaleInput").value = "1.4";
  d.getElementById("scaleInput").dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  d.getElementById("rateInput").value = "1.25";
  d.getElementById("rateInput").dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  assert.equal(api.state.scale, 1.4);
  assert.equal(api.state.rate, 1.25);
  d.getElementById("tabStudio").click();
  assert.equal(api.state.view, "studio");
  d.getElementById("tabAgent").click();
  assert.equal(api.state.view, "agent");
  d.getElementById("addRuleBtn").click();
  assert.equal(d.querySelectorAll("#ruleList .rule-row").length, 1);
  d.querySelector("#ruleList .rule-remove").click();
  assert.equal(d.querySelectorAll("#ruleList .rule-row").length, 0);
  d.getElementById("previewBtn").click();
  d.getElementById("shareBtn").click();
  d.getElementById("applyBtn").click();
  d.getElementById("defaultVoiceBtn").click();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(calls.some((call) => call.url === "/api/pets/preview"));
  assert.ok(calls.some((call) => call.url === "/api/pets/bookmarks"));
  assert.ok(calls.some((call) => call.url === "/api/pets/apply"));
  dom.window.close();
});

test("conversation rendering, audio conversion, and voice events handle terminal paths", async () => {
  const { dom, api, pet } = await setup();
  const d = dom.window.document;
  api.state.selected = pet;
  api.state.turns = [
    { turn_id: "one", transcript: "hello", reply: "hi", created_at: "2026-07-15T10:00:00Z", has_user_audio: true, has_assistant_audio: true },
    { id: "two", transcript: "text", reply_text: "answer", status: "completed" },
  ];
  api.renderTurns();
  assert.equal(d.querySelectorAll("#tape .turn").length, 2);
  assert.equal(api.findTurn("one").reply, "hi");
  assert.equal(api.findTurn("missing"), null);
  assert.equal(api.playKey(api.state.turns[0], "original"), "one:original");
  assert.equal(api.playKey(api.state.turns[0], "revoice"), "one:revoice:Kore");
  assert.ok(api.formatTurnTime("2026-07-15T10:00:00Z"));
  assert.equal(api.formatTurnTime("bad"), "");
  const pcm = api.downsamplePcm16(new Float32Array([-2, -0.5, 0.5, 2]), 16000, 16000);
  assert.equal(new Int16Array(pcm).length, 4);
  assert.equal(api.downsamplePcm16(null, 1, 1), null);
  assert.equal(api.downsamplePcm16(new Float32Array([1]), 1, 4) instanceof ArrayBuffer, true);

  api.voice.state = "thinking";
  api.handleVoiceEvent({ type: "turn_progress", stage: "tts" });
  api.handleVoiceEvent({ type: "transcript_partial", text: "hel" });
  api.handleVoiceEvent({ type: "transcript_final", text: "hello" });
  api.handleVoiceEvent({ type: "assistant_text", text: "hi" });
  api.handleVoiceEvent({ type: "assistant_audio_start", playback_rate: 1.2 });
  assert.equal(api.voice.state, "speaking");
  api.voice.gotReplyAudio = false;
  api.handleVoiceTurnDone({ status: "completed" });
  assert.equal(api.voice.state, "idle");
  api.voice.state = "thinking";
  api.handleVoiceTurnDone({ status: "no_speech" });
  api.voice.state = "thinking";
  api.handleVoiceTurnDone({ status: "failed", reason: "bad" });
  api.handleVoiceEvent(null);
  api.handleVoiceEvent({ type: "unknown" });
  api.handleVoiceEvent({ type: "error", message: "oops" });
  dom.window.close();
});

test("fallback, describe, publishing and shared-library error branches stay usable", async () => {
  const { dom, api, calls } = await setup({
    fetch: async (url) => {
      if (url === "/api/pets" || url === "/api/pets/active") throw new Error("offline");
      if (url === "/api/pets/shared") return jsonResponse({ pets: [{ id: "shared", companion_name: "Shared", pet: {} }] });
      if (url.includes("/publish")) return jsonResponse({ reason: "rejected" }, 409);
      if (url === "/api/pets/generate") return jsonResponse({ images: [{ data_url: "data:image/png;base64,AA==" }] });
      return null;
    },
  });
  assert.ok(api.state.pets.length >= 4);
  api.state.selected = api.state.pets[0];
  await api.loadSharedLibrary();
  assert.equal(api.features.sharedLibrary, true);
  await api.publishSelected();
  assert.ok(dom.window.document.getElementById("consoleTitle").textContent.includes("Publish"));
  const draft = await api.deriveDraft("a warm violet wizard named Iris");
  assert.equal(draft.record.companion_name, "Iris");
  api.state.describedDraft = draft.record;
  api.state.describedServerBacked = draft.serverBacked;
  api.selectPet(draft.record);
  dom.window.document.getElementById("describeInput").value = "a bright blue scout named Sky";
  await api.applyDescribedCharacter();
  assert.ok(api.state.selected.companion_name);
  assert.ok(calls.some((call) => call.url === "/api/pets"));
  dom.window.close();
});

test("storage, generation, describe and catalog actions exercise browser adapters", async () => {
  const { dom, api, pet, calls } = await setup({
    fetch: async (url) => {
      if (url.includes("/api/voice/audio")) return new Response(new Int16Array([1, -1]).buffer, { headers: { "content-type": "application/octet-stream" } });
      if (url === "/api/pets/generate") return jsonResponse({ status: "not_configured" });
      if (url === "/api/pets/agents/missing") return jsonResponse({ error: "gone" }, 404);
      return null;
    },
  });
  const d = dom.window.document;
  dom.window.localStorage.setItem("moa.petStudio.agents.v1", "bad json");
  assert.deepEqual(api.getLocalAgents(), []);
  api.saveLocalAgent({ ...pet, id: "saved" });
  assert.equal(api.findLocalAgent("saved").id, "saved");
  assert.equal((await api.loadAgent("missing")), null);
  assert.equal((await api.loadAgent("buddy")).id, "buddy");

  await api.generateImage();
  assert.equal(d.getElementById("formHint").textContent, "Generation not configured");
  d.getElementById("describeInput").value = "";
  await api.describeCharacter();
  assert.match(d.getElementById("describeStatus").textContent, /Describe/);
  d.getElementById("describeInput").value = "a calm green fox called Fern";
  await api.describeCharacter();
  assert.ok(api.state.describedDraft);
  await api.runDescribeGeneration("prompt", api.state.selected);

  api.state.turns = [{ turn_id: "audio", reply: "reply", has_assistant_audio: true }];
  await api.playTurnAudio(api.state.turns[0], "original");
  assert.equal(api.player.key, "audio:original");
  api.stopPlayback();
  await api.playTurnAudio(api.state.turns[0], "revoice");
  assert.ok(calls.some((call) => call.url === "/api/voice/synthesize"));

  api.state.pets.push({ ...pet, id: "other", companion_id: "other", companion_name: "Other" });
  api.state.query = "other";
  api.renderCatalog();
  assert.equal(d.querySelectorAll("#catalog .pet-row").length, 1);
  d.querySelector("#catalog .pet-row").click();
  api.state.query = "none";
  api.renderCatalog();
  assert.equal(d.querySelectorAll("#catalog .pet-row").length, 0);
  dom.window.close();
});

test("pointer, voice socket, capture and animation lifecycles cover platform seams", async () => {
  const { dom, api } = await setup();
  const petElement = dom.window.document.getElementById("pet");
  api.startDrag({ clientX: 10, clientY: 10, pointerId: 1 });
  api.dragMove({ clientX: 40, clientY: 45 });
  assert.equal(api.state.drag, true);
  api.moveToPointer({ clientX: 200, clientY: 180 });
  api.endDrag();
  assert.equal(api.state.drag, false);
  api.clampPosition();
  api.positionPet();
  assert.match(petElement.style.transform, /translate/);

  await api.startCapture();
  assert.ok(api.voice.processor);
  api.voice.state = "listening";
  api.voice.processor.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.2) } });
  assert.equal(api.voice.pending.length, 1);
  api.openVoiceSocket("wss://voice.example/session");
  const socket = dom.window.WebSocket.instances[0];
  socket.readyState = 1;
  socket.onopen();
  assert.ok(socket.sent.length >= 2);
  socket.onmessage({ data: JSON.stringify({ type: "assistant_text", text: "hello" }) });
  socket.onmessage({ data: new Int16Array([1, 2]).buffer });
  api.stopTalk();
  api.commitVoiceTurn();
  api.cancelVoiceTurn();

  api.state.last = 100;
  api.state.nextModeAt = 0;
  api.state.mode = "walk";
  api.tick(200);
  api.state.mode = "climb"; api.state.y = 10; api.tick(250);
  api.state.mode = "fall"; api.state.y = 400; api.tick(300);
  api.state.mode = "float"; api.tick(350);
  assert.equal(typeof dom.window.__frame, "function");
  dom.window.close();
});

test("fallback-value and status matrix preserves every user-visible policy", async () => {
  const { dom, api, pet } = await setup({ url: "https://agee.app/pets/#studio" });
  const d = dom.window.document;
  const minimal = api.normalizePet({ id: "minimal" });
  assert.equal(minimal.companion_name, "Custom pet");
  assert.equal(minimal.pet.renderer, "shimeji-web");
  const nested = api.normalizePet({ companion: { id: "nested", name: "Nested", summary: "sum", source: "user", tags: ["x"], voice: "Puck", rules: [{ trigger: "a", action: "b" }], starters: ["hi"], pet: { renderer: "r", family: "f", skin: "s", palette: "red", motion: "tap", scale: 2, sprite: { type: "x" }, behaviors: [{ id: "x" }] } } });
  assert.equal(nested.pet.scale, 2);
  assert.equal(nested.source, "user");
  assert.deepEqual(api.sanitizeRules("bad"), []);
  assert.equal(api.sanitizeRules([{ trigger: "a", action: "b", summary: "custom" }])[0].summary, "custom");
  assert.equal(api.cleanText(null, 10), "");
  assert.equal(api.findPet("absent"), null);
  assert.equal(api.findLocalAgent("absent"), null);

  for (const [status, kind] of [
    ["blocked_allowlist", "waiting"], ["allowlist_pending", "waiting"],
    ["allowlist_blocked", "waiting"], ["not_implemented_live", "waiting"],
    ["pending", "waiting"], ["processing", "waiting"], ["running", "waiting"],
    ["consent_required", "waiting"], ["error", "error"],
  ]) assert.equal(api.voiceReadiness({ voice_clone: { status } }).kind, kind);
  assert.equal(api.voiceReadiness({ voice_binding: { custom_voice: { access_required: true } } }).kind, "waiting");
  assert.equal(api.cloneJobStatus(null), "not_configured");
  assert.equal(api.customVoiceState(null), null);
  assert.equal(api.voiceBinding(null), null);

  api.selectPet(null);
  api.state.selected = { ...minimal, pet: { ...minimal.pet, palette: "missing", motion: "", sprite: null }, companion_name: "", companion_summary: "", source: "builtin", tags: null };
  api.state.palette = ""; api.state.motion = ""; api.state.scale = 0;
  api.applyPetVisual();
  api.refreshControlState();
  api.renderCatalog();
  api.state.activeId = api.state.selected.id;
  api.state.defaultVoice = "Puck";
  api.selectPet(api.state.selected);
  assert.equal(api.state.voice, "Puck");
  api.state.selected.voice_binding = {};
  d.querySelector('[data-palette="blue"]').click();
  assert.equal(api.state.selected.voice_binding.provider_voice_id, api.state.voice);

  api.state.selected = { ...pet, id: "", companion_id: "" };
  await api.publishSelected();
  api.state.selected = null;
  await api.publishSelected();
  assert.equal(api.ownsSelected(), false);
  for (const source of ["local", "draft", "custom", "user", "builtin"]) {
    api.state.selected = { ...pet, source };
    assert.equal(api.ownsSelected(), source !== "builtin");
  }
  d.getElementById("petName").value = "";
  d.getElementById("scaleInput").value = "0";
  assert.equal(api.formBody().name, "Shigmi Companion");

  api.state.turns = [];
  api.renderTurns();
  assert.match(d.getElementById("tape").textContent, /No conversation/);
  api.state.turns = [{ turn_id: "plain", transcript: "", reply: "", created_at: "", has_user_audio: false, has_assistant_audio: false }];
  api.renderTurns();
  api.state.replayOffer = { turnId: "plain", from: "Kore", to: "Puck" };
  api.renderTurns();
  api.setView("unexpected");
  assert.equal(api.state.view, "unexpected");
  dom.window.close();
});

test("gateway response matrix covers optional success and failure payloads", async () => {
  let mode = "base";
  const { dom, api, pet } = await setup({
    url: "https://agee.app/pets/?agent=requested",
    fetch: async (url) => {
      if (url === "/api/profile/options" && mode === "bad-options") return jsonResponse({ voices: [] });
      if (url === "/api/pets/active" && mode === "active-pet") return jsonResponse({ active_companion: { pet }, profile_voice: "" });
      if (url === "/api/pets/shared" && mode.startsWith("shared-")) {
        if (mode === "shared-error") return jsonResponse({}, 500);
        const key = mode.slice(7);
        return jsonResponse({ [key]: [pet] });
      }
      if (url.includes("/publish") && mode.startsWith("publish-")) return jsonResponse({ error: "no" }, Number(mode.slice(8)));
      if (url === "/api/pets/install" && mode === "install-error") return jsonResponse({ error: "install no" }, 500);
      if (url === "/api/pets/generate" && mode === "generate-image") return jsonResponse({ images: [{ data_url: "data:image/png;base64,AA==" }] });
      if (url === "/api/pets/generate" && mode === "generate-plan") return jsonResponse({ status: "planned" });
      if (url === "/api/pets" && mode === "derive-server") return jsonResponse({ companion: pet });
      return null;
    },
  });
  mode = "bad-options"; await api.loadVoiceOptions();
  mode = "active-pet"; await api.loadActiveAgent();
  for (const key of ["shared", "items", "library", "characters"]) { mode = `shared-${key}`; await api.loadSharedLibrary(); }
  mode = "shared-error"; await api.loadSharedLibrary();
  api.state.selected = { ...pet, source: "custom" };
  for (const status of [501, 404, 500]) { mode = `publish-${status}`; await api.publishSelected(); }
  mode = "install-error"; await api.installShared(pet, null);
  mode = "generate-image"; await api.generateImage();
  mode = "generate-plan"; await api.generateImage();
  mode = "derive-server"; assert.equal((await api.deriveDraft("prompt")).serverBacked, true);
  dom.window.close();
});

test("guard and alternate-event matrix covers inert UI and voice branches", async () => {
  const { dom, api, pet } = await setup();
  const d = dom.window.document;
  for (const id of ["paletteControls", "motionControls", "voiceControls", "voiceList", "tape", "ruleList", "libraryList"]) {
    d.getElementById(id).dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  }
  dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "x" }));
  dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape" }));
  d.getElementById("describeInput").dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "x", bubbles: true }));
  d.getElementById("describeInput").value = "a blue helper named Key";
  d.getElementById("describeInput").dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  d.querySelector("#voiceList [data-voice]").click();
  const orphanAction = d.createElement("button"); orphanAction.dataset.act = "original"; d.getElementById("tape").appendChild(orphanAction); orphanAction.click();
  const fakeRow = d.createElement("div"); fakeRow.dataset.turnId = "missing"; const fakeAction = d.createElement("button"); fakeAction.dataset.act = "original"; fakeRow.appendChild(fakeAction); d.getElementById("tape").appendChild(fakeRow); fakeAction.click();
  d.getElementById("rateInput").value = "0";
  d.getElementById("rateInput").dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  d.getElementById("scaleInput").value = "0";
  d.getElementById("scaleInput").dispatchEvent(new dom.window.Event("input", { bubbles: true }));

  api.state.selected = null;
  await api.loadTurns();
  await api.makeDefaultVoice();
  api.state.selected = pet;
  api.state.defaultVoice = api.state.voice;
  await api.makeDefaultVoice();
  api.state.defaultVoice = "Puck";
  api.state.activeRaw = null;
  api.state.activeId = "";
  await api.makeDefaultVoice();

  api.voice.state = "thinking";
  dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape" }));
  api.voice.state = "thinking";
  api.handleVoiceEvent({ type: "turn_progress", stage: "reasoning" });
  api.handleVoiceEvent({ type: "assistant_audio_start", playback_rate: 0 });
  api.handleVoiceEvent({ type: "assistant_audio_done" });
  api.voice.state = "thinking";
  api.voice.ctx = new dom.window.AudioContext();
  api.voice.gotReplyAudio = true;
  api.voice.playHead = 1;
  api.handleVoiceTurnDone({});
  if (api.voice.finishTimer) { clearTimeout(api.voice.finishTimer); api.voice.finishTimer = null; }
  api.voice.turnDone = true;
  api.teardownVoice(false);

  api.openVoiceSocket("wss://voice.example/guards");
  const ws = dom.window.WebSocket.instances.at(-1);
  api.voice.ws = null;
  ws.onopen();
  ws.onmessage({ data: "not-json" });
  ws.onclose();
  api.openVoiceSocket("wss://voice.example/idle");
  const idle = dom.window.WebSocket.instances.at(-1);
  idle.readyState = 1; api.voice.state = "idle"; idle.onopen();
  api.voice.ws = idle; api.voice.state = "listening"; idle.onclose();

  api.voice.state = "idle"; api.stopTalk();
  api.voice.ws = null; api.commitVoiceTurn();
  api.flushPendingAudio();
  api.voice.ctx = null; api.playPcmChunk(null); api.playPcmChunk(new ArrayBuffer(1));
  api.voice.ctx = new dom.window.AudioContext(); api.playPcmChunk(new ArrayBuffer(1));
  api.voice.playbackRate = 0; api.playPcmChunk(new Int16Array([1]).buffer);

  api.state.pointerStart = null; api.dragMove({ clientX: 1, clientY: 1 }); api.endDrag(); api.clearHoldTimer();
  assert.ok(api.formatTurnTime(new Date().toISOString()));
  api.state.turns = [{ turn_id: "render-audio", transcript: "hi", reply: "yes", audio: { assistant: true } }];
  api.renderTurns();
  api.chooseVoice("Puck");
  api.player.ctx = new dom.window.AudioContext(); api.player.ctx.state = "suspended";
  api.startPcmPlayback(new Int16Array([1]).buffer, "suspended");
  dom.window.close();
});

test("mutation failure and payload-shape matrix keeps controls recoverable", async () => {
  let mode = "";
  const { dom, api, pet } = await setup({
    fetch: async (url) => {
      if (!mode) return null;
      if (url.startsWith("/api/voice/turns")) {
        if (mode === "turn-error") return jsonResponse({ error: "history no" }, 500);
        if (mode === "turn-shapes") return jsonResponse({ turns: [{ turn_id: "skip", transcript: "Voice captured.", reply: "" }, { turn_id: "keep", transcript: "hello", reply: "" }] });
      }
      if (mode.endsWith("-error")) return jsonResponse({}, 500);
      if (url === "/api/pets/preview") return jsonResponse({ sample_text: "sample" });
      if (url === "/api/pets/bookmarks") return jsonResponse({ url: "/pets/?agent=shape" });
      if (url === "/api/pets/apply") return jsonResponse({ profile: {} });
      if (url === "/api/pets/agents") return jsonResponse({ companion: pet });
      if (url === "/api/pets/install") return jsonResponse({ companion: pet, profile: {} });
      if (url.includes("/publish")) return jsonResponse({ ok: true });
      if (url === "/api/pets/generate") {
        if (mode === "gen-404") return jsonResponse({}, 404);
        if (mode === "gen-empty") return jsonResponse({});
      }
      return null;
    },
  });
  api.state.selected = pet;
  mode = "turn-error"; await api.loadTurns();
  mode = "turn-shapes"; await api.loadTurns();
  assert.equal(api.state.turns.length, 1);

  for (const action of [
    ["preview-error", api.elements.previewBtn], ["bookmark-error", api.elements.shareBtn],
    ["apply-error", api.elements.applyBtn], ["generate-error", api.elements.generateBtn],
  ]) { mode = action[0]; action[1].click(); await new Promise((resolve) => setTimeout(resolve, 0)); }
  mode = "preview-ok"; api.elements.previewBtn.click();
  mode = "bookmark-ok"; api.elements.shareBtn.click();
  mode = "apply-ok"; api.elements.applyBtn.click();
  await new Promise((resolve) => setTimeout(resolve, 5));

  api.elements.petName.value = "Created";
  mode = "create-ok";
  api.elements.form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 5));
  mode = "create-error";
  api.elements.form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 5));

  mode = "install-ok"; await api.installShared(pet, null);
  mode = "publish-ok"; api.state.selected = { ...pet, source: "custom" }; await api.publishSelected();
  mode = "gen-404"; await api.runDescribeGeneration("prompt", pet);
  mode = "gen-empty"; await api.runDescribeGeneration("prompt", pet);
  dom.window.close();
});
