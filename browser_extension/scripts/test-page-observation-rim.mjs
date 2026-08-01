import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const background = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
const content = readFileSync(new URL("../extension/content.js", import.meta.url), "utf8");
const ribbonRuntime = readFileSync(new URL("../extension/ribbon-runtime.js", import.meta.url), "utf8");
const overlayCss = readFileSync(new URL("../extension/overlay.css", import.meta.url), "utf8");

assert.match(background, /phase: "reading"/);
assert.match(background, /phase: "seeing"/);
assert.match(background, /finally \{[\s\S]{0,140}phase: "done"/);
assert.match(content, /case "browserPageObservation"[^\n]*setPageObservation/);
assert.match(ribbonRuntime, /id === activePageObservationId/);
assert.match(ribbonRuntime, /remove\("agee-page-observing-reading", "agee-page-observing-seeing"\)/);
assert.match(overlayCss, /#agee-root\.agee-page-observing-reading::before/);
assert.match(overlayCss, /#agee-root\.agee-page-observing-seeing::before/);
assert.match(overlayCss, /@media \(prefers-reduced-motion: reduce\)/);

console.log("page observation rim contract passed");
