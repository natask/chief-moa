import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import vm from "node:vm";

const root = resolve(new URL("..", import.meta.url).pathname);
const source = readFileSync(join(root, "extension", "transcript-revision-protocol.js"), "utf8");
const context = { globalThis: {} };
vm.createContext(context);
vm.runInContext(source, context, { filename: "transcript-revision-protocol.js" });
const protocol = context.globalThis.AgeeTranscriptRevisionProtocol;
const assert = (condition, label) => { if (!condition) throw new Error(label); };
const authority = { session_id: "session-1", branch_id: "branch-1", turn_id: "turn-1" };
const state = protocol.createState(authority);

assert(JSON.stringify(protocol.reconciliationOptIn({ retainedAudio: true })) ===
  JSON.stringify({ enabled: true, version: 1, privacy_scope: "retained" }),
"ordinary retained audio explicitly opts in");
assert(protocol.reconciliationOptIn({ retainedAudio: true, contextAction: "incognito" }) === null,
  "incognito audio never opts in");
assert(protocol.reconciliationOptIn({ retainedAudio: false }) === null,
  "a session without retained audio never opts in");

assert(protocol.acceptReady(state, {
  type: "session_ready", ...authority,
  capabilities: { transcript_revisions_v1: { supported: true, version: 1 } },
}), "versioned capability accepted for exact authority");

const partial = (sequence, text) => ({ type: "transcript_partial", ...authority,
  speaker: "user", transcript_sequence: sequence, text });
assert(protocol.acceptStreamingSnapshot(state, partial(1, "I want the old words and a live tail"))?.accepted,
  "initial partial accepted");
const prefix = (revision, sequence, finalizedText, unsealedText, sealedByte = 32000) => ({
  type: "transcript_prefix_revision", ...authority, speaker: "user", revision,
  message_id: "turn:session-1:branch-1:turn-1:user",
  transcript_sequence: sequence, finalized_text: finalizedText, unsealed_text: unsealedText,
  text: [finalizedText, unsealedText].filter(Boolean).join(" "),
  sealed_through_audio_byte: sealedByte,
  audio_format: { encoding: "pcm16", sample_rate: 16000, channels: 1 },
  source: "automatic_reconcile",
});
const corrected = protocol.acceptPrefixRevision(state, prefix(1, 2, "I want the corrected words", "and a live tail"));
assert(corrected?.text === "I want the corrected words and a live tail", "sealed prefix replaced while exact live tail survived");
assert(protocol.acceptStreamingSnapshot(state, partial(4, "I want the corrected words and a newer live tail"))?.accepted,
  "newer rolling whole snapshot accepted");
assert(protocol.acceptPrefixRevision(state, prefix(2, 3, "stale correction", "old tail", 64000)) === null,
  "out-of-order prefix cannot rewind newer live tail");
assert(protocol.acceptPrefixRevision(state, prefix(1, 5, "duplicate revision", "new tail", 64000)) === null,
  "duplicate batch revision rejected despite newer sequence");
assert(protocol.acceptPrefixRevision(state, prefix(2, 5, "corrected again", "latest live tail", 16000)) === null,
  "sealed audio boundary cannot move backward");
assert(protocol.acceptPrefixRevision(state, { ...prefix(2, 5, "corrected again", "latest live tail", 64000), branch_id: "other" }) === null,
  "wrong branch rejected");
assert(protocol.acceptPrefixRevision(state, { ...prefix(2, 5, "corrected again", "latest live tail", 64000), message_id: "turn:session-1:branch-1:other:user" }) === null,
  "wrong message identity rejected");
assert(protocol.acceptStreamingSnapshot(state, { ...partial(5, "assistant overwrite"), speaker: "assistant" }) === null,
  "assistant text cannot enter the user transcript state");
assert(protocol.acceptStreamingSnapshot(state, { ...partial(5, "sealed boundary snapshot"), type: "transcript_final" })?.accepted,
  "a natural streaming-final boundary advances the snapshot");
assert(protocol.acceptStreamingSnapshot(state, partial(6, "sealed boundary snapshot with the next live tail"))?.accepted,
  "a newer partial after a natural final preserves ongoing capture");

const ledger = new Map();
const historyMessage = (revision, text) => ({ id: "turn:session-1:branch-1:turn-1:user", sessionId: "session-1",
  branchId: "branch-1", turnId: "turn-1", speaker: "user", completion: "completed", text,
  voiceHistory: { currentRevision: revision } });
const current = protocol.guardHistory([historyMessage(2, "corrected durable text")], ledger)[0];
assert(protocol.guardHistory([historyMessage(1, "stale durable text")], ledger)[0] === current,
  "stale history response cannot overwrite a newer corrected message or its Copy source");
assert(protocol.guardHistory([historyMessage(2, "mutated same revision")], ledger)[0] === current,
  "same revision is idempotent and immutable");
assert(protocol.guardHistory([historyMessage(3, "newest corrected text")], ledger)[0].text === "newest corrected text",
  "strictly newer durable revision accepted");

const legacy = protocol.createState(authority);
assert(protocol.acceptStreamingSnapshot(legacy, { type: "transcript_partial", text: "legacy text" })?.legacy,
  "older gateway keeps legacy whole-snapshot behavior");
assert(protocol.acceptStreamingSnapshot(protocol.createState(), { type: "transcript_partial", text: "legacy mock" })?.legacy,
  "legacy clients tolerate an older session response without explicit authority fields");
console.log("transcript revision protocol ok");
