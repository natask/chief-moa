import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const content = readFileSync(resolve(root, "extension/content.js"), "utf8");

test("capture-only commit never enters the shared thinking state", () => {
  assert.match(content, /const captureOnly = AgeeCaptureOnlyPolicy\.isCaptureOnly\(state\);/);
  assert.match(content, /setAgentState\(captureOnly \? "idle" : "thinking"\);/);
  assert.match(content, /setTranscript\(state\.transcript \|\| ""\);/);
});

test("capture-only input drops stray assistant text and binary audio", () => {
  assert.match(content, /AgeeCaptureOnlyPolicy\.acceptsAssistantEvent\(state, msg\.type\)/);
  assert.match(content, /payload\?\.audio \|\| payload\?\.data instanceof ArrayBuffer \|\| payload\?\.data instanceof Blob/);
});
