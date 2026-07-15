"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const jpeg = require("jpeg-js");
const {
  BrowserTurnBodyError,
  ModelProviderHttpError,
  attachOpenAiBrowserImage,
  attachVertexBrowserImage,
  explicitlyUnsupportedImageError,
  inspectBoundedBrowserJpeg,
  modelProviderErrorSummary,
} = require("../lib/browser-multimodal");

const image = { mime_type: "image/jpeg", data_base64: "/9j/fixture/9k=" };

test("OpenAI-compatible browser input preserves text and exact JPEG evidence", () => {
  const messages = [
    { role: "system", content: "system" },
    { role: "user", content: "bounded page text" },
  ];
  assert.equal(attachOpenAiBrowserImage(messages, image), true);
  assert.deepEqual(messages[1].content, [
    { type: "text", text: "bounded page text" },
    { type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/fixture/9k=", detail: "low" } },
  ]);
});

test("Vertex browser input preserves text and exact inline JPEG evidence", () => {
  const contents = [{ role: "user", parts: [{ text: "bounded page text" }] }];
  assert.equal(attachVertexBrowserImage(contents, image), true);
  assert.deepEqual(contents[0].parts, [
    { text: "bounded page text" },
    { inlineData: { mimeType: "image/jpeg", data: "/9j/fixture/9k=" } },
  ]);
});

test("browser provider builders fail closed on missing image and handle no prior user", () => {
  assert.equal(attachOpenAiBrowserImage([], image), false);
  assert.equal(attachOpenAiBrowserImage([{ role: "user", content: "text" }], null), false);
  const contents = [];
  assert.equal(attachVertexBrowserImage(contents, image), true);
  assert.deepEqual(contents[0], {
    role: "user",
    parts: [{ text: "" }, { inlineData: { mimeType: "image/jpeg", data: "/9j/fixture/9k=" } }],
  });
  assert.equal(attachVertexBrowserImage(contents, {}), false);
});

test("strict JPEG header inspection rejects dimension bombs without decoding pixels", () => {
  const encoded = jpeg.encode({ data: Buffer.from([1, 2, 3, 255]), width: 1, height: 1 }, 70).data;
  assert.deepEqual(inspectBoundedBrowserJpeg(encoded), { width: 1, height: 1 });
  const bomb = Buffer.from(encoded);
  const sof = findStartOfFrame(bomb);
  bomb.writeUInt16BE(4000, sof + 4);
  bomb.writeUInt16BE(4000, sof + 6);
  assert.equal(inspectBoundedBrowserJpeg(bomb), null);
  assert.equal(inspectBoundedBrowserJpeg(Buffer.from("not jpeg")), null);
  assert.equal(inspectBoundedBrowserJpeg(new Uint8Array(encoded)), null);
});

test("repeated JPEG inspection has bounded resident-memory behavior", () => {
  const encoded = jpeg.encode({ data: Buffer.from([5, 6, 7, 255]), width: 1, height: 1 }, 70).data;
  const before = process.memoryUsage().rss;
  for (let i = 0; i < 5000; i += 1) {
    assert.deepEqual(inspectBoundedBrowserJpeg(encoded), { width: 1, height: 1 });
  }
  const growth = process.memoryUsage().rss - before;
  assert.ok(growth < 32 * 1024 * 1024, `JPEG header inspection RSS grew by ${growth} bytes`);
});

test("image fallback classification accepts only explicit non-acceptance", () => {
  assert.equal(explicitlyUnsupportedImageError(new ModelProviderHttpError("fixture", 415, "anything")), true);
  assert.equal(explicitlyUnsupportedImageError(new ModelProviderHttpError("fixture", 400, "image input is not supported")), true);
  assert.equal(explicitlyUnsupportedImageError(new ModelProviderHttpError("fixture", 422, "content must be a string, received array")), true);
  assert.equal(explicitlyUnsupportedImageError(new ModelProviderHttpError("fixture", 500, "image input is not supported")), false);
  assert.equal(explicitlyUnsupportedImageError(new ModelProviderHttpError("fixture", 400, "invalid request")), false);
  assert.equal(explicitlyUnsupportedImageError(new Error("timeout")), false);
  assert.equal(modelProviderErrorSummary(new ModelProviderHttpError("fixture", 503, "secret body")), "fixture HTTP 503");
  assert.equal(modelProviderErrorSummary(new Error("timeout after 20ms")), "timeout after 20ms");
  assert.match(new BrowserTurnBodyError("body_too_large", 413).message, /body_too_large/);
});

function findStartOfFrame(bytes) {
  for (let i = 2; i < bytes.length - 9; i += 1) {
    if (bytes[i] === 0xff && [0xc0, 0xc1, 0xc2].includes(bytes[i + 1])) return i + 1;
  }
  throw new Error("JPEG fixture has no SOF marker");
}
