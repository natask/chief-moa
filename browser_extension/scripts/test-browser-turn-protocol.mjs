import assert from "node:assert/strict";
import test from "node:test";
import {
  browserEvidencePage,
  browserTurnActions,
  browserTurnClient,
  browserTurnEvidenceRequestId,
  browserTurnFailed,
  browserTurnHasAnswer,
  browserTurnId,
  browserTurnIsPending,
  browserTurnNeedsEvidence,
  browserTurnReplyText,
  browserTurnStatusPath,
  browserTurnSummary,
  normalizeBrowserSnapshot,
} from "../extension/browser-turn-protocol.js";

test("snapshot normalization creates bounded canonical browser evidence", () => {
  const now = () => new Date("2026-07-15T12:00:00.000Z");
  const empty = normalizeBrowserSnapshot(null, { randomUUID: () => "snapshot-1", now });
  assert.deepEqual(empty, {
    url: "",
    title: "",
    pageText: "",
    elements: [],
    snapshotId: "snap_snapshot-1",
    viewport: null,
    capturedAt: "2026-07-15T12:00:00.000Z",
    documentContext: null,
    elementSummaries: [],
  });

  const raw = normalizeBrowserSnapshot({
    url: 42,
    title: false,
    page_text: "fallback text",
    snapshot_id: "snapshot-existing",
    captured_at: "captured-existing",
    viewport: { width: 800 },
    elements: [
      { i: 0, tag: "button", type: "submit", label: "Send" },
      { i: 1, tag: "a" },
    ],
  }, { now });
  assert.equal(raw.url, "42");
  assert.equal(raw.title, "");
  assert.equal(raw.pageText, "fallback text");
  assert.equal(raw.snapshotId, "snapshot-existing");
  assert.equal(raw.capturedAt, "captured-existing");
  assert.equal(raw.documentContext, null);
  assert.deepEqual(raw.elementSummaries, ["[0] <button submit> Send", "[1] <a>"]);

  const supplied = normalizeBrowserSnapshot({
    pageText: "preferred",
    snapshotId: "preferred-id",
    capturedAt: "preferred-time",
    viewport: "bad",
    elements: "bad",
    elementSummaries: ["one", 0, null],
  }, { now });
  assert.deepEqual(supplied.elements, []);
  assert.deepEqual(supplied.elementSummaries, ["one", "", ""]);
  assert.equal(supplied.viewport, null);

  const withDocumentContext = normalizeBrowserSnapshot({
    document_context: { scope: "whole_rendered_document", complete: true },
  }, { now });
  assert.deepEqual(withDocumentContext.documentContext, { scope: "whole_rendered_document", complete: true });

  const timeFallback = normalizeBrowserSnapshot({}, { randomUUID: () => "", now });
  assert.equal(timeFallback.snapshotId, `snap_${now().getTime().toString(36)}`);
});

test("client and page evidence preserve the bounded transport shape", () => {
  assert.deepEqual(browserTurnClient("device-1", "voice"), {
    platform: "browser",
    source: "agee-extension",
    device_id: "device-1",
    input: "voice",
  });
  assert.deepEqual(browserEvidencePage({}), {
    url: "",
    title: "",
    snapshot_id: "",
    captured_at: "",
    viewport: null,
  });
  assert.deepEqual(browserEvidencePage({
    url: "https://example.test",
    title: "Example",
    snapshotId: "snap-1",
    capturedAt: "now",
    viewport: { width: 1 },
  }), {
    url: "https://example.test",
    title: "Example",
    snapshot_id: "snap-1",
    captured_at: "now",
    viewport: { width: 1 },
  });
});

test("turn identity and status paths accept protocol aliases without leaking origins", () => {
  for (const [input, expected] of [
    [{ id: "a" }, "a"],
    [{ turn_id: "b" }, "b"],
    [{ browser_turn_id: "c" }, "c"],
    [{ turn: { id: "d" } }, "d"],
    [{ turn: { turn_id: "e" } }, "e"],
    [{}, null],
  ]) assert.equal(browserTurnId(input), expected);

  for (const input of [
    { status_url: "https://api.example/v1/status/a?wait=1" },
    { statusUrl: "/status-relative" },
    { turn: { status_url: "/nested-status" } },
    { turn: { statusUrl: "/nested-camel" } },
  ]) assert.ok(browserTurnStatusPath(input).startsWith("/"));
  assert.equal(browserTurnStatusPath({ status_url: "https://api.example/v1/status/a?wait=1" }), "/v1/status/a?wait=1");
  assert.equal(browserTurnStatusPath({ id: "a/b" }), "/v1/browser/turns/a%2Fb/status");
  assert.equal(browserTurnStatusPath({}), "");
});

test("evidence requests and terminal state aliases are deterministic", () => {
  assert.equal(browserTurnNeedsEvidence({ status: "NEEDS_EVIDENCE" }), true);
  assert.equal(browserTurnNeedsEvidence({ state: "needs_evidence" }), true);
  assert.equal(browserTurnNeedsEvidence({ turn: { status: "needs_evidence" } }), true);
  assert.equal(browserTurnNeedsEvidence({ status: "running" }), false);
  assert.equal(browserTurnEvidenceRequestId({ evidence_request_ids: ["", " req-1 "] }), "req-1");
  assert.equal(browserTurnEvidenceRequestId({ turn: { evidence_request_ids: ["req-2"] } }), "req-2");
  assert.equal(browserTurnEvidenceRequestId({ evidence_request_ids: "bad", turn: {} }), "");

  for (const status of ["error", "failed", "cancelled", "canceled"]) {
    assert.equal(browserTurnFailed({ status }), true);
  }
  assert.equal(browserTurnFailed({ state: "FAILED" }), true);
  assert.equal(browserTurnFailed({ turn: { status: "cancelled" } }), true);
  assert.equal(browserTurnFailed({ status: "done" }), false);
});

test("reply and action aliases form inert summaries", () => {
  const replyCases = [
    { display: "display" }, { text: "text" }, { answer: "answer" }, { summary: "summary" },
    { result: { display: "r-display" } }, { result: { text: "r-text" } },
    { result: { answer: "r-answer" } }, { result: { summary: "r-summary" } },
    { turn: { display: "t-display" } }, { turn: { text: "t-text" } },
    { turn: { answer: "t-answer" } }, { turn: { summary: "t-summary" } },
  ];
  for (const value of replyCases) assert.ok(browserTurnReplyText(value));
  assert.equal(browserTurnReplyText({ display: "  ", result: null, turn: "bad" }), "");

  const allActions = browserTurnActions({
    actions: [1], proposals: [2], action_proposals: [3],
    result: { actions: [4], proposals: [5], action_proposals: [6] },
  });
  assert.deepEqual(allActions, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(browserTurnActions({ actions: "bad", result: null }), []);
  assert.equal(browserTurnSummary({ text: "Done" }), "Done");
  assert.equal(browserTurnSummary({ actions: [{}] }), "Gateway proposed 1 browser action; not executed in this slice.");
  assert.equal(browserTurnSummary({ text: "Done", actions: [{}, {}] }), "Done\n\nGateway proposed 2 browser actions; not executed in this slice.");
  assert.equal(browserTurnSummary({}), "The gateway returned an empty browser-agent response.");
  assert.equal(browserTurnHasAnswer({ answer: "yes" }), true);
  assert.equal(browserTurnHasAnswer({ proposals: [{}] }), true);
  assert.equal(browserTurnHasAnswer({}), false);
});

test("pending states stop being pending as soon as an answer arrives", () => {
  for (const status of ["", "queued", "pending", "accepted", "created", "running", "working", "started", "processing", "in_progress"]) {
    assert.equal(browserTurnIsPending({ status }), true, status || "empty");
  }
  assert.equal(browserTurnIsPending({ state: "RUNNING" }), true);
  assert.equal(browserTurnIsPending({ turn: { status: "pending" } }), true);
  assert.equal(browserTurnIsPending({ status: "running", text: "ready" }), false);
  assert.equal(browserTurnIsPending({ status: "done" }), false);
});
