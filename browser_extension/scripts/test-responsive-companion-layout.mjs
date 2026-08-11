import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../extension/ribbon-layout.js", import.meta.url), "utf8");
const global = {};
new Function("globalThis", source)(global);
const L = global.AgeeRibbonLayout;

const viewports = [
  [320, 568],
  [375, 667],
  [390, 844],
  [667, 375],
];
const intersects = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
const rect = ({ left, top, width, height }) => ({ left, top, width, height, right: left + width, bottom: top + height });

test("mobile launcher bounds remain ordered and keep the mascot on screen", () => {
  for (const viewportWidth of [320, 375]) {
    const bounds = L.launcherBounds({ viewportWidth, viewportHeight: 667, launcherWidth: 45, launcherHeight: 45 });
    assert.ok(bounds.minLeft <= bounds.maxLeft);
    assert.ok(bounds.minTop <= bounds.maxTop);
    const placed = L.clampLauncher(viewportWidth, 667, bounds);
    assert.ok(placed.left >= 8 && placed.left + 45 <= viewportWidth - 8);
    assert.ok(placed.top >= 8 && placed.top + 45 <= 667 - 8);
  }
});

test("mobile control rail stays inset and clear of mascot and ribbons", () => {
  for (const [viewportWidth, viewportHeight] of viewports) {
    const bounds = L.launcherBounds({ viewportWidth, viewportHeight, launcherWidth: 45, launcherHeight: 45 });
    const point = L.clampLauncher(viewportWidth - 63, viewportHeight - 63, bounds);
    const mascot = rect({ ...point, width: 45, height: 45 });
    const ribbon = L.ribbonPlacement({
      launcherRect: mascot,
      viewportWidth,
      viewportHeight,
      ribbonWidth: Math.max(260, Math.min(viewportWidth * 0.4, 380)),
    });
    const upper = rect({
      left: ribbon.youLeft,
      top: viewportHeight - ribbon.youBottom - 36,
      width: ribbon.youWidth,
      height: 36,
    });
    const lower = rect({ left: ribbon.replyLeft, top: ribbon.replyTop, width: ribbon.replyWidth, height: 36 });
    const layout = L.companionControlPlacement({
      launcherRect: mascot,
      viewportWidth,
      viewportHeight,
      controls: [
        { id: "draft", width: 137, height: 44 },
        { id: "stop", width: 44, height: 44 },
      ],
    });
    const controls = layout.placements.map(rect);
    for (const control of controls) {
      assert.ok(control.left >= 8 && control.right <= viewportWidth - 8, `${viewportWidth}x${viewportHeight} horizontal inset`);
      assert.ok(control.top >= 8 && control.bottom <= viewportHeight - 8, `${viewportWidth}x${viewportHeight} vertical inset`);
      assert.ok(control.height >= 44, "touch target height");
      assert.equal(intersects(control, mascot), false, "control/mascot non-intersection");
      assert.equal(intersects(control, upper), false, "control/upper-ribbon non-intersection");
      assert.equal(intersects(control, lower), false, "control/lower-ribbon non-intersection");
    }
    assert.equal(intersects(controls[0], controls[1]), false, "independent controls do not overlap");
    const nearestGap = layout.side === "left"
      ? mascot.left - controls[0].right
      : controls[0].left - mascot.right;
    assert.ok(nearestGap >= 8, "nearest control keeps the companion gap");
  }
});

test("copy chooser remains above expanded ribbons with touch-sized rows", () => {
  const css = readFileSync(new URL("../extension/ribbons.css", import.meta.url), "utf8");
  assert.match(css, /#agee-copy-menu\s*\{[^}]*z-index:\s*4;/s);
  assert.match(css, /#agee-copy-menu button\s*\{[^}]*min-height:\s*44px;/s);
  assert.match(css, /\.agee-ribbon\.agee-ribbon-expanded\s*\{[^}]*z-index:\s*2;/s);
});

test("the narrow media rule never shrinks fixed Stop below its touch target", () => {
  const css = readFileSync(new URL("../extension/overlay.css", import.meta.url), "utf8");
  const narrow = css.match(/@media \(max-width: 380px\) \{([\s\S]*?)\n\}/)?.[1] || "";
  assert.doesNotMatch(narrow, /#agee-stop/);
  assert.match(css, /#agee-stop\s*\{[^}]*width:\s*44px;[^}]*height:\s*44px;[^}]*min-width:\s*44px;/s);
});

test("controls stack without clipping when a horizontal rail cannot fit", () => {
  for (const [viewportWidth, viewportHeight] of [[180, 300], [240, 360], [280, 480], [319, 568]]) {
    const mascot = rect({ left: Math.round(viewportWidth * 0.5), top: Math.min(190, viewportHeight - 100), width: 45, height: 45 });
    const layout = L.companionControlPlacement({
      launcherRect: mascot,
      viewportWidth,
      viewportHeight,
      controls: [
        { id: "draft", width: 137, height: 44 },
        { id: "stop", width: 44, height: 44 },
      ],
    });
    assert.ok(layout.stacked === true || layout.side === "split", `${viewportWidth}px uses a contained degraded layout`);
    assert.notEqual(layout.impossible, true);
    const controls = layout.placements.map(rect);
    for (const control of controls) {
      assert.ok(control.left >= 8 && control.right <= viewportWidth - 8, "stack is horizontally contained");
      assert.ok(control.top >= 8 && control.bottom <= viewportHeight - 8, "stack is vertically contained");
      assert.ok(control.height >= 44, "stack keeps full touch height");
      assert.equal(intersects(control, mascot), false, "detached stack does not cover mascot");
    }
    assert.equal(intersects(controls[0], controls[1]), false, "stack rows stay separate");
  }
});

test("an impossible single control is reported instead of silently shrinking", () => {
  const layout = L.companionControlPlacement({
    launcherRect: rect({ left: 70, top: 70, width: 45, height: 45 }),
    viewportWidth: 120,
    viewportHeight: 180,
    controls: [{ id: "oversize", width: 137, height: 44 }],
  });
  assert.equal(layout.stacked, true);
  assert.equal(layout.impossible, true);
  assert.equal(layout.placements[0].width, 137, "never shrinks a control below its measured target");
});

test("a short viewport splits controls across the mascot lane instead of overflowing vertically", () => {
  const mascot = rect({ left: 150, top: 18, width: 45, height: 45 });
  const layout = L.companionControlPlacement({
    launcherRect: mascot,
    viewportWidth: 350,
    viewportHeight: 80,
    controls: [
      { id: "draft", width: 137, height: 44 },
      { id: "stop", width: 44, height: 44 },
    ],
  });
  assert.equal(layout.side, "split");
  assert.equal(layout.impossible, false);
  for (const control of layout.placements.map(rect)) {
    assert.ok(control.top >= 8 && control.bottom <= 72, "short layout is height-contained");
    assert.equal(intersects(control, mascot), false);
  }
});

test("a cramped viewport reports mascot coexistence as impossible", () => {
  const mascot = rect({ left: 90, top: 58, width: 45, height: 45 });
  const layout = L.companionControlPlacement({
    launcherRect: mascot,
    viewportWidth: 180,
    viewportHeight: 160,
    controls: [
      { id: "draft", width: 137, height: 44 },
      { id: "stop", width: 44, height: 44 },
    ],
  });
  assert.equal(layout.impossible, true);
  assert.equal(layout.stacked, true);
  for (const control of layout.placements.map(rect)) {
    assert.ok(control.left >= 8 && control.right <= 172);
    assert.ok(control.top >= 8 && control.bottom <= 152);
  }
  const draftJs = readFileSync(new URL("../extension/voice-draft-controls.js", import.meta.url), "utf8");
  const surfaceJs = readFileSync(new URL("../extension/browser-surface-controls.js", import.meta.url), "utf8");
  const draftCss = readFileSync(new URL("../extension/voice-draft-controls.css", import.meta.url), "utf8");
  assert.match(draftJs, /classList\.toggle\("agee-control-layout-impossible", layout\.impossible === true\)/);
  assert.match(surfaceJs, /classList\.toggle\("agee-control-layout-impossible", layout\.impossible === true\)/);
  assert.match(draftCss, /agee-control-layout-impossible #agee-launcher[\s\S]*visibility:\s*hidden !important/);
});

test("controls taller than the usable viewport never pass through split layout", () => {
  const layout = L.companionControlPlacement({
    launcherRect: rect({ left: 150, top: 8, width: 45, height: 24 }),
    viewportWidth: 350,
    viewportHeight: 40,
    controls: [
      { id: "draft", width: 137, height: 44 },
      { id: "stop", width: 44, height: 44 },
    ],
  });
  assert.notEqual(layout.side, "split");
  assert.equal(layout.impossible, true);
});

test("hiding the last fixed control clears the impossible fallback state", () => {
  const draftJs = readFileSync(new URL("../extension/voice-draft-controls.js", import.meta.url), "utf8");
  const surfaceJs = readFileSync(new URL("../extension/browser-surface-controls.js", import.meta.url), "utf8");
  assert.match(draftJs, /if \(toolbar\.hidden\) \{[\s\S]*?#agee-stop\.visible[\s\S]*?classList\.remove\("agee-control-layout-impossible"\)/);
  assert.match(draftJs, /if \(!active\) root\.dispatchEvent\(new globalThis\.CustomEvent\("agee:position-companion-controls"\)\)/);
  assert.match(surfaceJs, /if \(!stopButton\.classList\.contains\("visible"\)\) \{[\s\S]*?#agee-draft-controls:not\(\[hidden\]\)[\s\S]*?classList\.remove\("agee-control-layout-impossible"\)/);
  assert.match(surfaceJs, /addEventListener\("agee:position-companion-controls", positionStop\)/);
});
