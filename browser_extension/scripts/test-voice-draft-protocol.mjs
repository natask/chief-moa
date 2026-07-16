const previousProtocol = globalThis.AgeeVoiceDraftProtocol;
delete globalThis.AgeeVoiceDraftProtocol;
await import(`../extension/voice-draft-protocol.js?test=${Date.now()}`);
const protocol = globalThis.AgeeVoiceDraftProtocol;
if (!protocol) throw new Error("voice-draft-protocol.js did not install AgeeVoiceDraftProtocol");

function assert(condition, label) {
  if (!condition) throw new Error(label);
}

const authority = {
  sessionId: "session-1",
  branchId: "branch-1",
  turnId: "turn-1",
};
const createReady = {
  type: "voice_draft_ready",
  action: "create",
  session_id: authority.sessionId,
  branch_id: authority.branchId,
  turn_id: authority.turnId,
  draft: {
    id: "draft-1",
    revision: 1,
    session_id: authority.sessionId,
    branch_id: authority.branchId,
    state: "capturing",
  },
};
const createExpected = { action: "create", draftId: "", requestedRevision: 0, ...authority };

assert(protocol.validateReady(createReady, createExpected).ok === true, "canonical create ready must bind");
assert(protocol.validateReady(createReady, { ...createExpected, draftId: " bad" }).ok === false, "malformed expected create authority must not become absence");
assert(protocol.validateReady(createReady, { ...createExpected, draftId: "draft-1" }).ok === false, "create cannot replace supplied draft authority");
assert(protocol.validateReady(createReady, { ...createExpected, requestedRevision: 1 }).ok === false, "create cannot replace supplied revision authority");

const hostileAuthority = [42, true, " draft-1", "draft-1 ", "../draft", "draft/one", "draft\n1", "x".repeat(121)];
for (const candidate of hostileAuthority) {
  const event = structuredClone(createReady);
  event.draft.id = candidate;
  assert(protocol.validateReady(event, createExpected).ok === false, `hostile nested authority ${JSON.stringify(candidate)} must fail`);
}
for (const [field, expectedField] of [["session_id", "sessionId"], ["branch_id", "branchId"], ["turn_id", "turnId"]]) {
  for (const candidate of hostileAuthority) {
    const event = structuredClone(createReady);
    event[field] = candidate;
    const expected = { ...createExpected, [expectedField]: candidate };
    assert(protocol.validateReady(event, expected).ok === false, `hostile ${field} authority must fail even when expected matches after coercion`);
  }
}

for (const [label, mutate] of [
  ["missing top-level session", (event) => { delete event.session_id; }],
  ["wrong top-level session", (event) => { event.session_id = "other"; }],
  ["wrong top-level branch", (event) => { event.branch_id = "other"; }],
  ["wrong top-level turn", (event) => { event.turn_id = "other"; }],
  ["nested session mismatch", (event) => { event.draft.session_id = "other"; }],
  ["nested branch mismatch", (event) => { event.draft.branch_id = "other"; }],
  ["non-capturing state", (event) => { event.draft.state = "paused"; }],
  ["numeric-string revision", (event) => { event.draft.revision = "1"; }],
  ["fractional revision", (event) => { event.draft.revision = 1.5; }],
  ["ready alias", (event) => { event.type = "session_ready"; }],
  ["action alias", (event) => { event.action = "start"; }],
]) {
  const event = structuredClone(createReady);
  mutate(event);
  assert(protocol.validateReady(event, createExpected).ok === false, `${label} must not bind ready authority`);
}

const resumeReady = structuredClone(createReady);
resumeReady.action = "resume";
resumeReady.draft.revision = 8;
const resumeExpected = { action: "resume", draftId: "draft-1", requestedRevision: 7, ...authority };
assert(protocol.validateReady(resumeReady, resumeExpected).ok === true, "strictly newer resume ready must bind");
assert(protocol.validateReady(resumeReady, { ...resumeExpected, draftId: "other" }).ok === false, "resume cannot switch drafts");
for (const revision of [7, 6, "8"]) {
  const event = structuredClone(resumeReady);
  event.draft.revision = revision;
  assert(protocol.validateReady(event, resumeExpected).ok === false, `resume revision ${revision} must not bind`);
}

const ackExpected = {
  action: "pause",
  draftId: "draft-1",
  baseRevision: 8,
  state: "paused",
  ...authority,
};
const ack = {
  type: "voice_draft_control_ack",
  action: "pause",
  session_id: authority.sessionId,
  branch_id: authority.branchId,
  turn_id: authority.turnId,
  draft: {
    id: "draft-1",
    revision: 9,
    session_id: authority.sessionId,
    branch_id: authority.branchId,
    state: "paused",
  },
};
assert(protocol.validateControlAck(ack, ackExpected)?.revision === 9, "canonical ACK must advance authority");
for (const invalidBase of [0, -1, "8", 8.5, Number.MAX_SAFE_INTEGER + 1]) {
  assert(protocol.validateControlAck(ack, { ...ackExpected, baseRevision: invalidBase }) === null, `invalid ACK base ${invalidBase} must fail closed`);
}
for (const [label, mutate] of [
  ["ACK missing top-level session", (event) => { delete event.session_id; }],
  ["ACK wrong branch", (event) => { event.branch_id = "other"; }],
  ["ACK wrong turn", (event) => { event.turn_id = "other"; }],
  ["ACK stale revision", (event) => { event.draft.revision = 8; }],
  ["ACK string revision", (event) => { event.draft.revision = "9"; }],
  ["ACK fractional revision", (event) => { event.draft.revision = 9.5; }],
  ["ACK wrong state", (event) => { event.draft.state = "parked"; }],
  ["ACK nested authority mismatch", (event) => { event.draft.session_id = "other"; }],
]) {
  const event = structuredClone(ack);
  mutate(event);
  assert(protocol.validateControlAck(event, ackExpected) === null, `${label} must not acknowledge a control`);
}

const terminalExpected = { draftId: "draft-1", baseRevision: 9, ...authority };
const terminal = {
  type: "turn_done",
  session_id: authority.sessionId,
  branch_id: authority.branchId,
  turn_id: authority.turnId,
  draft: {
    id: "draft-1",
    revision: 10,
    session_id: authority.sessionId,
    branch_id: authority.branchId,
    state: "sent",
  },
};
assert(protocol.validateTerminalReceipt(terminal, terminalExpected)?.state === "sent", "sent receipt must clear authority");
for (const invalidBase of [0, -1, "9", 9.5, Number.MAX_SAFE_INTEGER + 1]) {
  assert(protocol.validateTerminalReceipt(terminal, { ...terminalExpected, baseRevision: invalidBase }) === null, `invalid terminal base ${invalidBase} must fail closed`);
}
const discardedTerminal = structuredClone(terminal);
discardedTerminal.draft.state = "discarded";
assert(protocol.validateTerminalReceipt(discardedTerminal, terminalExpected)?.state === "discarded", "discarded receipt must clear authority");
for (const [label, mutate] of [
  ["terminal missing turn", (event) => { delete event.turn_id; }],
  ["terminal wrong session", (event) => { event.session_id = "other"; }],
  ["terminal stale revision", (event) => { event.draft.revision = 9; }],
  ["terminal string revision", (event) => { event.draft.revision = "10"; }],
  ["terminal fractional revision", (event) => { event.draft.revision = 10.5; }],
  ["terminal consumed state", (event) => { event.draft.state = "consumed"; }],
  ["terminal nonterminal state", (event) => { event.draft.state = "capturing"; }],
]) {
  const event = structuredClone(terminal);
  mutate(event);
  assert(protocol.validateTerminalReceipt(event, terminalExpected) === null, `${label} must retain draft authority`);
}

assert(protocol.positiveRevision(7) === 7, "integer revision accepted");
assert(protocol.positiveRevision("7") === 0, "numeric-string revision rejected");
assert(protocol.positiveRevision(7.5) === 0, "fractional revision rejected");
assert(protocol.normalizeStoredPointer({ draftId: "d", revision: "7", sessionId: "s", branchId: "b" }) === null, "stored string revision rejected");
const canonicalStored = { draftId: "draft-1", revision: 7, sessionId: "session-1", branchId: "branch-1" };
assert(protocol.normalizeStoredPointer(canonicalStored)?.draftId === "draft-1", "canonical stored pointer accepted");
assert(protocol.validateResumePointer(canonicalStored)?.pointer?.draftId === "draft-1", "complete strict resume pointer accepted");
assert(protocol.validateResumePointer({ draftId: "draft-1", revision: 7, sessionId: " session-1 ", branchId: "branch-1" }).ok === false, "lossy resume authority rejected");
assert(protocol.validateResumePointer({ draftId: "", revision: 0, sessionId: "", branchId: "" }).pointer === null, "empty create pointer remains absent");
for (const field of ["draftId", "sessionId", "branchId"]) {
  const zeroAuthority = { draftId: "", revision: 0, sessionId: "", branchId: "", [field]: 0 };
  assert(protocol.validateResumePointer(zeroAuthority).ok === false, `numeric-zero ${field} authority is malformed, not absent`);
}
assert(protocol.normalizeStoredPointer({ ...canonicalStored, id: "draft-2" }) === null, "conflicting draft aliases rejected");
assert(protocol.normalizeStoredPointer({ ...canonicalStored, draft_revision: 8 }) === null, "conflicting revision aliases rejected");
assert(protocol.normalizeStoredPointer({ ...canonicalStored, session_id: "session-2" }) === null, "conflicting session aliases rejected");
assert(protocol.normalizeStoredPointer({ ...canonicalStored, branch_id: "branch-2" }) === null, "conflicting branch aliases rejected");
for (const candidate of hostileAuthority) {
  assert(protocol.normalizeStoredPointer({ ...canonicalStored, draftId: candidate }) === null, "hostile stored draft authority rejected");
  assert(protocol.normalizeStoredPointer({ ...canonicalStored, sessionId: candidate }) === null, "hostile stored session authority rejected");
  assert(protocol.normalizeStoredPointer({ ...canonicalStored, branchId: candidate }) === null, "hostile stored branch authority rejected");
}
assert(protocol.validateReady({ ...createReady, action: " create" }, createExpected).ok === false, "ready action whitespace is not normalized");
const uppercaseState = structuredClone(createReady);
uppercaseState.draft.state = "CAPTURING";
assert(protocol.validateReady(uppercaseState, createExpected).ok === false, "ready state case is exact");
assert(protocol.validateStartAuthority({ session_id: "session-1", branch_id: "branch-1", turn_id: "turn-1" }, authority)?.turnId === "turn-1", "exact start authority accepted");
assert(protocol.validateStartAuthority({ session_id: " session-1 ", branch_id: "branch-1", turn_id: "turn-1" }, authority) === null, "start authority whitespace rejected");
assert(protocol.validateStartAuthority({ session_id: "session-1", branch_id: "branch-1", turn_id: 0 }, { ...authority, turnId: 0 }) === null, "numeric-zero turn authority is malformed, not absent");
assert(protocol.commitControlRequest({ voiceSessionId: null, turnId: "turn-1" })?.voiceSessionId === null, "pre-ID SEND remains routable by exact turn");
assert(protocol.commitControlRequest({ voiceSessionId: "voice-1", turnId: 0 }) === null, "numeric-zero control turn authority is rejected");
assert(protocol.commitControlRequest({ voiceSessionId: " voice-1 ", turnId: "turn-1" }) === null, "commit session authority is not repaired");
const lateDraft = protocol.lateStartDisposition({ active: false, draftMode: true, voiceSessionId: "voice-1", turnId: "turn-1" });
assert(lateDraft?.primary?.message?.type === "discard_turn", "late cancelled draft is discarded instead of attached");
assert(lateDraft?.fallback?.cmd === "voiceSessionClose", "late draft has a close fallback");
const lateOrdinary = protocol.lateStartDisposition({ active: false, draftMode: false, voiceSessionId: "voice-1", turnId: "turn-1" });
assert(lateOrdinary?.primary?.cmd === "voiceSessionClose" && lateOrdinary.fallback === null, "late ordinary start closes directly");
assert(protocol.lateStartDisposition({ active: false, draftMode: false, voiceSessionId: "", turnId: "turn-1" }) === null, "late start needs exact session authority");
assert(protocol.lateStartDisposition({ active: true, draftMode: true, voiceSessionId: "voice-1", turnId: "turn-1" }) === null, "active start may attach");
assert(protocol.acceptedCapabilityResponse(1, 2, { supported: true, gateway_url: "https://old.example", expires_at_ms: 10 }) === null, "old endpoint generation cannot enable a replacement");
assert(protocol.acceptedCapabilityResponse(2, 2, { supported: true, gateway_url: "https://new.example", expires_at_ms: 10 })?.gatewayUrl === "https://new.example", "current endpoint capability is bound to its URL");
assert(protocol.normalizeContextAction("") === "continue", "empty context action becomes continue");
for (const action of ["continue", "new", "fork", "incognito"]) {
  assert(protocol.normalizeContextAction(action) === action, `${action} context action accepted`);
}
for (const action of ["create", "resume", "delete"]) {
  assert(protocol.normalizeContextAction(action) === "", `${action} context action rejected`);
}
for (const action of [" continue", "NEW", 1, true]) {
  assert(protocol.normalizeContextAction(action) === "", `${JSON.stringify(action)} context action rejected without coercion`);
}
assert(protocol.capabilityFresh({ supported: true, stale: false, expiresAtMs: 1001 }, 1000) === true, "unexpired capability accepted");
assert(protocol.capabilityFresh({ supported: true, stale: false, expiresAtMs: 1000 }, 1000) === false, "expiry boundary fails closed");
assert(protocol.capabilityFresh({ supported: true, stale: true, expiresAtMs: 1001 }, 1000) === false, "stale capability rejected");
assert(protocol.capabilityFresh({ supported: true, stale: false, expiresAtMs: "1001" }, 1000) === false, "string expiry rejected");

if (previousProtocol === undefined) delete globalThis.AgeeVoiceDraftProtocol;
else globalThis.AgeeVoiceDraftProtocol = previousProtocol;

console.log("voice-draft-protocol ok");
