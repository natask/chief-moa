// Ribbon text model: the bounded turn buffer and the copy-variant selection.
// Contract: reference/design/overlay-2026-07-28/spec.md sections 5 and 5.1,
// and overlay-2026-07 section 7.4 for the variants.
//
// Pure. No DOM, no timers, no extension APIs. This is the half of the bubble
// design that has to be exactly right, so it is isolated and unit-tested
// directly (scripts/test-ribbon-window.mjs) instead of only through the
// real-browser smoke.
//
// There is no rendered window any more. WINDOW_CHARS, windowFor and overflowFor
// existed to keep a single unwrapping line inside a fixed 28px box by sliding
// it under a clip; the current one-line collapsed / three-line expanded window
// bounds the same thing in layout. What survives is the buffer
// cap: the whole turn is retained for copy and expand, just not without limit.
(function initAgeeRibbonWindow(global) {
  "use strict";

  // Per-turn retained text, used by copy. Bounded so a long turn cannot grow
  // memory without limit. Same number as Android's BUFFER_MAX_CHARS.
  const BUFFER_MAX_CHARS = 8000;

  let segmenter = null;

  // The last `limit` grapheme clusters, never splitting a cluster. Ethiopic and
  // CJK count as one cluster per rendered glyph, so a tail cut can never orphan
  // a combining mark.
  function graphemeTail(text, limit) {
    const value = String(text || "");
    if (value.length <= limit) return value;
    if (segmenter === null) {
      segmenter = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
        ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
        : false;
    }
    if (!segmenter) return value.slice(-limit);
    const parts = [];
    for (const part of segmenter.segment(value)) parts.push(part.segment);
    return parts.length <= limit ? value : parts.slice(-limit).join("");
  }

  // Append a delta and keep the buffer bounded. Returns the new buffer plus
  // whether text was dropped from the front, which the copy caption reports.
  function appendDelta(buffer, delta) {
    const next = String(buffer || "") + String(delta || "");
    if (next.length <= BUFFER_MAX_CHARS) return { buffer: next, truncated: false };
    return { buffer: graphemeTail(next, BUFFER_MAX_CHARS), truncated: true };
  }

  function boundBuffer(text) {
    const value = String(text || "");
    if (value.length <= BUFFER_MAX_CHARS) return { buffer: value, truncated: false };
    return { buffer: graphemeTail(value, BUFFER_MAX_CHARS), truncated: true };
  }

  // Split into grapheme clusters once, so a paced reveal can advance one
  // rendered glyph at a time. Slicing a JS string by code-unit index can cut an
  // Ethiopic combining sequence or a surrogate pair in half and paint a broken
  // glyph for a frame; Amharic replies made that visible.
  function graphemes(text) {
    const value = String(text || "");
    if (!value) return [];
    if (segmenter === null) {
      segmenter = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
        ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
        : false;
    }
    if (!segmenter) return [...value];
    const parts = [];
    for (const part of segmenter.segment(value)) parts.push(part.segment);
    return parts;
  }

  // ---- Copy variants ------------------------------------------------------
  // literal / user-edited / named writing-skill candidate, per
  // reference/openspec/changes/voice-capture-notebook-ime section 3.3.
  // Rank order is fixed; availability is not. The rail never substitutes one
  // variant for another silently and never presents literal text as polished.
  const VARIANT_RANK = Object.freeze(["skill", "edited", "literal"]);
  const VARIANT_LABELS = Object.freeze({
    skill: "Polished",
    edited: "Corrected",
    literal: "Literal transcript",
  });
  const VARIANT_NOTES = Object.freeze({
    skill: "rewritten in your own style",
    edited: "recognition and grammar fixed, wording kept",
    literal: "exactly what was transcribed",
  });
  const VARIANT_MISSING_NOTE = "not generated for this turn";

  function emptyVariants() {
    return { literal: "", edited: "", skill: "" };
  }

  // `literal` always tracks the live buffer; the derived revisions only exist
  // when a producer has supplied them.
  function variantText(state, key) {
    if (!state) return "";
    if (key === "literal") return state.variants?.literal || state.buffer || "";
    return state.variants?.[key] || "";
  }

  // The highest-ranked variant that actually exists. Polished is the intended
  // default, but an absent variant falls through rather than being faked.
  function defaultVariant(state) {
    if (state?.chosenVariant && variantText(state, state.chosenVariant)) return state.chosenVariant;
    for (const key of VARIANT_RANK) {
      if (variantText(state, key)) return key;
    }
    return "literal";
  }

  // Merge derived revisions from a turn payload. Unknown keys are ignored and
  // absent keys leave that variant unavailable.
  function mergeVariants(variants, patch) {
    const next = { ...emptyVariants(), ...(variants || {}) };
    let skillName = null;
    if (patch && typeof patch === "object") {
      for (const key of ["edited", "skill"]) {
        if (typeof patch[key] === "string") next[key] = patch[key];
      }
      if (typeof patch.skill_name === "string") skillName = patch.skill_name;
    }
    return { variants: next, skillName };
  }

  // The rows the chooser renders, in rank order, with the reason an
  // unavailable variant is unavailable. Discoverable before the data exists.
  function variantRows(state) {
    const active = defaultVariant(state);
    return VARIANT_RANK.map((key) => {
      const text = variantText(state, key);
      const label = key === "skill" && state?.skillName
        ? `${VARIANT_LABELS.skill} — ${state.skillName}`
        : VARIANT_LABELS[key];
      return {
        key,
        label,
        note: text ? VARIANT_NOTES[key] : VARIANT_MISSING_NOTE,
        available: !!text,
        isDefault: key === active,
      };
    });
  }

  // ---- Presentation adoption ---------------------------------------------
  // The owning tab is ahead of the worker's broadcast while a stream is in
  // flight, so a broadcast that is merely a prefix of what is already rendered
  // must not rewind the visible text.
  function shouldAdoptPresentationText(currentBuffer, incoming, isOwner) {
    const next = String(incoming || "");
    if (!next) return false;
    const current = String(currentBuffer || "");
    if (next === current) return false;
    if (isOwner && current && current.startsWith(next)) return false;
    return true;
  }

  global.AgeeRibbonWindow = Object.freeze({
    BUFFER_MAX_CHARS,
    VARIANT_RANK,
    VARIANT_LABELS,
    VARIANT_NOTES,
    VARIANT_MISSING_NOTE,
    appendDelta,
    boundBuffer,
    defaultVariant,
    emptyVariants,
    graphemeTail,
    mergeVariants,
    graphemes,
    shouldAdoptPresentationText,
    variantRows,
    variantText,
  });
})(globalThis);
