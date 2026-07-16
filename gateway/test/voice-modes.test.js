const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { COACH_OVERLAY, createVoiceModeStore } = require("../lib/voice-modes");

function fixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "moa-voice-modes-"));
  const store = createVoiceModeStore({ dataDir, now: () => "2026-07-15T12:00:00.000Z" });
  return { dataDir, store };
}

test("Ask is the deterministic default response policy", () => {
  const { store } = fixture();
  const admission = store.admit("android-phone");
  assert.equal(admission.mode, "ask");
  assert.equal(admission.version, "voice_mode_default");
  assert.deepEqual(admission.routing, {
    response_policy: "normal",
    provider_work_allowed: true,
    storage_policy: "conversation_turn",
    assistant_reply_allowed: true,
    agent_launch_allowed: true,
  });
});

test("Note persists by device and rejects provider work", () => {
  const { dataDir, store } = fixture();
  const note = store.set("android-phone", "note", { source: "android" });
  assert.equal(note.version, "voice_mode_v0001");

  const reloaded = createVoiceModeStore({ dataDir });
  const admission = reloaded.admit("android-phone");
  assert.equal(admission.mode, "note");
  assert.equal(admission.routing.provider_work_allowed, false);
  assert.equal(admission.routing.response_policy, "none");
  assert.equal(admission.routing.storage_policy, "audio_note");
  assert.equal(admission.routing.capture_endpoint, "/v1/audio-notes");
  assert.equal(reloaded.admit("browser-extension").mode, "ask");
});

test("Coach is a bounded turn overlay and reverting to Ask restores the base persona", () => {
  const { store } = fixture();
  const base = { system_prompt: "You are A.G. Speak like a dry pirate.", assistant_name: "A.G.", temperature: 0.2 };
  const snapshot = structuredClone(base);

  store.set("android-phone", "coach", { source: "test" });
  const coached = store.applyToProfile(base, store.admit("android-phone"));
  assert.deepEqual(base, snapshot);
  assert.notEqual(coached, base);
  assert.match(coached.system_prompt, /^You are A\.G\. Speak like a dry pirate\./);
  assert.ok(coached.system_prompt.includes(COACH_OVERLAY));
  assert.equal(coached.assistant_name, base.assistant_name);

  const ask = store.set("android-phone", "ask", { source: "test" });
  assert.equal(ask.parent_version, "voice_mode_v0001");
  assert.equal(ask.version, "voice_mode_v0002");
  assert.deepEqual(store.applyToProfile(base, store.admit("android-phone")), base);
});

test("mode writes require a valid device and canonical mode", () => {
  const { store } = fixture();
  assert.throws(() => store.set("", "note"), /device_id is required/);
  assert.throws(() => store.set("phone", "dictate"), /ask, note, coach/);
});
