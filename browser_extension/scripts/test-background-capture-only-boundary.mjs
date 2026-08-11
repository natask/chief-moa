import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const policySource = readFileSync(resolve(root, "extension/capture-only-policy.js"), "utf8");
const background = readFileSync(resolve(root, "extension/background.js"), "utf8");
const global = {};
new Function("globalThis", policySource)(global);
const policy = global.AgeeCaptureOnlyPolicy;

function driveBoundary(state, payload, effects) {
  if (!policy.acceptsWorkerPayload(state, payload)) return;
  const event = typeof payload === "string" ? policy.filterGatewayEvent(state, JSON.parse(payload)) : null;
  if (!event && policy.isCaptureOnly(state)) return;
  effects.mutated += 1;
  effects.presented += 1;
  if (event?.actions || event?.action || event?.media || event?.response) effects.dispatched += 1;
}

test("the worker gate appears before binary handling, state mutation, presentation, and dispatch", () => {
  const start = background.indexOf("async function forwardVoiceSessionEvent");
  const end = background.indexOf("function sendVoiceSessionLevel", start);
  const body = background.slice(start, end);
  const gate = body.indexOf("AgeeCaptureOnlyPolicy.acceptsWorkerPayload(session, data)");
  const binary = body.indexOf("data instanceof ArrayBuffer");
  const parsedGate = body.indexOf("AgeeCaptureOnlyPolicy.filterGatewayEvent(session, parsed)");
  const stateMutation = body.indexOf("session.gatewayReady = true");
  const presentation = body.indexOf("updateBrowserAgentPresentation");
  const dispatch = body.indexOf("browserMedia.execute");
  assert.ok(gate > 0 && gate < binary);
  assert.ok(parsedGate > binary && parsedGate < stateMutation);
  assert.ok(parsedGate < presentation && parsedGate < dispatch);
});

test("capture-only drops binary assistant audio and assistant output before effects", () => {
  const effects = { mutated: 0, presented: 0, dispatched: 0 };
  const state = { transcriptionOnly: true };
  driveBoundary(state, new ArrayBuffer(8), effects);
  for (const event of [
    { type: "assistant_text", text: "leak" },
    { type: "assistant_audio_start" },
    { type: "assistant_media", media: { url: "leak" } },
    { type: "page_tweak", action: { type: "hide" } },
    { type: "tool_request", actions: [{ type: "dispatch" }] },
  ]) driveBoundary(state, JSON.stringify(event), effects);
  assert.deepEqual(effects, { mutated: 0, presented: 0, dispatched: 0 });
});

test("transcript and terminal events pass capture-only while Ask stays unchanged", () => {
  const captureEffects = { mutated: 0, presented: 0, dispatched: 0 };
  driveBoundary({ transcriptFinalizing: true }, JSON.stringify({ type: "transcript_final", text: "literal" }), captureEffects);
  driveBoundary({ transcriptFinalizing: true }, JSON.stringify({ type: "turn_done", status: "completed", actions: [{ type: "dispatch" }] }), captureEffects);
  assert.deepEqual(captureEffects, { mutated: 2, presented: 2, dispatched: 0 });
  const askEffects = { mutated: 0, presented: 0, dispatched: 0 };
  driveBoundary({}, JSON.stringify({ type: "page_tweak", action: { type: "hide" } }), askEffects);
  assert.deepEqual(askEffects, { mutated: 1, presented: 1, dispatched: 1 });
});
