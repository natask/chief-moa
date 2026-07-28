import assert from "node:assert/strict";
import test from "node:test";
import { validateManifest } from "./plan.mjs";

const base = {
  schema_version: 1,
  candidate_commit: "0".repeat(40),
  artifact_digests: { android: `sha256:${"a".repeat(64)}`, browser: `sha256:${"b".repeat(64)}` },
  references: [{ path: "definitely-absent-reference-dir", required: false, provenance: "user supplied" }],
  rounds: 2,
  critique: { command: "claude", requested_model: "opus" },
  states: ["idle", "user_stream_short", "user_stream_tail", "assistant_stream_tail", "expanded_transcript", "engaged", "light_background", "dark_background", "large_text"],
};

test("valid dry-run reports an optional missing reference without inventing it", () => {
  const result = validateManifest(base);
  assert.equal(result.ok, true);
  assert.equal(result.references[0].status, "missing_reference");
});

test("requires two rounds, opus, and the complete state matrix", () => {
  const result = validateManifest({ ...base, rounds: 1, critique: { command: "claude", requested_model: "sonnet" }, states: ["idle"] });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /rounds must equal 2/);
  assert.match(result.errors.join("\n"), /requested_model must be opus/);
  assert.match(result.errors.join("\n"), /missing required state: expanded_transcript/);
});

test("a required missing reference fails", () => {
  const result = validateManifest({ ...base, references: [{ ...base.references[0], required: true }] });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /required reference is missing/);
});
