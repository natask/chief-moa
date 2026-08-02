"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createVoiceTranscriptReconcileBridge, publishTranscriptRevision }
  = require("../lib/voice-transcript-reconcile-session");

test("publishes an authoritative corrected prefix plus current unsealed tail", async () => {
  const events = [];
  const connection = { ws: { readyState: 1 }, sendEvent: async (event) => events.push(event) };
  const bridge = createVoiceTranscriptReconcileBridge(connection, null, 1);
  const turn = {
    sessionId: "s", branchId: "b", turnId: "t", transcriptSequence: 4,
    format: { encoding: "pcm16", sample_rate: 16000, channels: 1 },
    sttStream: { snapshot: () => ({
      finalSegments: [
        { transcript: "old prefix", endAudioByteOffset: 320 },
        { transcript: "new tail", endAudioByteOffset: 640 },
      ],
      interim: "still speaking",
    }) },
  };
  await bridge.emitPrefix(turn, { revision: 2, finalizedText: "correct prefix", sealedThroughAudioByte: 320 });
  assert.deepEqual(events[0], {
    type: "transcript_prefix_revision", session_id: "s", branch_id: "b", turn_id: "t",
    message_id: "turn:s:b:t:user", speaker: "user", transcript_sequence: 5, revision: 2,
    finalized_text: "correct prefix", unsealed_text: "new tail still speaking",
    text: "correct prefix new tail still speaking", sealed_through_audio_byte: 320,
    audio_format: turn.format, source: "automatic_reconcile", updated_at: events[0].updated_at,
  });
});

test("final revision broadcast stays on the exact session and branch", async () => {
  const delivered = [];
  const connections = [
    { sessionIdentity: { sessionId: "s", branchId: "b" }, sendEvent: async () => delivered.push("exact") },
    { sessionIdentity: { sessionId: "s", branchId: "other" }, sendEvent: async () => delivered.push("wrong") },
  ];
  publishTranscriptRevision(connections, { session_id: "s", branch_id: "b" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(delivered, ["exact"]);
});
