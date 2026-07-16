import assert from "node:assert/strict";

await import(`../extension/content-context-control-runtime.js?test=${Date.now()}`);
const { createContentContextControlRuntime } = globalThis.AgeeContentContextControlRuntime;

const cues = [];
const runtime = createContentContextControlRuntime({
  onModeCue: (label, statusText) => cues.push({ label, statusText }),
});
assert.ok(Object.isFrozen(runtime));
assert.deepEqual(runtime.consumeContextControls(), { action: "", label: "" });

for (const value of [null, "", "ordinary request", "/-", "/unknown value"]) {
  assert.equal(runtime.maybeHandleContextSlashCommand(value), false);
}
assert.deepEqual(cues, []);

assert.equal(runtime.maybeHandleContextSlashCommand(" /InCoGnItO on "), true);
assert.deepEqual(cues.at(-1), {
  label: "/incognito",
  statusText: "Incognito on. Turns are answered but not saved.",
});
assert.deepEqual(runtime.consumeContextControls(), { action: "incognito", label: "" });
assert.deepEqual(runtime.consumeContextControls(), { action: "incognito", label: "" });

assert.equal(runtime.maybeHandleContextSlashCommand("/incognito off"), true);
assert.deepEqual(cues.at(-1), {
  label: "/incognito",
  statusText: "Incognito off. Turns are saved again.",
});
assert.deepEqual(runtime.consumeContextControls(), { action: "", label: "" });

assert.equal(runtime.maybeHandleContextSlashCommand("/incognito"), true);
assert.deepEqual(runtime.consumeContextControls(), { action: "incognito", label: "" });
assert.equal(runtime.maybeHandleContextSlashCommand("/incognito toggle"), true);
assert.deepEqual(runtime.consumeContextControls(), { action: "", label: "" });

assert.equal(runtime.maybeHandleContextSlashCommand("/new"), true);
assert.deepEqual(cues.at(-1), {
  label: "/new",
  statusText: "New thread armed. The next turn starts fresh.",
});
assert.deepEqual(runtime.consumeContextControls(), { action: "new", label: "" });
assert.deepEqual(runtime.consumeContextControls(), { action: "", label: "" });

const longLabel = `  ${"x".repeat(130)}  `;
assert.equal(runtime.maybeHandleContextSlashCommand(`/NEW ${longLabel}`), true);
assert.deepEqual(cues.at(-1), {
  label: `/NEW ${longLabel}`.trim(),
  statusText: `New thread armed ("${"x".repeat(120)}"). The next turn starts fresh.`,
});
assert.deepEqual(runtime.consumeContextControls(), { action: "new", label: "x".repeat(120) });

assert.equal(runtime.maybeHandleContextSlashCommand("/new deferred"), true);
assert.equal(runtime.maybeHandleContextSlashCommand("/incognito on"), true);
assert.deepEqual(runtime.consumeContextControls(), { action: "incognito", label: "" });
assert.equal(runtime.maybeHandleContextSlashCommand("/incognito off"), true);
assert.deepEqual(runtime.consumeContextControls(), { action: "new", label: "deferred" });

const defaultCue = createContentContextControlRuntime();
assert.equal(defaultCue.maybeHandleContextSlashCommand("/new silent"), true);
assert.deepEqual(defaultCue.consumeContextControls(), { action: "new", label: "silent" });
const invalidCue = createContentContextControlRuntime({ onModeCue: "not a function" });
assert.equal(invalidCue.maybeHandleContextSlashCommand("/incognito on"), true);

console.log("content context-control runtime tests passed");
