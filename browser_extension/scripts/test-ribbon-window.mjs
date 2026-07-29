// The ribbon text model is the half of the overlay design that has to be
// exactly right: the bounded turn buffer is what keeps a long turn from growing
// memory without limit, and the variant ranking is what stops literal text being
// presented as polished. Both are pure, so they are tested directly here rather
// than only through the real-browser smoke.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const source = readFileSync(resolve(root, "extension/ribbon-window.js"), "utf8");
const global = {};
new Function("globalThis", source)(global);
const W = global.AgeeRibbonWindow;

// The bubble renders the whole buffer and bounds it by height, so the model no
// longer trims what is rendered. Nothing may bring the sliding window back:
// with the box wrapping, a rendered tail would silently drop the top of a turn
// that is still on screen.
test("the model no longer trims the rendered text", () => {
  for (const gone of ["WINDOW_CHARS", "windowFor", "overflowFor"]) {
    assert.equal(gone in W, false, `${gone} belongs to the deleted sliding window`);
  }
});

test("the tail never splits a grapheme cluster", () => {
  // Ethiopic and an emoji with a combining modifier: cutting mid-cluster would
  // render a broken glyph.
  const text = `${"ሀለሐ".repeat(80)}👩🏽‍🚀`;
  const tail = W.graphemeTail(text, 5);
  assert.ok(tail.endsWith("👩🏽‍🚀"), tail);
  assert.equal([...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(tail)].length, 5);
});

test("the buffer is bounded and reports truncation", () => {
  const first = W.appendDelta("", "a".repeat(W.BUFFER_MAX_CHARS - 1));
  assert.equal(first.truncated, false);
  assert.equal(first.buffer.length, W.BUFFER_MAX_CHARS - 1);

  const second = W.appendDelta(first.buffer, "bb");
  assert.equal(second.truncated, true);
  assert.equal(second.buffer.length, W.BUFFER_MAX_CHARS);
  // Dropped from the front, so the newest text always survives.
  assert.ok(second.buffer.endsWith("bb"));
});

test("the retained buffer matches the Android cap", () => {
  assert.equal(W.BUFFER_MAX_CHARS, 8000, "same number as Android's BUFFER_MAX_CHARS");
  // The whole turn is retained, so copy and expand are never short-changed by
  // what the collapsed bubble happens to be showing.
  const whole = "y".repeat(4000);
  assert.equal(W.boundBuffer(whole).buffer, whole);
  assert.equal(W.boundBuffer(whole).truncated, false);
});

test("the default copy variant is the highest-ranked one that exists", () => {
  const base = { buffer: "literal text", variants: W.emptyVariants(), chosenVariant: "" };
  assert.equal(W.defaultVariant(base), "literal", "nothing derived yet -> literal");

  const edited = { ...base, variants: { ...W.emptyVariants(), edited: "corrected" } };
  assert.equal(W.defaultVariant(edited), "edited");

  const both = { ...base, variants: { ...W.emptyVariants(), edited: "corrected", skill: "polished" } };
  assert.equal(W.defaultVariant(both), "skill", "polished is the intended default when it exists");
});

test("an explicit choice sticks only while that variant exists", () => {
  const state = {
    buffer: "literal text",
    variants: { ...W.emptyVariants(), edited: "corrected" },
    chosenVariant: "edited",
  };
  assert.equal(W.defaultVariant(state), "edited");
  // A turn with no corrected revision falls back rather than copying nothing.
  assert.equal(W.defaultVariant({ ...state, variants: W.emptyVariants() }), "literal");
});

test("variant rows expose availability with a reason and never fake a variant", () => {
  const rows = W.variantRows({
    buffer: "literal text",
    variants: { ...W.emptyVariants(), edited: "corrected" },
    skillName: "plain style",
  });
  assert.deepEqual(rows.map((row) => row.key), ["skill", "edited", "literal"]);
  assert.equal(rows[0].available, false);
  assert.equal(rows[0].note, W.VARIANT_MISSING_NOTE);
  assert.equal(rows[0].label, "Polished — plain style");
  assert.equal(rows[1].available, true);
  assert.equal(rows[1].isDefault, true, "default is the highest available, not the highest ranked");
  assert.equal(rows[2].available, true, "literal is always available");
});

test("literal always tracks the buffer and derived revisions never overwrite it", () => {
  const merged = W.mergeVariants(W.emptyVariants(), { edited: "corrected", skill_name: "plain" });
  assert.equal(merged.variants.edited, "corrected");
  assert.equal(merged.variants.literal, "", "merging derived text must not write literal");
  assert.equal(merged.skillName, "plain");
  // literal is read from the live buffer, so it cannot drift from what was said.
  assert.equal(W.variantText({ buffer: "said aloud", variants: merged.variants }, "literal"), "said aloud");
  // A payload without variants leaves everything unavailable.
  assert.deepEqual(W.mergeVariants(W.emptyVariants(), undefined).variants, W.emptyVariants());
});

test("a presentation broadcast never rewinds the owning tab mid-stream", () => {
  // The owner is ahead of the worker while streaming: the broadcast is a prefix.
  assert.equal(W.shouldAdoptPresentationText("hello world", "hello", true), false);
  // A non-owner adopts the broadcast even when it looks like a prefix, because
  // its own text is a stale copy rather than a live stream.
  assert.equal(W.shouldAdoptPresentationText("hello world", "hello", false), true);
  // Genuinely newer text is always adopted.
  assert.equal(W.shouldAdoptPresentationText("hello", "hello world", true), true);
  // Identical or empty text is a no-op.
  assert.equal(W.shouldAdoptPresentationText("hello", "hello", true), false);
  assert.equal(W.shouldAdoptPresentationText("hello", "", true), false);
});
