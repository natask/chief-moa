import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { auditDocumentation, renderMarkdown } from "./authority-audit.mjs";

const execFileAsync = promisify(execFile);

async function writeFixture(root, relative, contents) {
  const destination = path.join(root, relative);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, contents);
}

async function snapshot(root) {
  const entries = [];
  async function walk(directory) {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else entries.push([path.relative(root, absolute), await fs.readFile(absolute, "utf8")]);
    }
  }
  await walk(root);
  return entries;
}

test("audits authority signals without modifying the fixture", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "authority-audit-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));

  await writeFixture(root, "README.md", [
    "# Fixture",
    "",
    "This is the source of truth.",
    "",
    "[Current](docs/current.md)",
    "[Missing](docs/gone.md)",
    "",
    "Old host: http://retired.internal/status",
  ].join("\n"));
  await writeFixture(root, "docs/current.md", "# Current\n\nThis is also a source of truth.\n");
  await writeFixture(root, "docs/old.md", "# Old\n\nSuccessor: [current](current.md)\n");
  await writeFixture(root, "docs/orphan.md", "# Orphan\n");
  await writeFixture(root, "reference/openspec/changes/active/tasks.md", "- [x] First\n- [ ] Second\n");
  await writeFixture(root, "reference/openspec/changes/done/tasks.md", "- [x] First\n- [X] Second\n");
  await writeFixture(root, "reference/openspec/changes/archive/old/tasks.md", "- [x] Archived\n");

  const before = await snapshot(root);
  const report = await auditDocumentation({ root, decommissionedHosts: ["retired.internal"] });
  const after = await snapshot(root);

  assert.deepEqual(after, before, "the audit must be read-only");
  assert.equal(report.summary.markdownDocuments, 7);
  assert.equal(report.summary.localIncomingLinks, 2);
  assert.equal(report.summary.brokenLocalLinks, 1);
  assert.equal(report.summary.decommissionedHostMentions, 1);
  assert.equal(report.summary.duplicateAuthorityPhraseGroups, 1);
  assert.deepEqual(report.openspec.map(({ change, status }) => [change, status]), [
    ["active", "active"],
    ["done", "completed-candidate"],
  ]);
  assert.deepEqual(report.successorMetadata.map(({ file, status, resolved }) => [file, status, resolved]), [
    ["docs/old.md", "valid", "docs/current.md"],
  ]);
  assert.deepEqual(report.archiveCandidates, [
    { kind: "openspec-change", path: "reference/openspec/changes/done", reason: "all task checkboxes are complete" },
    { kind: "superseded-document", path: "docs/old.md", reason: "declares successor docs/current.md" },
  ]);
  assert.match(renderMarkdown(report), /A candidate is not permission to move, archive,/u);
});

test("CLI emits parseable JSON and does not offer a write option", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "authority-audit-cli-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeFixture(root, "README.md", "# CLI fixture\n");
  const before = await snapshot(root);
  const script = path.join(path.dirname(new URL(import.meta.url).pathname), "authority-audit.mjs");

  const { stdout } = await execFileAsync(process.execPath, [script, "--root", root, "--format", "json"]);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.summary.markdownDocuments, 1);
  assert.deepEqual(await snapshot(root), before);

  await assert.rejects(
    execFileAsync(process.execPath, [script, "--root", root, "--output", "report.md"]),
    /Unknown argument: --output/u,
  );
  assert.deepEqual(await snapshot(root), before);
});

test("fails closed for paths, nested checkouts, and invalid successors", async (context) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "authority-audit-adversarial-"));
  const root = path.join(parent, "repo");
  const outside = path.join(parent, "outside.md");
  await fs.mkdir(root);
  await fs.writeFile(outside, "# Outside\n");
  context.after(() => fs.rm(parent, { recursive: true, force: true }));

  await writeFixture(root, "README.md", [
    "# Adversarial fixture",
    "",
    "[Balanced](docs/name_(v1).md)",
    "[Traversal](../outside.md)",
    "[Escaping symlink](docs/escape.md)",
  ].join("\n"));
  await writeFixture(root, "docs/name_(v1).md", "# Parenthesized\n");
  await fs.symlink(outside, path.join(root, "docs", "escape.md"));
  await writeFixture(root, "docs/self.md", "# Self\n\nSuccessor: [self](self.md)\n");
  await writeFixture(root, "docs/directory-old.md", "# Directory\n\nSuccessor: [directory](directory)\n");
  await writeFixture(root, "docs/directory/note.txt", "not a Markdown successor\n");
  await writeFixture(root, "docs/parentheses-old.md", "# Old\n\nReplaced by: [new](name_(v1).md)\n");
  await writeFixture(root, "vendor/nested-copy/.git", "gitdir: /tmp/unrelated\n");
  await writeFixture(root, "vendor/nested-copy/hidden.md", "# Must not be audited\n");
  await writeFixture(root, "vendor/nested-directory/.git/config", "[core]\n");
  await writeFixture(root, "vendor/nested-directory/hidden.md", "# Must not be audited either\n");

  const report = await auditDocumentation({ root, decommissionedHosts: [] });
  assert.equal(report.summary.markdownDocuments, 5, "nested checkout and symlink targets are not documents");
  assert.equal(report.incomingLinks.find(({ file }) => file === "docs/name_(v1).md").incoming.length, 2);
  assert.deepEqual(
    report.staleReferences.brokenLocalLinks.map(({ destination, reason }) => [destination, reason]),
    [
      ["../outside.md", "outside-repository-lexical"],
      ["docs/escape.md", "outside-repository-realpath"],
    ],
  );
  assert.deepEqual(
    report.successorMetadata.map(({ file, status }) => [file, status]),
    [
      ["docs/directory-old.md", "directory-without-readme"],
      ["docs/parentheses-old.md", "valid"],
      ["docs/self.md", "self-successor"],
    ],
  );
  assert.deepEqual(report.archiveCandidates, [
    { kind: "superseded-document", path: "docs/parentheses-old.md", reason: "declares successor docs/name_(v1).md" },
  ]);
});
