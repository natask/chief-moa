"use strict";

function truncate(value, max) {
  const text = String(value || "");
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function sanitizeLooseId(value) {
  return String(value || "").replace(/[^a-zA-Z0-9_-]/g, "");
}

function screenNodeLabel(node) {
  if (!node || typeof node !== "object") return "";
  const text = String(node.text || node.description || node.view_id || "").trim();
  return text ? truncate(text.replace(/\s+/g, " "), 140) : "";
}

module.exports = { sanitizeLooseId, screenNodeLabel };
