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
  for (const state of [{ dictation: true }, { finalizeTranscriptOnly: true }, { transcriptionOnly: true }, { transcriptFinalizing: true }]) {
    for (const type of policy.ASSISTANT_EVENT_TYPES) assert.equal(policy.acceptsAssistantEvent(state, type), false, type);
    assert.equal(policy.acceptsAssistantEvent(state, "transcript_final"), true);
    assert.equal(policy.acceptsAssistantEvent(state, "turn_done"), true);
  }
});

test("Ask turns keep assistant text and audio", () => {
  for (const type of policy.ASSISTANT_EVENT_TYPES) assert.equal(policy.acceptsAssistantEvent({}, type), true, type);
});

test("capture-only terminal events pass without embedded effects", () => {
  const event = policy.filterGatewayEvent({ transcriptionOnly: true }, {
    type: "turn_done", status: "completed", text: "assistant text", speak: "leak",
    action: { type: "media.open" }, actions: [{ type: "media.open" }],
    proposals: [{ type: "media.open" }], action_proposals: [{ type: "media.open" }],
    result: {
      action: { type: "media.open" }, actions: [{ type: "media.open" }],
      proposals: [{ type: "media.open" }], action_proposals: [{ type: "media.open" }],
    },
  });
  assert.deepEqual(event, { type: "turn_done", status: "completed" });
  assert.equal(policy.filterGatewayEvent({ transcriptFinalizing: true }, { type: "page_tweak" }), null);
  assert.deepEqual(
    policy.filterGatewayEvent({ transcriptFinalizing: true }, { type: "transcript_final", text: "literal" }),
    { type: "transcript_final", text: "literal" },
  );
});

test("every capture event uses its own positive field allowlist", () => {
  for (const [type, fields] of Object.entries(policy.CAPTURE_EVENT_FIELDS)) {
    const event = Object.fromEntries(fields.map((field) => [field, `${type}:${field}`]));
    Object.assign(event, {
      action: { type: "media.open" }, actions: [{ type: "media.open" }],
      proposals: [{ type: "media.open" }], action_proposals: [{ type: "media.open" }],
      media: { type: "media.open" },
      result: {
        action: { type: "media.open" }, actions: [{ type: "media.open" }],
        proposals: [{ type: "media.open" }], action_proposals: [{ type: "media.open" }],
      },
    });
    event.type = type;
    assert.deepEqual(Object.keys(policy.filterGatewayEvent({ transcriptionOnly: true }, event)), fields, type);
  }
});
