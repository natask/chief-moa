// Ribbon text model: the sliding window and the copy-variant selection.
// Contract: reference/design/overlay-2026-07/spec.md sections 4 and 7.4.
//
// Pure. No DOM, no timers, no extension APIs. This is the half of the ribbon
// design that has to be exactly right — the bounded tail window is what stops
// overlay text from covering the page — so it is isolated and unit-tested
// directly (scripts/test-ribbon-window.mjs) instead of only through the
// real-browser smoke.
(function initAgeeRibbonWindow(global) {
  "use strict";

  // A hard cap on the rendered node, not the visual window. The visual window
  // is geometric (see overflowFor) and adapts to font metrics, script, and
  // ribbon width; 140 clusters comfortably exceeds what 340px of 13px text can
  // show in any supported script, so the geometric rule always governs what is
  // visible and this only bounds DOM cost.
  const WINDOW_CHARS = 140;
  // Per-turn retained text, used by copy. Bounded so a long turn cannot grow
  // memory without limit.
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

  // What the collapsed ribbon renders.
  function windowFor(buffer) {
    return graphemeTail(buffer, WINDOW_CHARS);
  }

  // How far the line slides so the newest character stays pinned at the right
  // inner edge. Zero while the text fits, so short text does not drift.
  function overflowFor(viewportInnerWidth, lineWidth) {
    const inner = Number(viewportInnerWidth);
    const line = Number(lineWidth);
    if (!Number.isFinite(inner) || !Number.isFinite(line)) return 0;
    return Math.min(0, inner - line);
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
    WINDOW_CHARS,
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
    overflowFor,
    shouldAdoptPresentationText,
    variantRows,
    variantText,
    windowFor,
  });
})(globalThis);
