"use strict";

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

module.exports = { attachOpenAiBrowserImage, attachVertexBrowserImage };
