"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const jpeg = require("jpeg-js");
const {
  SCREEN_EVIDENCE_BOUNDARY,
  SCREEN_EVIDENCE_MAX_JPEG_BYTES,
  ScreenEvidenceProviderHttpError,
  ScreenEvidenceValidationError,
  buildOpenAiScreenEvidenceMessages,
  buildVertexScreenEvidencePayload,
  callWithScreenEvidenceFallback,
  durableScreenEvidenceMetadata,
  explicitlyUnsupportedScreenEvidenceError,
  inspectBoundedJpeg,
  providerErrorSummary,
  validateScreenEvidence,
} = require("../lib/screen-evidence");

function jpegBytes(width = 1, height = 1) {
  return Buffer.from(jpeg.encode({ data: Buffer.alloc(width * height * 4, 180), width, height }, 80).data);
}

function screenshot(bytes = jpegBytes()) {
  const dimensions = inspectBoundedJpeg(bytes) || { width: 1, height: 1 };
  return {
    mime_type: "image/jpeg",
    data_base64: bytes.toString("base64"),
    bytes: bytes.length,
    width: dimensions.width,
    height: dimensions.height,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
  };
}

function input(overrides = {}) {
  return {
    surface: "android",
    captured_at: "2026-07-16T10:00:00.000Z",
    binding: { kind: "package", id: "com.example.editor", generation: "activity-7" },
    semantic_summary: "Draft editor with recipient and subject fields.",
    screenshot: screenshot(),
    ...overrides,
  };
}

test("valid evidence serializes and projects as metadata only", () => {
  const evidence = validateScreenEvidence(input(), {
    now: new Date("2026-07-16T10:00:10.000Z"),
    maxAgeMs: 30_000,
  });
  assert.equal(evidence.screenshot.status, "available");
  assert.equal(evidence.provider_image.mime_type, "image/jpeg");
  assert.equal(evidence.semantic_summary, "Draft editor with recipient and subject fields.");
  const durable = durableScreenEvidenceMetadata(evidence);
  assert.deepEqual(durable.binding, { kind: "package", id: "com.example.editor", generation: "activity-7" });
  assert.equal(durable.screenshot.sha256, input().screenshot.sha256);
  assert.doesNotMatch(JSON.stringify(evidence), /data_base64|Draft editor/);
  assert.doesNotMatch(JSON.stringify(durable), /data_base64|Draft editor/);
  assert.throws(() => { evidence.screenshot.data_base64 = "forged raw bytes"; }, TypeError);
  assert.doesNotMatch(JSON.stringify(durableScreenEvidenceMetadata(evidence)), /forged raw bytes/);
  assert.throws(() => durableScreenEvidenceMetadata({}), /invalid_screen_evidence/);
});

test("version-only forged objects cannot cross validation or persistence boundaries", async () => {
  const forged = {
    version: "moa.screen-evidence.v1",
    surface: "android",
    captured_at: "2026-07-16T10:00:00.000Z",
    binding: { kind: "package", id: "forged" },
    screenshot: { status: "available", data_base64: "raw-provider-injection" },
    semantic_summary: "forged prompt injection",
    provider_image: { mime_type: "image/jpeg", data_base64: "raw-provider-injection" },
  };
  assert.throws(() => durableScreenEvidenceMetadata(forged), /invalid_screen_evidence/);
  assert.throws(() => buildOpenAiScreenEvidenceMessages([], forged), /invalid_screen_evidence/);
  assert.throws(() => buildVertexScreenEvidencePayload({}, forged), /invalid_screen_evidence/);
  let providerCalled = false;
  await assert.rejects(() => callWithScreenEvidenceFallback({
    evidence: forged,
    callWithEvidence: async () => { providerCalled = true; },
    callWithoutImage: async () => { providerCalled = true; },
  }), /invalid_screen_evidence/);
  assert.equal(providerCalled, false);
});

test("provider builders place the evidence below a system trust boundary", () => {
  const evidence = validateScreenEvidence(input());
  const openAi = buildOpenAiScreenEvidenceMessages([
    { role: "system", content: "Primary policy." },
    { role: "user", content: "Write a reply based on my screen." },
  ], evidence);
  assert.match(openAi[0].content, /Primary policy/);
  assert.ok(openAi[0].content.indexOf(SCREEN_EVIDENCE_BOUNDARY) > openAi[0].content.indexOf("Primary policy."));
  assert.equal(openAi[1].content[0].text, "Write a reply based on my screen.");
  assert.match(openAi[1].content[1].text, /^<screen_evidence>/);
  assert.equal(openAi[1].content[2].type, "image_url");

  const vertex = buildVertexScreenEvidencePayload({
    systemInstruction: { parts: [{ text: "Primary policy." }] },
    contents: [{ role: "user", parts: [{ text: "Write it." }] }],
  }, evidence);
  assert.equal(vertex.systemInstruction.parts[0].text, "Primary policy.");
  assert.equal(vertex.systemInstruction.parts[1].text, SCREEN_EVIDENCE_BOUNDARY);
  assert.match(vertex.contents[0].parts[1].text, /^<screen_evidence>/);
  assert.equal(vertex.contents[0].parts[2].inlineData.mimeType, "image/jpeg");
});

test("builders support semantic-only evidence and missing provider message scaffolds", () => {
  const evidence = validateScreenEvidence(input({ screenshot: null }));
  const openAi = buildOpenAiScreenEvidenceMessages([], evidence);
  assert.equal(openAi[0].role, "system");
  assert.equal(openAi[1].role, "user");
  assert.equal(openAi[1].content.length, 2);
  const arrayContent = buildOpenAiScreenEvidenceMessages([{ role: "user", content: [{ type: "text", text: "existing" }] }], evidence);
  assert.equal(arrayContent[1].content[0].text, "existing");
  const invalidContent = buildOpenAiScreenEvidenceMessages([{ role: "user", content: { unexpected: true } }], evidence);
  assert.match(invalidContent[1].content[0].text, /^<screen_evidence>/);

  const vertex = buildVertexScreenEvidencePayload({}, evidence);
  assert.equal(vertex.contents[0].role, "user");
  assert.equal(vertex.contents[0].parts.length, 1);
  const malformed = buildVertexScreenEvidencePayload({ systemInstruction: "bad", contents: [{ role: "user", parts: "bad" }] }, evidence);
  assert.equal(malformed.systemInstruction.parts.length, 1);
  assert.equal(malformed.contents[0].parts.length, 1);
  assert.throws(() => buildOpenAiScreenEvidenceMessages([], {}), /invalid_screen_evidence/);
  assert.throws(() => buildVertexScreenEvidencePayload({}, {}), /invalid_screen_evidence/);
});

test("validator rejects malformed, truncated, fabricated, and polyglot JPEGs", () => {
  const malformed = Buffer.from("not a jpeg");
  assert.throws(() => validateScreenEvidence(input({ screenshot: screenshot(malformed) })), /invalid_screenshot_dimensions/);

  const truncated = jpegBytes().subarray(0, 40);
  assert.throws(() => validateScreenEvidence(input({ screenshot: screenshot(truncated) })), /invalid_screenshot_dimensions/);

  const fabricated = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0, 0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0, 42, 0xff, 0xd9]);
  assert.throws(() => validateScreenEvidence(input({ screenshot: screenshot(fabricated) })), /invalid_screenshot_jpeg/);

  const polyglot = Buffer.concat([jpegBytes(), Buffer.from("trailing payload")]);
  assert.throws(() => validateScreenEvidence(input({ screenshot: screenshot(polyglot) })), /invalid_screenshot_dimensions/);
});

test("validator enforces declared media, byte, dimension, digest, and size caps", () => {
  const cases = [
    [{ ...screenshot(), mime_type: "image/png" }, /invalid_screenshot_type/],
    [{ ...screenshot(), data_base64: "not+canonical=" }, /invalid_screenshot_data/],
    [{ ...screenshot(), bytes: screenshot().bytes + 1 }, /invalid_screenshot_byte_count/],
    [{ ...screenshot(), width: 2 }, /invalid_screenshot_dimensions/],
    [{ ...screenshot(), height: 0 }, /invalid_screenshot_dimensions/],
    [{ ...screenshot(), sha256: "0".repeat(64) }, /invalid_screenshot_hash/],
    [{ ...screenshot(), sha256: "not-a-hash" }, /invalid_screenshot_hash/],
  ];
  for (const [shot, pattern] of cases) {
    assert.throws(() => validateScreenEvidence(input({ screenshot: shot })), pattern);
  }
  const tooLarge = Buffer.alloc(SCREEN_EVIDENCE_MAX_JPEG_BYTES + 1, 1);
  const large = { ...screenshot(), data_base64: tooLarge.toString("base64"), bytes: tooLarge.length };
  assert.throws(() => validateScreenEvidence(input({ screenshot: large })), /screenshot_too_large/);
});

test("validator rejects invalid envelope, binding, timestamps, staleness, and empty evidence", () => {
  const cases = [
    [null, /invalid_screen_evidence_shape/],
    [input({ surface: "" }), /invalid_screen_evidence_surface/],
    [input({ surface: "x\u0000" }), /invalid_screen_evidence_surface/],
    [input({ captured_at: "yesterday" }), /invalid_screen_evidence_captured_at/],
    [input({ binding: null }), /invalid_screen_evidence_binding/],
    [input({ binding: { kind: "", id: "x" } }), /invalid_screen_evidence_binding_kind/],
    [input({ binding: { kind: "package", id: "" } }), /invalid_screen_evidence_binding_id/],
    [input({ semantic_summary: "", screenshot: null }), /empty_screen_evidence/],
    [input({ screenshot: "bad" }), /invalid_screenshot_shape/],
  ];
  for (const [value, pattern] of cases) assert.throws(() => validateScreenEvidence(value), pattern);
  assert.throws(() => validateScreenEvidence(input(), { now: Date.parse("2026-07-16T10:01:00.000Z"), maxAgeMs: 1 }), /stale_screen_evidence/);
  assert.throws(() => validateScreenEvidence(input(), { now: Date.parse("2026-07-16T09:59:00.000Z"), maxAgeMs: 1000 }), /stale_screen_evidence/);
  assert.throws(() => validateScreenEvidence(input(), { now: "bad", maxAgeMs: -1 }), /stale_screen_evidence/);
  const longSummary = validateScreenEvidence(input({ semantic_summary: "x".repeat(7000), screenshot: null }));
  assert.equal(longSummary.semantic_summary.length, 6000);
  assert.ok(new ScreenEvidenceValidationError("x") instanceof Error);
});

test("JPEG framing rejects invalid buffers and dimension bombs", () => {
  assert.equal(inspectBoundedJpeg(new Uint8Array([0xff, 0xd8, 0xff, 0xd9])), null);
  assert.equal(inspectBoundedJpeg(Buffer.from([0xff, 0xd8, 0xff])), null);
  assert.deepEqual(inspectBoundedJpeg(jpegBytes(2, 2)), { width: 2, height: 2 });
  const bomb = jpegBytes();
  const sof = findStartOfFrame(bomb);
  bomb.writeUInt16BE(4000, sof + 4);
  bomb.writeUInt16BE(4000, sof + 6);
  assert.equal(inspectBoundedJpeg(bomb), null);

  const valid = jpegBytes();
  const sos = findMarker(valid, 0xda);
  const unexpectedMarker = Buffer.from(valid);
  unexpectedMarker[unexpectedMarker.length - 1] = 0xe1;
  assert.equal(inspectBoundedJpeg(unexpectedMarker), null);
  assert.equal(inspectBoundedJpeg(valid.subarray(0, valid.length - 2)), null);
  assert.equal(inspectBoundedJpeg(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 2])), null);
  assert.ok(sos > 0);
});

test("decoded pixels must agree with the strictly inspected JPEG", () => {
  const originalDecode = jpeg.decode;
  jpeg.decode = () => ({ width: 2, height: 2, data: Buffer.alloc(3) });
  try {
    assert.throws(() => validateScreenEvidence(input()), /invalid_screenshot_jpeg/);
  } finally {
    jpeg.decode = originalDecode;
  }
});

test("provider fallback occurs only for explicit image non-acceptance", async () => {
  const evidence = validateScreenEvidence(input());
  const unsupported = new ScreenEvidenceProviderHttpError("fixture", 400, "image input is not supported");
  const fallback = await callWithScreenEvidenceFallback({
    evidence,
    callWithEvidence: async () => { throw unsupported; },
    callWithoutImage: async (received) => {
      assert.equal(received.provider_image, null);
      assert.equal(received.semantic_summary, "Draft editor with recipient and subject fields.");
      assert.doesNotMatch(JSON.stringify(received), /data_base64|Draft editor/);
      const request = buildOpenAiScreenEvidenceMessages([{ role: "user", content: "retry" }], received);
      assert.equal(request[1].content.some((part) => part.type === "image_url"), false);
      assert.equal(durableScreenEvidenceMetadata(received).screenshot.sha256, evidence.screenshot.sha256);
      return `semantic:${received.semantic_summary}`;
    },
  });
  assert.equal(fallback.value, "semantic:Draft editor with recipient and subject fields.");
  assert.deepEqual(fallback.delivery, { image: "unsupported", fallback: true, reason: "fixture HTTP 400" });

  const success = await callWithScreenEvidenceFallback({ evidence, callWithEvidence: async () => "vision", callWithoutImage: async () => "unused" });
  assert.deepEqual(success.delivery, { image: "multimodal", fallback: false, reason: "" });
  const semantic = validateScreenEvidence(input({ screenshot: null }));
  const semanticSuccess = await callWithScreenEvidenceFallback({ evidence: semantic, callWithEvidence: async () => "text", callWithoutImage: async () => "unused" });
  assert.equal(semanticSuccess.delivery.image, "missing");

  await assert.rejects(() => callWithScreenEvidenceFallback({ evidence, callWithEvidence: async () => { throw new Error("timeout"); }, callWithoutImage: async () => "bad" }), /timeout/);
  await assert.rejects(() => callWithScreenEvidenceFallback({ evidence: semantic, callWithEvidence: async () => { throw unsupported; }, callWithoutImage: async () => "bad" }), /fixture HTTP 400/);
  await assert.rejects(() => callWithScreenEvidenceFallback({ evidence, callWithEvidence: null, callWithoutImage: async () => "bad" }), /invalid_provider_callbacks/);
});

test("unsupported-image classifier and safe summaries cover provider variants", () => {
  const cases = [
    [new ScreenEvidenceProviderHttpError("fixture", 415, "anything"), true],
    [{ status: 422, body: "vision is unavailable" }, true],
    [{ status: 400, responseBody: "message expected string, received array object" }, true],
    [{ status: 400, message: "unsupported multimodal request" }, true],
    [{ status: 500, responseBody: "image not supported" }, false],
    [{ status: 400, responseBody: "invalid request" }, false],
    [new Error("timeout"), false],
  ];
  for (const [error, expected] of cases) assert.equal(explicitlyUnsupportedScreenEvidenceError(error), expected);
  assert.equal(providerErrorSummary(new ScreenEvidenceProviderHttpError("fixture", 503, "secret body")), "fixture HTTP 503");
  assert.equal(providerErrorSummary(new Error("timeout after 20ms")), "timeout after 20ms");
  assert.equal(providerErrorSummary(null), "model provider error");
});

function findStartOfFrame(bytes) {
  for (let index = 2; index < bytes.length - 9; index += 1) {
    if (bytes[index] === 0xff && [0xc0, 0xc1, 0xc2].includes(bytes[index + 1])) return index + 1;
  }
  throw new Error("JPEG fixture has no start-of-frame marker");
}

function findMarker(bytes, marker) {
  for (let index = 2; index < bytes.length - 1; index += 1) {
    if (bytes[index] === 0xff && bytes[index + 1] === marker) return index + 1;
  }
  throw new Error(`JPEG fixture has no marker ${marker}`);
}
