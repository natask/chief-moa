"use strict";

const BROWSER_JPEG_MAX_WIDTH = 3840;
const BROWSER_JPEG_MAX_HEIGHT = 3840;
const BROWSER_JPEG_MAX_PIXELS = 3840 * 2160;

class ModelProviderHttpError extends Error {
  constructor(provider, status, responseBody = "") {
    const safeProvider = String(provider || "model provider");
    super(`${safeProvider} HTTP ${status}: ${String(responseBody || "").slice(0, 400)}`);
    this.name = "ModelProviderHttpError";
    this.provider = safeProvider;
    this.status = Number(status) || 0;
    this.responseBody = String(responseBody || "").slice(0, 4000);
  }
}

class BrowserTurnBodyError extends Error {
  constructor(code, statusCode = 400) {
    super(code);
    this.name = "BrowserTurnBodyError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function inspectBoundedBrowserJpeg(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  let dimensions = null;
  let sawScan = false;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return null;
    const marker = bytes[offset++];
    if (marker === 0xd9) return sawScan && dimensions && offset === bytes.length ? dimensions : null;
    if (marker === 0xda) {
      if (!dimensions || sawScan || offset + 1 >= bytes.length) return null;
      const length = bytes.readUInt16BE(offset);
      if (length < 6 || offset + length > bytes.length) return null;
      offset += length;
      const scanStart = offset;
      sawScan = true;
      while (offset < bytes.length) {
        if (bytes[offset++] !== 0xff) continue;
        if (offset >= bytes.length) return null;
        const next = bytes[offset++];
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) continue;
        if (next === 0xd9) return offset === bytes.length && offset - 2 > scanStart ? dimensions : null;
        return null;
      }
      return null;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= bytes.length) return null;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return null;
    if (isStartOfFrame(marker)) {
      if (length < 8 || dimensions) return null;
      const height = bytes.readUInt16BE(offset + 3);
      const width = bytes.readUInt16BE(offset + 5);
      if (width < 1 || height < 1 || width > BROWSER_JPEG_MAX_WIDTH || height > BROWSER_JPEG_MAX_HEIGHT || width * height > BROWSER_JPEG_MAX_PIXELS) {
        return null;
      }
      dimensions = { width, height };
    }
    offset += length;
  }
  return null;
}

function isStartOfFrame(marker) {
  return [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker);
}

function explicitlyUnsupportedImageError(error) {
  if (!(error instanceof ModelProviderHttpError)) return false;
  if (error.status === 415) return true;
  if (error.status !== 400 && error.status !== 422) return false;
  const body = error.responseBody.toLowerCase();
  return /(?:image|vision|multimodal).{0,80}(?:not supported|unsupported|unavailable|not accepted)/s.test(body)
    || /(?:not supported|unsupported).{0,80}(?:image|vision|multimodal)/s.test(body)
    || /(?:content|message).{0,80}(?:must be|expected).{0,40}(?:string|text).{0,80}(?:array|object)/s.test(body);
}

function modelProviderErrorSummary(error) {
  if (error instanceof ModelProviderHttpError) return `${error.provider} HTTP ${error.status}`;
  return String(error?.message || error || "model provider error").slice(0, 200);
}

function attachOpenAiBrowserImage(messages, image) {
  const lastUser = [...messages].reverse().find((message) => message?.role === "user");
  if (!lastUser || !image?.mime_type || !image?.data_base64) return false;
  const text = String(lastUser.content || "");
  lastUser.content = [
    { type: "text", text },
    {
      type: "image_url",
      image_url: {
        url: `data:${image.mime_type};base64,${image.data_base64}`,
        detail: "low",
      },
    },
  ];
  return true;
}

function attachVertexBrowserImage(contents, image) {
  if (!image?.mime_type || !image?.data_base64) return false;
  const imagePart = {
    inlineData: {
      mimeType: image.mime_type,
      data: image.data_base64,
    },
  };
  const lastUser = [...contents].reverse().find((entry) => entry?.role === "user");
  if (lastUser) {
    lastUser.parts.push(imagePart);
  } else {
    contents.push({ role: "user", parts: [{ text: "" }, imagePart] });
  }
  return true;
}

module.exports = {
  ModelProviderHttpError,
  BrowserTurnBodyError,
  attachOpenAiBrowserImage,
  attachVertexBrowserImage,
  explicitlyUnsupportedImageError,
  inspectBoundedBrowserJpeg,
  modelProviderErrorSummary,
};
