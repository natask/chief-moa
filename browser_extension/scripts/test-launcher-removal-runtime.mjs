import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import vm from "node:vm";

const root = resolve(new URL("..", import.meta.url).pathname);
const source = readFileSync(join(root, "extension", "launcher-removal-runtime.js"), "utf8");
const contentSource = readFileSync(join(root, "extension", "content.js"), "utf8");
const context = { globalThis: {} };
vm.createContext(context);
vm.runInContext(source, context, { filename: "launcher-removal-runtime.js" });

const runtime = context.globalThis.AgeeLauncherRemoval;
assert.ok(runtime, "runtime installs on globalThis");

const target = { left: 80, right: 120, top: 180, bottom: 220 };
const start = () => runtime.begin({ pointerId: 7, x: 20, y: 20 });

let state = runtime.move(start(), { pointerId: 7, x: 24, y: 23 }, target);
assert.equal(state.moved, false, "pointer jitter is not genuine movement");
assert.equal(state.targetVisible, false, "target stays hidden before genuine movement");
assert.equal(runtime.finish(state, { type: "pointerup", pointerId: 7, x: 24, y: 23 }, target).action, "tap");

state = runtime.move(start(), { pointerId: 7, x: 40, y: 40 }, target);
assert.equal(state.targetVisible, true, "target appears after genuine movement");
assert.equal(state.armed, false, "ordinary drag does not arm removal");
assert.equal(runtime.finish(state, { type: "pointerup", pointerId: 7, x: 40, y: 40 }, target).action, "persist_position");

state = runtime.move(state, { pointerId: 7, x: 100, y: 200 }, target);
assert.equal(state.armed, true, "target arms while pointer is inside");
state = runtime.move(state, { pointerId: 7, x: 140, y: 200 }, target);
assert.equal(state.armed, false, "target disarms when pointer leaves");
assert.equal(runtime.finish(state, { type: "pointerup", pointerId: 7, x: 140, y: 200 }, target).removed, false);

state = runtime.move(start(), { pointerId: 7, x: 100, y: 200 }, target);
assert.equal(runtime.finish(state, { type: "pointercancel", pointerId: 7, x: 100, y: 200 }, target).action, "cancel");
assert.equal(runtime.finish(state, { type: "pointerup", pointerId: 7, x: 100, y: 200 }, target).action, "remove");

assert.equal(runtime.finish(state, { type: "pointerup", pointerId: 8, x: 100, y: 200 }, target).action, "ignore");
assert.equal(runtime.finish(state, { type: "pointerup", pointerId: 7, x: 121, y: 200 }, target).removed, false, "release outside never removes despite prior armed state");

assert.match(contentSource, /restoreLauncherVisibility\(\)/, "a removed launcher stays removed after page reinjection");
assert.match(contentSource, /if \(launcher\?\.hidden\) \{[\s\S]{0,180}ageeLauncherHidden: false/, "opening by shortcut or toolbar restores the launcher");

console.log("launcher-removal-runtime ok");
