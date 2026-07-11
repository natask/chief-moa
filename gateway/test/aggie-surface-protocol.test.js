"use strict";

const assert = require("node:assert/strict");
const { describe, test } = require("node:test");
const {
  MAX_PENDING_EVENTS, MAX_REPLAY_EVENTS, negotiateVersion, validateEnvelope,
  canExecuteProposal, createSessionReplay, reconnectDelay, createEchoAdapter,
  createPendingBuffer, proposalDigest,
} = require("../lib/aggie-surface-protocol");

const NOW = "2026-07-10T12:00:00.000Z";
function envelope(overrides = {}) {
  return {
    version: 2, type: "turn.text", message_id: "msg_1", session_id: "sess_1",
    surface: { id: "moa-browser", kind: "browser", mode: "text", device_id: "dev_1" },
    timestamp: NOW, payload: { text: "hello" }, ...overrides,
  };
}
function proposal(overrides = {}) {
  return envelope({
    type: "action.proposed", message_id: "proposal_message_1",
    payload: { proposal_id: "proposal_1", kind: "open_url", approval_class: "confirm", expires_at: "2026-07-10T12:01:00.000Z", preconditions: { active_tab: "tab_1" }, params: { url: "https://example.com" }, ...overrides },
  });
}
function approval(overrides = {}) {
  const boundProposal = proposal();
  return envelope({
    type: "action.approved", message_id: "approval_message_1", reply_to: "proposal_message_1",
    payload: { proposal_id: "proposal_1", proposal_message_id: "proposal_message_1", proposal_digest: proposalDigest(validateEnvelope(boundProposal)), decision: "approved", actor_id: "local_user", decided_at: NOW },
    ...overrides,
  });
}

describe("Aggie surface protocol", () => {
  test("negotiates current then N-1 and fails closed without overlap", () => {
    assert.equal(negotiateVersion({ supported_versions: [1, 2, 99] }), 2);
    assert.equal(negotiateVersion({ supported_versions: [1] }), 1);
    assert.throws(() => negotiateVersion({ supported_versions: [0, 99] }), { code: "unsupported_version" });
  });

  test("canonicalizes and deeply freezes an N/N-1 text turn while ignoring additive fields", () => {
    for (const version of [1, 2]) {
      const result = validateEnvelope(envelope({ version, future_optional: "ignored", payload: { text: "hello", future_optional: true } }));
      assert.equal(result.version, version);
      assert.equal(result.payload.text, "hello");
      assert.equal(result.future_optional, undefined);
      assert(Object.isFrozen(result)); assert(Object.isFrozen(result.surface));
    }
  });

  test("hello and resume are typed at N/N-1 and reject malformed semantics", () => {
    for (const version of [1, 2]) {
      const hello = validateEnvelope(envelope({ version, type: "hello", payload: { supported_versions: [2, 1], capabilities: ["text", "events"], future: true } }));
      assert.deepEqual(hello.payload, { supported_versions: [2, 1], capabilities: ["text", "events"] });
      const resume = validateEnvelope(envelope({ version, type: "resume", payload: { after_sequence: 0, last_message_id: "msg_previous" } }));
      assert.equal(resume.payload.after_sequence, 0);
    }
    assert.throws(() => validateEnvelope(envelope({ type: "hello", payload: { supported_versions: "2", capabilities: [] } })), { code: "invalid_versions" });
    assert.throws(() => validateEnvelope(envelope({ type: "resume", payload: { after_sequence: { bad: true } } })), { code: "invalid_integer" });
    assert.throws(() => validateEnvelope(envelope({ type: "run.completed", payload: { run_id: "run_1", status: "running" } })), { code: "run_status_mismatch" });
  });

  test("every declared non-action event has typed semantics at N/N-1", () => {
    const cases = [
      ["hello.accepted", { selected_version: 2, heartbeat_ms: 5000, max_envelope_bytes: 65536 }],
      ["turn.voice.started", { turn_id: "turn_voice_1", encoding: "pcm_s16le", sample_rate_hz: 16000, channels: 1 }],
      ["turn.voice.completed", { turn_id: "turn_voice_1", outcome: "completed", transcript: "done" }],
      ["route.selected", { turn_id: "turn_1", backend: "echo", workflow: "default" }],
      ["run.queued", { run_id: "run_1", turn_id: "turn_1", status: "queued" }],
      ["run.running", { run_id: "run_1", turn_id: "turn_1", status: "running" }],
      ["run.needs_approval", { run_id: "run_1", turn_id: "turn_1", status: "needs_approval" }],
      ["run.completed", { run_id: "run_1", turn_id: "turn_1", status: "completed" }],
      ["run.failed", { run_id: "run_1", turn_id: "turn_1", status: "failed" }],
      ["message.created", { role: "assistant", text: "hello" }],
      ["session.snapshot_required", { first_available_sequence: 4, reason: "cursor_evicted" }],
    ];
    for (const version of [1, 2]) for (const [type, payload] of cases) {
      assert.doesNotThrow(() => validateEnvelope(envelope({ version, type, payload })));
    }
    assert.throws(() => validateEnvelope(envelope({ type: "hello.accepted", payload: {} })), { code: "unsupported_version" });
    assert.throws(() => validateEnvelope(envelope({ type: "turn.voice.started", payload: { turn_id: "turn_1", encoding: "mp3", sample_rate_hz: 16000, channels: 1 } })), { code: "invalid_enum" });
    assert.throws(() => validateEnvelope(envelope({ type: "route.selected", payload: { backend: "echo", workflow: "default" } })), { code: "invalid_id" });
    assert.throws(() => validateEnvelope(envelope({ type: "message.created", payload: { role: "user", text: "wrong authority" } })), { code: "invalid_enum" });
    assert.throws(() => validateEnvelope(envelope({ type: "session.snapshot_required", payload: { first_available_sequence: 0, reason: "cursor_evicted" } })), { code: "invalid_integer" });
  });

  test("rejects oversized, malformed, deeply nested and executable data", () => {
    assert.throws(() => validateEnvelope(envelope({ payload: { text: "x".repeat(17 * 1024) } })), { code: "invalid_string" });
    assert.throws(() => validateEnvelope(envelope({ message_id: "bad id" })), { code: "invalid_id" });
    assert.throws(() => validateEnvelope(envelope({ payload: { text: "ok", context: { shell: "rm -rf /" } } })), { code: "executable_payload" });
    assert.throws(() => validateEnvelope(envelope({ payload: { text: "ok", context: { nested: { api_key: "secret" } } } })), { code: "secret_payload" });
    let nested = "end"; for (let i = 0; i < 10; i += 1) nested = { next: nested };
    assert.throws(() => validateEnvelope(envelope({ payload: { text: "ok", context: nested } })), { code: "too_deep" });
  });

  test("proposal eligibility fails closed on expiry, scope, state and approval", () => {
    const context = { now: NOW, session_id: "sess_1", surface_id: "moa-browser", state: { active_tab: "tab_1" } };
    assert.deepEqual(canExecuteProposal(proposal(), context), { allowed: false, reason: "approval_required" });
    assert.deepEqual(canExecuteProposal(proposal(), { ...context, approval: approval() }), { allowed: true, reason: "eligible" });
    assert.deepEqual(canExecuteProposal(proposal(), { ...context, now: "2026-07-10T12:02:00.000Z" }), { allowed: false, reason: "expired" });
    assert.deepEqual(canExecuteProposal(proposal(), { ...context, session_id: "sess_other" }), { allowed: false, reason: "session_mismatch" });
    assert.deepEqual(canExecuteProposal(proposal(), { ...context, state: { active_tab: "tab_2" } }), { allowed: false, reason: "stale_state" });
    assert.deepEqual(canExecuteProposal(proposal({ javascript: "alert(1)" }), context), { allowed: false, reason: "executable_payload" });
    assert.deepEqual(canExecuteProposal(proposal(), { ...context, approval: approval({ session_id: "sess_other" }) }), { allowed: false, reason: "approval_session_mismatch" });
    assert.deepEqual(canExecuteProposal(proposal(), { ...context, approval: approval({ surface: { id: "other", kind: "browser", mode: "text" } }) }), { allowed: false, reason: "approval_surface_mismatch" });
    const approvalPayload = approval().payload;
    assert.deepEqual(canExecuteProposal(proposal(), { ...context, approval: approval({ timestamp: "2026-07-10T11:59:00.000Z", payload: { ...approvalPayload, decided_at: "2026-07-10T11:59:00.000Z" } }) }), { allowed: false, reason: "approval_time_invalid" });
    assert.deepEqual(canExecuteProposal(proposal(), { ...context, approval: { proposal_id: "proposal_1", decision: "approved" } }), { allowed: false, reason: "approval_required" });
  });

  test("approval binds the complete canonical proposal and cannot be replayed after mutation", () => {
    const context = { now: NOW, session_id: "sess_1", surface_id: "moa-browser", state: { active_tab: "tab_1" } };
    const approved = approval();
    assert.equal(canExecuteProposal(proposal(), { ...context, approval: approved }).allowed, true);
    assert.equal(canExecuteProposal(proposal({ params: { url: "https://attacker.example" } }), { ...context, approval: approved }).reason, "approval_proposal_digest_mismatch");
    assert.equal(canExecuteProposal(proposal({ kind: "dial" }), { ...context, approval: approved }).reason, "approval_proposal_digest_mismatch");
    assert.equal(canExecuteProposal(proposal({ expires_at: "2026-07-10T12:00:30.000Z" }), { ...context, approval: approved }).reason, "approval_proposal_digest_mismatch");
    assert.equal(canExecuteProposal(proposal({ preconditions: { active_tab: "tab_1", account: "other" } }), { ...context, state: { active_tab: "tab_1", account: "other" }, approval: approved }).reason, "approval_proposal_digest_mismatch");
    assert.equal(canExecuteProposal(proposal(), { ...context, approval: approval({ reply_to: "other_message" }) }).reason, "approval_proposal_mismatch");
  });

  test("approval and receipt envelopes require explicit proposal/message linkage", () => {
    assert.throws(() => validateEnvelope(approval({ payload: { proposal_id: "proposal_1", decision: "approved", actor_id: "local_user", decided_at: NOW } })), { code: "invalid_id" });
    const receipt = validateEnvelope(envelope({ type: "action.receipted", reply_to: "proposal_message_1", payload: { receipt_id: "receipt_1", proposal_id: "proposal_1", proposal_message_id: "proposal_message_1", approval_message_id: "approval_message_1", outcome: "executed", observed_at: NOW, state_hash: "a".repeat(64) } }));
    assert.equal(receipt.payload.proposal_message_id, receipt.reply_to);
    assert.equal(receipt.payload.approval_message_id, "approval_message_1");
  });

  test("replay dedupes exact events, rejects conflicts and cross-session events", () => {
    const replay = createSessionReplay({ session_id: "sess_1" });
    const first = envelope({ type: "message.created", sequence: 1, payload: { role: "assistant", text: "one" } });
    assert.equal(replay.accept(first).accepted, true);
    assert.equal(replay.accept(first).duplicate, true);
    assert.throws(() => replay.accept(envelope({ type: "message.created", sequence: 1, message_id: "msg_2", payload: { role: "assistant", text: "two" } })), { code: "sequence_conflict" });
    assert.throws(() => replay.accept(envelope({ type: "message.created", sequence: 2, message_id: "msg_1", payload: { role: "assistant", text: "two" } })), { code: "message_conflict" });
    assert.throws(() => replay.accept(envelope({ type: "message.created", sequence: 3, message_id: "msg_3", payload: { role: "assistant", text: "three" } })), { code: "sequence_gap" });
    assert.throws(() => replay.accept(envelope({ type: "message.created", sequence: 2, session_id: "sess_other", payload: { role: "assistant", text: "two" } })), { code: "session_mismatch" });
  });

  test("replay is bounded and demands a snapshot for an evicted cursor", () => {
    const replay = createSessionReplay({ session_id: "sess_1" });
    for (let i = 1; i <= MAX_REPLAY_EVENTS + 4; i += 1) replay.accept(envelope({ type: "message.created", sequence: i, message_id: `msg_${i}`, payload: { role: "assistant", text: `message ${i}` } }));
    assert.equal(replay.stats().event_count, MAX_REPLAY_EVENTS);
    assert.equal(replay.replayAfter(1).snapshot_required, true);
    assert.equal(replay.replayAfter(MAX_REPLAY_EVENTS).events.length, 4);
  });

  test("pending buffer and reconnect delays obey hard bounds", () => {
    const pending = createPendingBuffer();
    for (let i = 0; i < MAX_PENDING_EVENTS; i += 1) assert.equal(pending.push(envelope({ message_id: `msg_${i}` })).accepted, true);
    assert.deepEqual(pending.push(envelope({ message_id: "msg_overflow" })), { accepted: false, reason: "buffer_full" });
    assert.equal(reconnectDelay(0, 1), 250);
    assert.equal(reconnectDelay(99, 1), 30000);
    assert.equal(reconnectDelay(4, 0), 0);
  });

  test("echo backend is deterministic, terminal and isolated by run identifier", async () => {
    const echo = createEchoAdapter({ now: () => NOW });
    const turn = envelope();
    assert.deepEqual(await echo.sendTurn(turn), { assistant_text: "hello", session_id: "sess_1", reply_to: "msg_1", backend: "echo" });
    const first = await echo.startRun(turn); const second = await echo.startRun(turn);
    assert.deepEqual(first, second);
    assert.equal((await echo.listArtifacts(first.run_id))[0].text, "hello");
    assert.equal((await echo.cancelRun(first.run_id)).cancel_result, "already_terminal");
    assert.equal(await echo.resumeRun("run_missing"), null);
  });
});
