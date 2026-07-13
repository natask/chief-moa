"use strict";

const assert = require("node:assert/strict");
const { createEchoAdapter, createSessionReplay, validateEnvelope } = require("../lib/aggie-surface-protocol");

const now = "2026-07-10T12:00:00.000Z";
const turn = validateEnvelope({
  version: 2, type: "turn.text", message_id: "smoke_turn_1", session_id: "smoke_session_1",
  surface: { id: "m5-echo", kind: "test", mode: "text" }, timestamp: now,
  payload: { text: "Aggie echo smoke" },
});

(async () => {
  const adapter = createEchoAdapter({ now: () => now });
  const reply = await adapter.sendTurn(turn);
  const run = await adapter.startRun(turn);
  const replay = createSessionReplay({ session_id: turn.session_id });
  replay.accept({ ...turn, type: "run.completed", message_id: "smoke_event_1", sequence: 1, payload: { run_id: run.run_id, status: "completed" } });
  replay.accept({ ...turn, type: "artifact.created", message_id: "smoke_event_2", sequence: 2, payload: run.artifacts[0] });
  const events = replay.replayAfter(0).events;
  assert.equal(reply.assistant_text, "Aggie echo smoke");
  assert.equal(run.status, "completed");
  assert.deepEqual(events.map((event) => event.type), ["run.completed", "artifact.created"]);
  console.log(JSON.stringify({ ok: true, backend: "echo", protocol_version: turn.version, event_count: events.length, artifact_count: run.artifacts.length }));
})().catch((error) => { console.error(error); process.exitCode = 1; });
