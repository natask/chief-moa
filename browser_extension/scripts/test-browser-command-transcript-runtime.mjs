import assert from "node:assert/strict";

await import(`../extension/browser-command-transcript-runtime.js?test=${Date.now()}`);
const runtime = globalThis.AgeeBrowserCommandTranscriptRuntime;

for (const text of [
  "find me an ergonomic red chair on Amazon",
  "search Amazon for desk lamps",
  "open a new tab that says mechanical keyboards",
  "open example.com",
]) {
  assert.equal(runtime.isBrowserCommandTranscript(text), true, text);
}
for (const text of ["tell me about chairs", "find this button", "open your mind", "x\ny"]) {
  assert.equal(runtime.isBrowserCommandTranscript(text), false, text);
}
