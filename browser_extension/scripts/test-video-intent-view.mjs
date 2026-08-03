import assert from "node:assert/strict";
import test from "node:test";
import {
  videoEvidenceRef,
  videoIntentEditCommand,
  videoIntentItems,
  videoNoteId,
} from "../extension/video-intent-view.js";

test("video intents are selected by durable evidence and newest update", () => {
  const old = { intent_id: "old", evidence_refs: ["video-note://vnote_old"], updated_at: "2026-01-01" };
  const next = { intent_id: "new", evidence_refs: ["video-note://vnote_new"], updated_at: "2026-02-01" };
  const items = videoIntentItems({ items: [old, { intent_id: "text" }, next] });
  assert.deepEqual(items.map((item) => item.intent_id), ["new", "old"]);
  assert.equal(videoEvidenceRef(next), "video-note://vnote_new");
  assert.equal(videoNoteId(next), "vnote_new");
});

test("edit commands preserve evidence, require content, and use optimistic versioning", () => {
  const intent = { version: 3, evidence_refs: ["video-note://vnote_one"] };
  assert.deepEqual(videoIntentEditCommand(intent, "Keep the full thought.", "edit-1"), {
    type: "intent.enriched",
    statement: "Keep the full thought.",
    normalized_objective: "Keep the full thought.",
    next_step: "Review this captured intent before any dispatch.",
    source_receipt_refs: ["video-note://vnote_one"],
    expected_intent_version: 3,
    idempotency_key: "edit-1",
  });
  assert.throws(() => videoIntentEditCommand(intent, " ", "edit-2"), /cannot be empty/);
  assert.throws(() => videoIntentEditCommand(intent, "x".repeat(2001), "edit-3"), /2,000/);
});
