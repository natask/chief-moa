"use strict";

// Gateway-side validation for browser page tweaks.
//
// The model may PROPOSE a page tweak as a bounded record; the gateway validates
// the kind against the extension's own allowlist and checks the params shape,
// then hands the record back to the browser client as a structured action. The
// gateway never executes the tweak and never emits CSS or JS: the extension
// (browser_extension/extension/tweaks.js) compiles the CSS locally from
// kind+params. This keeps the no-eval boundary — nothing opaque crosses the
// wire, only a small declarative record the extension already knows how to run.
//
// The kinds and param bounds mirror tweaks.js compileCss/planTweak exactly:
//   hide              { selectors: string[] }
//   css-selector-hide { selector: string }
//   font-scale        { factor: number 0.5..4 }
//   font-size         { px: number 8..72 }
//   dark              {}
//   black             {}
//   width             { maxWidth: number 320..1600 }
// If tweaks.js gains a kind, add it here too; the gateway rejects anything not
// listed rather than passing an unknown kind through.

const TWEAK_KINDS = Object.freeze(["hide", "css-selector-hide", "font-scale", "font-size", "dark", "black", "width"]);

// The extension strips these characters from any param that lands in CSS
// (cssEscapeText in tweaks.js). We reject a param that would be emptied or
// mangled by that stripping so the model cannot smuggle a broken/opaque value.
const CSS_UNSAFE = /[<>{}"'\\;]/;

function clampNumber(value, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return null;
  }
  return Math.min(max, Math.max(min, num));
}

function normalizeKind(kind) {
  return String(kind || "").trim().toLowerCase();
}

// Validate a proposed { kind, params, name? } record. Returns
// { ok: true, record } with a cleaned record, or { ok: false, error } — never
// throws, so a bad proposal is reported to the model instead of failing the turn.
function validatePageTweak(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "a page tweak record is required" };
  }
  const kind = normalizeKind(input.kind);
  if (!kind) {
    return { ok: false, error: "page tweak kind is required" };
  }
  if (!TWEAK_KINDS.includes(kind)) {
    return { ok: false, error: `unsupported page tweak kind: ${kind}`, supported_kinds: TWEAK_KINDS.slice() };
  }
  const rawParams = input.params && typeof input.params === "object" && !Array.isArray(input.params)
    ? input.params
    : {};
  const params = {};

  switch (kind) {
    case "hide": {
      const selectors = Array.isArray(rawParams.selectors) ? rawParams.selectors : [];
      const cleaned = selectors
        .map((selector) => String(selector || "").trim())
        .filter((selector) => selector && !CSS_UNSAFE.test(selector))
        .slice(0, 40);
      if (cleaned.length === 0) {
        return { ok: false, error: "hide requires a non-empty selectors list of plain CSS selectors" };
      }
      params.selectors = cleaned;
      break;
    }
    case "css-selector-hide": {
      const selector = String(rawParams.selector || "").trim();
      if (!selector || CSS_UNSAFE.test(selector)) {
        return { ok: false, error: "css-selector-hide requires a single plain CSS selector" };
      }
      params.selector = selector.slice(0, 400);
      break;
    }
    case "font-scale": {
      const factor = clampNumber(rawParams.factor, 0.5, 4);
      if (factor === null) {
        return { ok: false, error: "font-scale requires a numeric factor between 0.5 and 4" };
      }
      params.factor = factor;
      break;
    }
    case "font-size": {
      const px = clampNumber(rawParams.px, 8, 72);
      if (px === null) {
        return { ok: false, error: "font-size requires a numeric px between 8 and 72" };
      }
      params.px = Math.round(px);
      break;
    }
    case "width": {
      const maxWidth = clampNumber(rawParams.maxWidth ?? rawParams.max_width, 320, 1600);
      if (maxWidth === null) {
        return { ok: false, error: "width requires a numeric maxWidth between 320 and 1600" };
      }
      params.maxWidth = Math.round(maxWidth);
      break;
    }
    case "dark":
    case "black":
      // No params; any provided are ignored.
      break;
    default:
      return { ok: false, error: `unsupported page tweak kind: ${kind}`, supported_kinds: TWEAK_KINDS.slice() };
  }

  const record = { kind, params };
  const name = String(input.name || "").trim().replace(/\s+/g, " ").slice(0, 80);
  if (name) {
    record.name = name;
  }
  return { ok: true, record };
}

module.exports = {
  TWEAK_KINDS,
  validatePageTweak,
};
