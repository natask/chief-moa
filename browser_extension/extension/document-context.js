// Bounded whole-document reading context for explicit browser page questions.
// Loaded as a classic content script before content.js and exposed as one
// immutable global so the policy can be tested without a DOM implementation.

(() => {
  const DEFAULT_MAX_CHARS = 18_000;
  const DEFAULT_MAX_PARTS = 400;
  const TARGET_PART_CHARS = 160;

  function cleanPart(value) {
    return String(value || "")
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
      .replace(/[\t ]+/g, " ")
      .trim();
  }

  function normalizedParts(values) {
    const parts = [];
    const seen = new Set();
    for (const value of Array.isArray(values) ? values : []) {
      const text = cleanPart(value);
      if (!text || seen.has(text)) continue;
      seen.add(text);
      parts.push(text);
    }
    return parts;
  }

  function distributedIndices(total, count) {
    if (count >= total) return Array.from({ length: total }, (_, index) => index);
    if (count <= 1) return total ? [0] : [];
    const indices = [];
    for (let slot = 0; slot < count; slot += 1) {
      const index = Math.round((slot * (total - 1)) / (count - 1));
      if (indices[indices.length - 1] !== index) indices.push(index);
    }
    return indices;
  }

  function buildDocumentContext(values, options = {}) {
    const maxChars = Math.max(1_000, Number(options.maxChars) || DEFAULT_MAX_CHARS);
    const maxParts = Math.max(10, Number(options.maxParts) || DEFAULT_MAX_PARTS);
    const parts = normalizedParts(values);
    const totalChars = parts.reduce((sum, text) => sum + text.length, 0) + Math.max(0, parts.length - 1);
    const complete = parts.length <= maxParts && totalChars <= maxChars;

    let selected = parts;
    let selectedIndices = distributedIndices(parts.length, parts.length);
    if (!complete) {
      const averageChars = parts.length ? Math.max(1, Math.ceil(totalChars / parts.length)) : TARGET_PART_CHARS;
      const estimatedPartChars = Math.min(TARGET_PART_CHARS, Math.max(80, averageChars));
      const sampleCount = Math.min(parts.length, maxParts, Math.max(2, Math.floor(maxChars / estimatedPartChars)));
      selectedIndices = distributedIndices(parts.length, sampleCount);
      const perPartChars = Math.max(24, Math.floor((maxChars - Math.max(0, sampleCount - 1)) / Math.max(1, sampleCount)));
      selected = selectedIndices.map((index) => parts[index].slice(0, perPartChars));
    }

    const text = selected.join("\n").slice(0, maxChars);
    return {
      text,
      metadata: {
        scope: "whole_rendered_document",
        coverage: complete ? "complete" : "distributed_sample",
        complete,
        truncated: !complete,
        source_parts_total: parts.length,
        source_parts_included: selected.length,
        source_chars_total: totalChars,
        source_chars_included: text.length,
        first_source_part: selectedIndices[0] ?? null,
        last_source_part: selectedIndices[selectedIndices.length - 1] ?? null,
      },
    };
  }

  globalThis.AgeeDocumentContextPolicy = Object.freeze({ buildDocumentContext });
})();
