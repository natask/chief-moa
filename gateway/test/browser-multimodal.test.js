"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { attachOpenAiBrowserImage, attachVertexBrowserImage } = require("../lib/browser-multimodal");

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
