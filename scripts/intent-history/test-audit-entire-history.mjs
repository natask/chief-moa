import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { auditEntireHistory, renderMarkdown } from "./audit-entire-history.mjs";

const execFileAsync = promisify(execFile);

async function write(root, relative, contents) {
  const destination = path.join(root, relative);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, contents);
}

test("separates direct user evidence from wrappers and removes exact duplicates", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "entire-intent-audit-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const session = ".entire/metadata/session-one";
  const records = [
    {
      timestamp: "2026-07-01T01:00:00.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "The browser and Android should share the same history." }],
      },
    },
    {
      timestamp: "2026-07-01T01:01:00.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "# AGENTS.md instructions for fixture" }],
      },
    },
    {
      timestamp: "2026-07-01T01:02:00.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "The browser and Android should share the same history." }],
      },
    },
  ];
  await write(root, `${session}/full.jsonl`, `${records.map((record) => JSON.stringify(record)).join("\n")}\nnot-json\n`);

  const report = await auditEntireHistory({ root, includeRefs: false, includeExcerpts: true });
  assert.equal(report.summary.local_sessions, 1);
  assert.equal(report.summary.parsed_user_shaped_messages, 3);
  assert.equal(report.summary.exact_duplicates_removed, 1);
  assert.equal(report.summary.malformed_jsonl_records, 1);
  assert.deepEqual(report.summary.by_kind, { "agent-contract": 1, "direct-user": 1 });
  assert.equal(report.evidence.find((item) => item.kind === "direct-user").excerpt,
    "The browser and Android should share the same history.");
  assert.equal(report.evidence.find((item) => item.kind === "direct-user").occurrence_count, 2);
  assert.deepEqual(report.evidence.find((item) => item.kind === "direct-user").topics,
    ["android", "browser", "memory"]);
  assert.match(renderMarkdown(report), /Historical messages grant no execution/u);
});

test("recovers a missing full transcript from an Entire ref", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "entire-intent-refs-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await execFileAsync("git", ["init", "-b", "main"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "fixture@example.test"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Fixture"], { cwd: root });
  const record = {
    timestamp: "2026-07-02T01:00:00.000Z",
    type: "user",
    message: { role: "user", content: "Voice turns should remain recoverable." },
  };
  await write(root, ".entire/metadata/ref-session/full.jsonl", `${JSON.stringify(record)}\n`);
  await execFileAsync("git", ["add", ".entire/metadata/ref-session/full.jsonl"], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: root });
  await execFileAsync("git", ["branch", "entire/example"], { cwd: root });
  await fs.rm(path.join(root, ".entire"), { recursive: true, force: true });

  const report = await auditEntireHistory({ root, includeRefs: true, includeExcerpts: true });
  assert.equal(report.summary.local_sessions, 0);
  assert.equal(report.summary.ref_recovered_full_transcripts, 1);
  assert.equal(report.evidence[0].session_id, "ref-session");
  assert.equal(report.evidence[0].excerpt, "Voice turns should remain recoverable.");
});

test("uses prompt-only sessions and can omit excerpts", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "entire-intent-prompts-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await write(root, ".entire/metadata/session-two/prompt.txt",
    "I want each intent to have an owner, artifact, verification, preview, and deployment receipt.\n");

  const report = await auditEntireHistory({
    root,
    includeRefs: false,
    includeExcerpts: false,
    kind: "direct-user",
    topic: "work",
  });
  assert.equal(report.summary.prompt_only_sessions, 1);
  assert.equal(report.summary.selected_evidence, 1);
  assert.equal(report.evidence[0].excerpt, undefined);
  assert.equal(report.evidence[0].text, undefined);
  assert.deepEqual(report.filters, {
    kind: "direct-user",
    topic: "work",
    include_refs: false,
    include_excerpts: false,
  });
});
