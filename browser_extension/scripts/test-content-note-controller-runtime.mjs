import assert from "node:assert/strict";

await import(`../extension/content-note-controller-runtime.js?test=${Date.now()}`);
const { createContentNoteControllerRuntime } = globalThis.AgeeContentNoteControllerRuntime;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createHarness(overrides = {}) {
  const calls = [];
  const surfaces = [];
  const states = [];
  const cues = [];
  const updates = [];
  const reactions = [];
  let cueSequence = 0;
  let currentNow = overrides.now ?? 1000;
  let voiceActive = overrides.voiceActive === true;
  let invalidated = overrides.invalidated === true;
  const sendMessage = async (message) => {
    calls.push(message);
    if (overrides.sendMessage) return overrides.sendMessage(message, calls);
    if (message.cmd.endsWith("Start")) return { ok: true };
    return { stored: true };
  };
  const runtime = createContentNoteControllerRuntime({
    sendMessage,
    isExtensionContextInvalidated: () => invalidated,
    openSurface: () => surfaces.push(true),
    isVoiceActive: () => voiceActive,
    setCaptureState: (kind, active) => states.push({ kind, active }),
    newCueId: () => `cue-${++cueSequence}`,
    materializeCue: (...args) => cues.push(args),
    updateCue: (...args) => updates.push(args),
    reactLauncher: (kind) => reactions.push(kind),
    now: () => currentNow,
  });
  return {
    calls,
    cues,
    reactions,
    runtime,
    states,
    surfaces,
    updates,
    setInvalidated(value) { invalidated = value; },
    setNow(value) { currentNow = value; },
    setVoiceActive(value) { voiceActive = value; },
  };
}

{
  const h = createHarness({ voiceActive: true });
  assert.ok(Object.isFrozen(h.runtime));
  assert.equal(h.runtime.isRecordActive(), false);
  assert.equal(h.runtime.isVideoNoteActive(), false);
  await h.runtime.toggleRecordMode();
  assert.equal(h.surfaces.length, 1);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.cues, [["cue-1", "Audio note", ""]]);
  assert.deepEqual(h.updates, [["cue-1", "Voice is active. Stop voice before recording a note.", "error"]]);
}

{
  const start = deferred();
  const h = createHarness({ sendMessage: () => start.promise });
  const pending = h.runtime.toggleRecordMode();
  assert.equal(h.surfaces.length, 1);
  assert.equal(h.calls.length, 1);
  assert.equal(h.runtime.toggleRecordMode(), undefined);
  assert.equal(h.surfaces.length, 1);
  start.resolve({ ok: true });
  await pending;
  assert.equal(h.runtime.isRecordActive(), true);
  assert.deepEqual(h.states, [{ kind: "audio", active: true }]);
}

{
  const responses = [{ ok: true }, { stored: true, note: { duration_ms: 1499 } }];
  const h = createHarness({ sendMessage: () => responses.shift() });
  await h.runtime.toggleRecordMode();
  await h.runtime.toggleRecordMode();
  assert.equal(h.runtime.isRecordActive(), false);
  assert.deepEqual(h.calls.map((call) => call.cmd), ["recordSessionStart", "recordSessionStop"]);
  assert.deepEqual(h.states, [
    { kind: "audio", active: true },
    { kind: "audio", active: false },
  ]);
  assert.deepEqual(h.cues, [["cue-1", "Audio note", "storing..."]]);
  assert.deepEqual(h.updates, [["cue-1", "note stored (1s)", "done"]]);
  assert.deepEqual(h.reactions, ["done"]);
}

{
  const responses = [{ ok: true }, { stored: true, durationMs: 2500 }];
  const h = createHarness({ sendMessage: () => responses.shift(), now: 1000 });
  await h.runtime.startRecordMode();
  await h.runtime.stopRecordMode();
  assert.deepEqual(h.updates.at(-1), ["cue-1", "note stored (3s)", "done"]);
}

{
  const responses = [{ ok: true }, { stored: true }];
  const h = createHarness({ sendMessage: () => responses.shift(), now: 1000 });
  await h.runtime.startRecordMode();
  h.setNow(4600);
  await h.runtime.stopRecordMode();
  assert.deepEqual(h.updates.at(-1), ["cue-1", "note stored (4s)", "done"]);
}

for (const [response, expected] of [
  [{ ok: false, error: "mic denied" }, "mic denied"],
  [{}, "Could not start recording."],
]) {
  const h = createHarness({ sendMessage: () => response });
  await h.runtime.startRecordMode();
  assert.equal(h.runtime.isRecordActive(), false);
  assert.deepEqual(h.updates.at(-1), ["cue-1", expected, "error"]);
}

for (const rejection of [new Error("record rejected"), "record string failure"]) {
  const h = createHarness({ sendMessage: () => Promise.reject(rejection) });
  await h.runtime.startRecordMode();
  assert.match(h.updates.at(-1)[1], /record (?:rejected|string failure)/);
}

{
  const h = createHarness({ invalidated: true, sendMessage: () => null });
  await h.runtime.startRecordMode();
  assert.deepEqual(h.cues, []);
}

for (const [response, expected] of [
  [{ stored: false, error: "upload denied" }, "upload denied"],
  [{}, "Audio note upload failed."],
]) {
  const responses = [{ ok: true }, response];
  const h = createHarness({ sendMessage: () => responses.shift() });
  await h.runtime.startRecordMode();
  await h.runtime.stopRecordMode();
  assert.deepEqual(h.updates.at(-1), ["cue-1", expected, "error"]);
  assert.deepEqual(h.reactions, ["error"]);
}

{
  const responses = [{ ok: true }, Promise.reject(new Error("upload exploded"))];
  const h = createHarness({ sendMessage: () => responses.shift() });
  await h.runtime.startRecordMode();
  await h.runtime.stopRecordMode();
  assert.deepEqual(h.updates.at(-1), ["cue-1", "upload exploded", "error"]);
}

{
  const responses = [{ ok: true }, null];
  const h = createHarness({ invalidated: true, sendMessage: () => responses.shift() });
  await h.runtime.startRecordMode();
  await h.runtime.stopRecordMode();
  assert.equal(h.updates.length, 0);
}

{
  const h = createHarness({ voiceActive: true });
  await h.runtime.toggleVideoNoteMode();
  assert.deepEqual(h.updates.at(-1), ["cue-1", "Voice is active. Stop voice before recording a video note.", "error"]);
  assert.deepEqual(h.calls, []);
}

{
  const responses = [{ ok: true }];
  const h = createHarness({ sendMessage: () => responses.shift() });
  await h.runtime.startRecordMode();
  await h.runtime.toggleVideoNoteMode();
  assert.deepEqual(h.updates.at(-1), ["cue-1", "An audio note is recording. Finish it before starting a video note.", "error"]);
}

{
  const start = deferred();
  const h = createHarness({ sendMessage: () => start.promise });
  const pending = h.runtime.toggleVideoNoteMode();
  assert.equal(h.runtime.toggleVideoNoteMode(), undefined);
  assert.equal(h.surfaces.length, 1);
  start.resolve({ ok: true });
  await pending;
  assert.equal(h.runtime.isVideoNoteActive(), true);
  assert.deepEqual(h.states, [{ kind: "video", active: true }]);
}

{
  const recordStart = deferred();
  const h = createHarness({ sendMessage: () => recordStart.promise });
  const pending = h.runtime.startRecordMode();
  assert.equal(h.runtime.toggleVideoNoteMode(), undefined);
  assert.equal(h.surfaces.length, 0);
  recordStart.resolve({ ok: true });
  await pending;
}

for (const [response, expected] of [
  [{ ok: false, error: "picker denied" }, "picker denied"],
  [{}, "Could not start the video note."],
]) {
  const h = createHarness({ sendMessage: () => response });
  await h.runtime.startVideoNoteMode();
  assert.equal(h.runtime.isVideoNoteActive(), false);
  assert.deepEqual(h.updates.at(-1), ["cue-1", expected, "error"]);
}

for (const rejection of [new Error("video rejected"), "video string failure"]) {
  const h = createHarness({ sendMessage: () => Promise.reject(rejection) });
  await h.runtime.startVideoNoteMode();
  assert.match(h.updates.at(-1)[1], /video (?:rejected|string failure)/);
}

{
  const h = createHarness({ invalidated: true, sendMessage: () => null });
  await h.runtime.startVideoNoteMode();
  assert.deepEqual(h.cues, []);
}

{
  const responses = [{ ok: true }, { stored: true }];
  const h = createHarness({ sendMessage: () => responses.shift() });
  await h.runtime.toggleVideoNoteMode();
  await h.runtime.toggleVideoNoteMode();
  assert.equal(h.runtime.isVideoNoteActive(), false);
  assert.deepEqual(h.calls, [
    { cmd: "videoSessionStart" },
    { cmd: "videoSessionStop", cueId: "cue-1" },
  ]);
  assert.deepEqual(h.updates, [["cue-1", "video stored — sending to A.G. ...", "running"]]);
  assert.deepEqual(h.reactions, []);
}

for (const [response, expected] of [
  [{ stored: false, error: "video upload denied" }, "video upload denied"],
  [{}, "Video note upload failed."],
]) {
  const responses = [{ ok: true }, response];
  const h = createHarness({ sendMessage: () => responses.shift() });
  await h.runtime.startVideoNoteMode();
  await h.runtime.stopVideoNoteMode();
  assert.deepEqual(h.updates.at(-1), ["cue-1", expected, "error"]);
  assert.deepEqual(h.reactions, ["error"]);
}

{
  const responses = [{ ok: true }, Promise.reject(new Error("video upload exploded"))];
  const h = createHarness({ sendMessage: () => responses.shift() });
  await h.runtime.startVideoNoteMode();
  await h.runtime.stopVideoNoteMode();
  assert.deepEqual(h.updates.at(-1), ["cue-1", "video upload exploded", "error"]);
}

{
  const responses = [{ ok: true }, null];
  const h = createHarness({ invalidated: true, sendMessage: () => responses.shift() });
  await h.runtime.startVideoNoteMode();
  await h.runtime.stopVideoNoteMode();
  assert.equal(h.updates.length, 0);
}

console.log("content note controller runtime tests passed");
