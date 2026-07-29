import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, "..", "extension", "ribbon-geometry-report.js"), "utf8");
const sandbox = { globalThis: null };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(source, sandbox);
const Report = sandbox.AgeeRibbonGeometryReport;

const sane = {
  id: "agee-ribbon-reply",
  positioned: true,
  boxWidth: 340,
  runWidth: 320,
  maxWidth: 340,
  viewportWidth: 1440,
  launcherWidth: 35,
  launcherHeight: 35,
  theme: "light",
  text: 120,
};

test("a box within its cap is not a breach", () => {
  assert.equal(Report.inspect(sane), null);
});

test("sub-pixel overshoot is rounding, not a bug", () => {
  assert.equal(Report.inspect({ ...sane, boxWidth: 342 }), null);
  assert.equal(Report.inspect({ ...sane, runWidth: 342 }), null);
});

test("a box wider than the layout's own cap is recorded", () => {
  const breach = Report.inspect({ ...sane, boxWidth: 1408 });
  assert.equal(breach.kind, "box_over_cap");
  assert.equal(breach.box, 1408);
  assert.equal(breach.cap, 340);
});

// The band: the box is the right size but the glyph run inside it is as wide
// as the whole reply, and the scrim paints behind the run.
test("a run wider than its box is recorded as the band", () => {
  const breach = Report.inspect({ ...sane, runWidth: 1900 });
  assert.equal(breach.kind, "run_over_box");
  assert.equal(breach.run, 1900);
  assert.equal(breach.box, 340);
});

test("geometry that was never written is a breach whatever the widths say", () => {
  const breach = Report.inspect({ ...sane, positioned: false, boxWidth: 300, runWidth: 100, maxWidth: 0 });
  assert.equal(breach.kind, "unpositioned");
  assert.equal(breach.launcher, "35x35");
});

test("a breach carries the context needed to tell the three apart", () => {
  const line = Report.format(Report.inspect({ ...sane, runWidth: 1900 }));
  for (const part of ["run_over_box", "agee-ribbon-reply", "box=340", "run=1900", "cap=340", "vw=1440", "launcher=35x35", "theme=light", "chars=120"]) {
    assert.ok(line.includes(part), `missing ${part} in: ${line}`);
  }
});

test("format of nothing is nothing", () => {
  assert.equal(Report.format(null), "");
});

test("the ring is bounded", () => {
  let list = [];
  for (let i = 0; i < 40; i += 1) {
    list = Report.append(list, Report.inspect({ ...sane, id: `r${i}`, runWidth: 1900 }), { at: i });
  }
  assert.equal(list.length, Report.MAX_RECORDS);
  assert.equal(list[list.length - 1].id, "r39");
});

// A breach that persists across frames would otherwise fill the ring within a
// second and push out the earlier, different breach that explains it.
test("a repeating breach counts instead of repeating", () => {
  let list = [];
  list = Report.append(list, Report.inspect({ ...sane, positioned: false }), { at: 10 });
  for (let i = 0; i < 5; i += 1) {
    list = Report.append(list, Report.inspect({ ...sane, runWidth: 1900 }), { at: 20 + i });
  }
  assert.equal(list.length, 2);
  assert.equal(list[0].kind, "unpositioned");
  assert.equal(list[1].kind, "run_over_box");
  assert.equal(list[1].seen, 5);
  assert.equal(list[1].first_at, 20, "the ring keeps when it started, not just when it last recurred");
  assert.equal(list[1].at, 24);
});

test("appending nothing leaves the ring alone", () => {
  const list = Report.append([{ kind: "unpositioned" }], null);
  assert.equal(list.length, 1);
});
