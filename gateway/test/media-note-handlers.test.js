"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createMediaNoteHandlers } = require("../lib/media-note-handlers");

function harness(overrides = {}) {
  const calls = [];
  const handler = (name, asyncResult = false) => (...args) => { calls.push([name, ...args]); return asyncResult ? Promise.resolve() : undefined; };
  const audioNoteHandlers = { create: handler("audio.create", true), list: handler("audio.list"), sendAudio: handler("audio.send"), get: handler("audio.get") };
  const videoNoteHandlers = { create: handler("video.create", true), list: handler("video.list"), sendVideo: handler("video.send"), get: handler("video.get"), remove: handler("video.remove") };
  const handlers = createMediaNoteHandlers({
    authorized: () => true,
    sendJson: (response, status, payload) => Object.assign(response, { status, payload }),
    audioNoteHandlers, videoNoteHandlers, ...overrides,
  });
  return { handlers, calls };
}
const req = (method) => ({ method });
const url = (path) => new URL(`https://test${path}`);

test("router ignores unsupported paths and methods", async () => {
  const state = harness();
  for (const [method, path] of [["GET", "/other"], ["DELETE", "/v1/audio-notes/a"], ["PATCH", "/v1/video-notes/a"], ["PUT", "/v1/audio-notes"]]) {
    assert.equal(await state.handlers.routeMediaNotes(req(method), {}, url(path)), false);
  }
  assert.deepEqual(state.calls, []);
});

test("every recognized media route requires gateway authorization", async () => {
  const state = harness({ authorized: () => false });
  for (const [method, path] of [
    ["POST", "/v1/audio-notes"], ["GET", "/v1/audio-notes"], ["GET", "/v1/audio-notes/a/audio"], ["GET", "/v1/audio-notes/a"],
    ["POST", "/v1/video-notes"], ["GET", "/v1/video-notes"], ["GET", "/v1/video-notes/v/video"], ["GET", "/v1/video-notes/v"], ["DELETE", "/v1/video-notes/v"],
  ]) {
    const response = {}; assert.equal(await state.handlers.routeMediaNotes(req(method), response, url(path)), true);
    assert.deepEqual(response, { status: 401, payload: { error: "missing or invalid gateway token" } });
  }
  assert.deepEqual(state.calls, []);
});

test("audio collection, stream, and metadata paths dispatch in precedence order", async () => {
  const state = harness();
  for (const [method, path, expected] of [
    ["POST", "/v1/audio-notes", "audio.create"], ["GET", "/v1/audio-notes", "audio.list"],
    ["GET", "/v1/audio-notes/a/audio", "audio.send"], ["GET", "/v1/audio-notes/a", "audio.get"],
  ]) {
    const response = {}; const parsed = url(path); assert.equal(await state.handlers.routeMediaNotes(req(method), response, parsed), true);
    assert.equal(state.calls.at(-1)[0], expected);
    if (method === "GET") assert.equal(state.calls.at(-1).includes(parsed), true);
  }
});

test("video collection, stream, metadata, and delete paths dispatch exactly", async () => {
  const state = harness();
  for (const [method, path, expected] of [
    ["POST", "/v1/video-notes", "video.create"], ["GET", "/v1/video-notes", "video.list"],
    ["GET", "/v1/video-notes/v/video", "video.send"], ["GET", "/v1/video-notes/v", "video.get"], ["DELETE", "/v1/video-notes/v", "video.remove"],
  ]) {
    const parsed = url(path); assert.equal(await state.handlers.routeMediaNotes(req(method), {}, parsed), true);
    assert.equal(state.calls.at(-1)[0], expected);
    if (method !== "POST") assert.equal(state.calls.at(-1).includes(parsed), true);
  }
});
