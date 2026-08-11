import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createBrowserMediaRuntime,
  executeFirstMediaActionFromTurn,
  mediaActionsFromTurn,
} from "../extension/browser-media-runtime.js";

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
  if (mediaActionsFromTurn(event).length) effects.dispatched += 1;
}

function mediaFixture() {
  const state = {};
  const updates = [];
  const runtime = createBrowserMediaRuntime({
    ask: async () => ({ ok: true }),
    callGateway: async () => ({ bookmarks: [] }),
    confirmMedia: async () => true,
    getConfig: async () => ({ gatewayUrl: "https://gateway.example", gatewayToken: "secret" }),
    storage: {
      get: async (defaults) => ({ ...defaults, ...state }),
      set: async (patch) => Object.assign(state, patch),
    },
    tabs: {
      query: async () => [{ id: 7 }],
      update: async (id, patch) => { updates.push({ id, patch }); return { id, ...patch }; },
    },
  });
  return { runtime, updates };
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
  const actionBoundary = body.indexOf("executeFirstMediaActionFromTurn(parsed");
  const actionGate = body.indexOf("AgeeCaptureOnlyPolicy.allowsActionExtraction(session)", actionBoundary);
  const dispatch = body.indexOf("browserMedia.execute", actionBoundary);
  assert.ok(gate > 0 && gate < binary);
  assert.ok(parsedGate > binary && parsedGate < stateMutation);
  assert.ok(parsedGate < presentation && parsedGate < actionBoundary);
  assert.ok(actionBoundary < actionGate && actionGate < dispatch);
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
  driveBoundary({}, JSON.stringify({ type: "media.open", media: { video_id: "dQw4w9WgXcQ" } }), askEffects);
  assert.deepEqual(askEffects, { mutated: 1, presented: 1, dispatched: 1 });
});

test("capture-only action aliases never reach the real extractor or executor, while Ask still does", async () => {
  const aliases = [
    ["action", { type: "media.open", media: { video_id: "dQw4w9WgXcQ" } }],
    ["actions", [{ type: "media.open", media: { video_id: "dQw4w9WgXcQ" } }]],
    ["proposals", [{ type: "media.open", media: { video_id: "dQw4w9WgXcQ" } }]],
    ["action_proposals", [{ type: "media.open", media: { video_id: "dQw4w9WgXcQ" } }]],
  ];
  for (const terminalType of ["turn_done", "transcript_finalized"]) {
    for (const [field, value] of aliases) {
      for (const nested of [false, true]) {
        const fx = mediaFixture();
        let extracted = 0;
        let executed = 0;
        const raw = { type: terminalType, status: "completed", ...(nested ? { result: { [field]: value } } : { [field]: value }) };
        const event = policy.filterGatewayEvent({ transcriptionOnly: true }, raw);
        const result = await executeFirstMediaActionFromTurn(event, {
          allowed: policy.allowsActionExtraction({ transcriptionOnly: true }),
          extract(data) { extracted += 1; return mediaActionsFromTurn(data); },
          execute(action) { executed += 1; return fx.runtime.execute(action, { tabId: 7, sourceText: "open this YouTube video" }); },
        });
        assert.equal(result, null, `${terminalType}:${nested ? "result." : ""}${field}`);
        assert.equal(extracted, 0, `${terminalType}:${nested ? "result." : ""}${field}:extractor`);
        assert.equal(executed, 0, `${terminalType}:${nested ? "result." : ""}${field}:executor`);
        assert.equal(fx.updates.length, 0, `${terminalType}:${nested ? "result." : ""}${field}:effect`);
      }
    }
  }

  const fx = mediaFixture();
  let extracted = 0;
  let executed = 0;
  const askEvent = { type: "media.open", media: { video_id: "dQw4w9WgXcQ" } };
  const result = await executeFirstMediaActionFromTurn(policy.filterGatewayEvent({}, askEvent), {
    allowed: policy.allowsActionExtraction({}),
    extract(data) { extracted += 1; return mediaActionsFromTurn(data); },
    execute(action) { executed += 1; return fx.runtime.execute(action, { tabId: 7, sourceText: "open this YouTube video" }); },
  });
  assert.equal(result?.receipt?.ok, true);
  assert.equal(extracted, 1);
  assert.equal(executed, 1);
  assert.equal(fx.updates.length, 1);
});
