// Ribbon geometry self-report.
//
// The overlay sometimes paints a dark band the width of the page instead of a
// bounded box. It is intermittent, it happens on the user's pages rather than
// a fixture, and a screenshot cannot say which of three things went wrong. So
// the overlay records it: every paint is measured against what the layout
// promised, and a measurement that breaks the promise is written down where
// both the page console and an agent can read it.
//
// Three distinct failures, deliberately named apart, because they have
// different repairs:
//
//   unpositioned  position() never wrote the geometry — the companion had no
//                 box to lay out from, so the box kept whatever the stylesheet
//                 gave it and nothing bounded it.
//   box_over_cap  the box itself is wider than the layout's own maximum. The
//                 cap is computed, so this means something outside the layout
//                 is setting the width.
//   run_over_box  the box is fine but the glyph run inside it is wider — the
//                 scrim paints behind the run, so this is the band. The run is
//                 one white-space: pre line, so it is as wide as the whole
//                 reply rather than as wide as what you can see.
//
// Pure: takes plain numbers, returns plain records. Unit-tested directly in
// scripts/test-ribbon-geometry-report.mjs.
(function initAgeeRibbonGeometryReport(global) {
  "use strict";

  // How far past the promise counts as a breach. Sub-pixel layout rounding and
  // a scrollbar-width change are not bugs; a band across the page is.
  const TOLERANCE_PX = 4;
  const MAX_RECORDS = 12;

  function px(value) {
    const num = Number(value);
    return Number.isFinite(num) ? Math.round(num) : 0;
  }

  // Returns a record when this measurement breaks the layout's promise, or
  // null when it holds. `positioned` is false when position() bailed before
  // writing geometry — that is a breach on its own, whatever the widths say,
  // because nothing was bounding the box at all.
  function inspect({
    id = "",
    positioned = true,
    boxWidth = 0,
    runWidth = 0,
    maxWidth = 0,
    viewportWidth = 0,
    launcherWidth = 0,
    launcherHeight = 0,
    theme = "",
    text = 0,
  } = {}) {
    const box = px(boxWidth);
    const run = px(runWidth);
    const cap = px(maxWidth);
    const base = {
      id: String(id || ""),
      box,
      run,
      cap,
      viewport: px(viewportWidth),
      launcher: `${px(launcherWidth)}x${px(launcherHeight)}`,
      theme: String(theme || ""),
      chars: px(text),
    };
    if (!positioned) return { ...base, kind: "unpositioned" };
    if (cap > 0 && box > cap + TOLERANCE_PX) return { ...base, kind: "box_over_cap" };
    if (box > 0 && run > box + TOLERANCE_PX) return { ...base, kind: "run_over_box" };
    return null;
  }

  // One line, readable at a glance in a console or a data attribute.
  function format(record) {
    if (!record) return "";
    return [
      record.kind,
      record.id,
      `box=${record.box}`,
      `run=${record.run}`,
      `cap=${record.cap}`,
      `vw=${record.viewport}`,
      `launcher=${record.launcher}`,
      `theme=${record.theme}`,
      `chars=${record.chars}`,
    ].join(" ");
  }

  // Bounded, and it does not repeat itself: a breach that persists across
  // frames would otherwise fill the whole ring within a second and push out
  // the earlier, different breach that explains how it got there. Consecutive
  // identical (kind, id) measurements bump a count instead.
  function append(records, record, { max = MAX_RECORDS, at = 0 } = {}) {
    if (!record) return Array.isArray(records) ? records : [];
    const list = Array.isArray(records) ? records.slice() : [];
    const last = list[list.length - 1];
    if (last && last.kind === record.kind && last.id === record.id) {
      list[list.length - 1] = { ...record, at: px(at), first_at: last.first_at ?? last.at, seen: (last.seen || 1) + 1 };
      return list;
    }
    list.push({ ...record, at: px(at), first_at: px(at), seen: 1 });
    return list.slice(-max);
  }

  global.AgeeRibbonGeometryReport = Object.freeze({
    TOLERANCE_PX,
    MAX_RECORDS,
    append,
    format,
    inspect,
  });
})(globalThis);
