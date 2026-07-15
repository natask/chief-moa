"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  browserLifecyclePayload,
  browserNeedsEvidenceRecord,
  browserTurnHttpStatus,
  createBrowserTurnLifecycle,
  createBrowserTurnStore,
  summarizeBrowserTurn,
} = require("../lib/browser-turns");

const NEEDS_EVIDENCE_DISPLAY = "I need page evidence from the browser extension before I can answer this page question.";

function withStore(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moa-browser-turns-"));
  const turnsDir = path.join(root, "turns");
  const evidenceDir = path.join(root, "evidence");
  const store = createBrowserTurnStore({ turnsDir, evidenceDir });
  return Promise.resolve(fn({ store, root, turnsDir, evidenceDir })).finally(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
}

test("needs-evidence lifecycle is inert and requests browser-owned evidence", () => {
  const record = browserNeedsEvidenceRecord({ id: "turn-1", status: "queued", actions: [{ type: "click" }] });
  assert.equal(record.status, "needs_evidence");
  assert.equal(record.classification, "browser_page_question");
  assert.equal(record.response.display, NEEDS_EVIDENCE_DISPLAY);
  assert.deepEqual(record.response.actions, []);
  assert.deepEqual(record.actions, [{ type: "click" }]);
  assert.equal(browserTurnHttpStatus(record), 202);
  assert.equal(browserTurnHttpStatus({ status: "failed" }), 500);
  assert.equal(browserTurnHttpStatus({ status: "completed" }), 200);
});

test("completion lifecycle awaits the injected answer and preserves explicit timestamps", async () => {
  const seen = [];
  const lifecycle = createBrowserTurnLifecycle({
    answerBrowserEvidence: async (record, context) => {
      seen.push([record.id, context]);
      return { display: "answer", actions: [] };
    },
    now: () => "2026-01-01T00:00:00.000Z",
  });
  const completed = await lifecycle.completeBrowserTurnRecord(
    { id: "one", updated_at: "", evidence_media: { image: { status: "available" } } },
    { answerContext: { inlineImage: { data_base64: "jpeg" } } },
  );
  assert.deepEqual(seen, [["one", { inlineImage: { data_base64: "jpeg" } }]]);
  assert.equal(completed.status, "completed");
  assert.equal(completed.completed_at, "2026-01-01T00:00:00.000Z");
  assert.equal(completed.updated_at, "2026-01-01T00:00:00.000Z");
  assert.equal(completed.response.display, "answer");

  const explicit = await lifecycle.completeBrowserTurnRecord({
    id: "two",
    completed_at: "old-completed",
    updated_at: "old-updated",
  }, { completedAt: "explicit-completed" });
  assert.equal(explicit.completed_at, "explicit-completed");
  assert.equal(explicit.updated_at, "old-updated");
  assert.throws(() => createBrowserTurnLifecycle({}), /answerBrowserEvidence is required/);
});

test("lifecycle payload returns bounded defaults and a nested summary", () => {
  const payload = browserLifecyclePayload({
    id: "turn one",
    session_id: "session",
    conversation_id: "conversation",
    branch_id: "branch",
    status: "needs_evidence",
    text: "question",
    response: { text: "waiting", speak: "spoken" },
    evidence_refs: "not-an-array",
    task_ids: ["task"],
    created_at: "created",
    updated_at: "updated",
  }, { legacy: "browser" });
  assert.equal(payload.turn_id, "turn one");
  assert.equal(payload.text, "waiting");
  assert.equal(payload.display, "waiting");
  assert.equal(payload.speak, "spoken");
  assert.equal(payload.status_url, "/v1/browser/turns/turnone/status");
  assert.deepEqual(payload.evidence_refs, []);
  assert.deepEqual(payload.task_ids, ["task"]);
  assert.equal(payload.follow_up_expected, true);
  assert.equal(payload.end_of_turn, false);
  assert.equal(payload.legacy_surface, "browser");
  assert.equal(payload.evidence_media, null);
  assert.equal(payload.evidence_delivery, null);
  assert.equal(payload.model_backed, false);
  assert.equal(payload.model_error, "");
  assert.equal(payload.browser_turn.completed_at, "");
});

test("lifecycle payload prefers display and preserves populated arrays", () => {
  const record = {
    id: "id",
    turn_id: "turn",
    status: "completed",
    classification: "custom",
    modality: "voice",
    response: { display: "display" },
    page_ref: { url: "https://example.com" },
    evidence_media: { image: { status: "available" } },
    evidence_refs: ["evidence"],
    evidence_request_ids: ["request"],
    agent_run_ids: ["run"],
    proposal_ids: ["proposal"],
    actions: [{ type: "proposal" }],
    deleted_at: "deleted",
  };
  const payload = browserLifecyclePayload(record);
  assert.equal(payload.turn_id, "turn");
  assert.equal(payload.text, "display");
  assert.equal(payload.action, "custom");
  assert.equal(payload.end_of_turn, true);
  assert.equal(payload.legacy_surface, undefined);
  assert.deepEqual(payload.actions, [{ type: "proposal" }]);
  assert.equal(payload.browser_turn.evidence_media.image.status, "available");
  assert.deepEqual(summarizeBrowserTurn(record).proposal_ids, ["proposal"]);
  assert.equal(summarizeBrowserTurn(record).deleted_at, "deleted");
});

test("browser turn store atomically writes, reads, sorts, and finds turns", () => withStore(({ store }) => {
  store.writeBrowserTurnRecord({
    id: "older",
    updated_at: "2026-01-01T00:00:00.000Z",
    evidence_request_ids: ["request-old"],
  });
  store.writeBrowserTurnRecord({
    id: "newer",
    created_at: "2026-02-01T00:00:00.000Z",
    evidence_request_ids: ["request-new"],
  });
  assert.equal(store.readBrowserTurnRecord("newer").id, "newer");
  assert.deepEqual(store.listAllBrowserTurns().map((item) => item.id), ["newer", "older"]);
  assert.equal(store.findBrowserTurnByEvidenceRequestId("request-new").id, "newer");
  assert.equal(store.findBrowserTurnByEvidenceRequestId("missing"), null);
  assert.equal(store.findBrowserTurnByEvidenceRequestId("///"), null);
  assert.equal(store.readBrowserTurnRecord("///"), null);
  assert.equal(store.readBrowserTurnRecord("missing"), null);
}));

test("browser evidence store round-trips and corrupt records fail closed", () => withStore(({ store, turnsDir, evidenceDir }) => {
  store.writeBrowserEvidenceRecord({ id: "evidence-1", summary: { visible_text: "hello" } });
  assert.equal(store.readBrowserEvidenceRecord("evidence-1").summary.visible_text, "hello");
  assert.equal(store.readBrowserEvidenceRecord("missing"), null);
  assert.equal(store.readBrowserEvidenceRecord("///"), null);

  fs.writeFileSync(path.join(turnsDir, "broken.json"), "{");
  fs.writeFileSync(path.join(turnsDir, "empty.json"), "{}");
  fs.writeFileSync(path.join(turnsDir, "ignored.txt"), "text");
  fs.writeFileSync(path.join(evidenceDir, "broken.json"), "{");
  assert.deepEqual(store.listAllBrowserTurns(), []);
  assert.equal(store.readBrowserEvidenceRecord("broken"), null);
  assert.throws(() => store.writeBrowserTurnRecord({ id: "///" }), /conversation_id is invalid/);
  assert.throws(() => store.writeBrowserEvidenceRecord({ id: "" }), /conversation_id is invalid/);
}));

test("browser turn store validates its directories", () => {
  assert.throws(() => createBrowserTurnStore({ turnsDir: "", evidenceDir: "" }), /turnsDir and evidenceDir are required/);
});

test("browser turn listing remains fail-soft if its directory disappears", () => withStore(({ store, turnsDir }) => {
  fs.rmSync(turnsDir, { recursive: true, force: true });
  assert.deepEqual(store.listAllBrowserTurns(), []);
}));
