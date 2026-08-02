import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import vm from "node:vm";

const root = resolve(new URL("..", import.meta.url).pathname);
const source = readFileSync(join(root, "extension", "voice-draft-protocol.js"), "utf8");
const context = { globalThis: {} };
vm.createContext(context);
vm.runInContext(source, context, { filename: "voice-draft-protocol.js" });
const protocol = context.globalThis.AgeeVoiceDraftProtocol;
const assert = (condition, label) => { if (!condition) throw new Error(label); };

const capability = {
  supported: true,
  revision: "voice_drafts_v1",
  state_machine_revision: "voice_draft_state.v1",
};
const authority = { sessionId: "session-1", branchId: "default", turnId: "turn-1" };
const event = (type, revision, state, action) => ({
  type,
  session_id: authority.sessionId,
  branch_id: authority.branchId,
  turn_id: authority.turnId,
  capabilities: { voice_drafts_v1: capability },
  voice_draft: { draft_id: "draft-1", revision, state, action },
});

assert(protocol.capabilityFromHealth({ voice_stream: { provider: { voice_drafts_v1: capability } } })?.supported, "canonical health capability accepted");
assert(protocol.capabilityFromHealth({ voice_stream: { provider: { voice_drafts_v1: { ...capability, state_machine_revision: "future" } } } }) === null, "incomplete capability rejected");
assert(protocol.capabilityFromHealth({}) === null, "older gateway stays legacy");

const descriptor = protocol.startDescriptor({ ...authority, operation: "create" });
assert(descriptor?.version === "voice_drafts_v1" && descriptor.operation === "create", "create descriptor is canonical");
assert(protocol.startDescriptor({ ...authority, operation: "resume" }) === null, "resume requires exact pointer");

const ready = event("session_ready", 1, "capturing", "session_start");
const pointer = protocol.validateReady(ready, { ...authority, operation: "create" });
assert(pointer?.draftId === "draft-1" && pointer.revision === 1, "session_ready binds exact authority");
for (const [label, mutate] of [
  ["wrong event", (value) => { value.type = "voice_draft_ready"; }],
  ["wrong branch", (value) => { value.branch_id = "other"; }],
  ["string revision", (value) => { value.voice_draft.revision = "1"; }],
  ["wrong action", (value) => { value.voice_draft.action = "create"; }],
  ["wrong capability", (value) => { value.capabilities.voice_drafts_v1.revision = "future"; }],
]) {
  const value = structuredClone(ready); mutate(value);
  assert(protocol.validateReady(value, { ...authority, operation: "create" }) === null, `${label} ready rejected`);
}

const pause = protocol.controlRequest("pause", pointer);
assert(pause?.type === "voice_draft_control" && pause.expected_revision === 1, "pause binds current revision");
assert(protocol.validateClientRequest(pause, pointer), "exact pause request accepted");
assert(!protocol.validateClientRequest({ ...pause, expected_revision: 2 }, pointer), "stale local request rejected");

const pausedEvent = event("voice_draft_state", 2, "paused", "pause");
const paused = protocol.validateState(pausedEvent, { pointer, action: "pause" });
assert(paused?.state === "paused", "pause ACK advances authority");
assert(protocol.validateState(pausedEvent, { pointer: paused, action: "pause" }) === null, "replayed ACK rejected");

const resume = protocol.controlRequest("resume", paused);
assert(protocol.validateClientRequest(resume, paused), "resume request binds paused authority");
const capturing = protocol.validateState(event("voice_draft_state", 3, "capturing", "resume"), { pointer: paused, action: "resume" });
assert(capturing?.state === "capturing", "resume ACK advances authority");

const commit = protocol.commitRequest(capturing);
assert(commit?.type === "commit_turn" && commit.draft_id === "draft-1", "SEND carries exact draft authority");
assert(protocol.validateClientRequest(commit, capturing), "exact SEND accepted");
const sendReady = protocol.validateState(event("voice_draft_state", 4, "send_ready", "send"), { pointer: capturing, action: "send" });
const sent = protocol.validateState(event("voice_draft_state", 5, "sent", "send"), { pointer: sendReady, action: "send" });
assert(sent?.state === "sent", "SEND terminates only as sent");

const discarded = protocol.validateState(event("voice_draft_state", 4, "discarded", "discard"), { pointer: capturing, action: "discard" });
assert(discarded?.state === "discarded", "discard terminates only as discarded");
const consumed = event("voice_draft_state", 4, "consumed", "discard");
assert(protocol.validateState(consumed, { pointer: capturing, action: "discard" }) === null, "consumed alias rejected");

for (const hostile of [" draft", "draft ", "../draft", "draft/one", "x".repeat(121), 1]) {
  assert(protocol.normalizeStoredPointer({ ...pointer, draftId: hostile }) === null, `hostile authority ${JSON.stringify(hostile)} rejected`);
}
assert(protocol.acceptedCapabilityResponse(1, 2, { supported: true }) === null, "stale capability request ignored");
assert(protocol.capabilityFresh({ supported: true, stale: false, expiresAtMs: 101 }, 100), "fresh capability accepted");
assert(!protocol.capabilityFresh({ supported: true, stale: false, expiresAtMs: 100 }, 100), "expired capability rejected");

console.log("voice-draft-protocol ok");
