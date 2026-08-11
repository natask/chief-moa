import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const source = readFileSync(resolve(root, "extension/capture-only-policy.js"), "utf8");
const global = {};
new Function("globalThis", source)(global);
const policy = global.AgeeCaptureOnlyPolicy;

test("capture-only turns reject every assistant event", () => {
  for (const state of [{ dictation: true }, { finalizeTranscriptOnly: true }, { transcriptionOnly: true }]) {
    for (const type of policy.ASSISTANT_EVENT_TYPES) assert.equal(policy.acceptsAssistantEvent(state, type), false, type);
    assert.equal(policy.acceptsAssistantEvent(state, "transcript_final"), true);
    assert.equal(policy.acceptsAssistantEvent(state, "turn_done"), true);
  }
});

test("Ask turns keep assistant text and audio", () => {
  for (const type of policy.ASSISTANT_EVENT_TYPES) assert.equal(policy.acceptsAssistantEvent({}, type), true, type);
});
