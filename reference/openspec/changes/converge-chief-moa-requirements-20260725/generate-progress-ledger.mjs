#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const changeDir = path.dirname(new URL(import.meta.url).pathname);
const repoRoot = path.resolve(changeDir, "../../../..");
const changesRoot = path.join(repoRoot, "reference/openspec/changes");
const ledgerPath = path.join(changeDir, "progress-ledger.md");
const selfRelative = path.relative(repoRoot, changeDir).replaceAll(path.sep, "/");

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "archive") return [];
      return walk(full);
    }
    return entry.name === "tasks.md" ? [full] : [];
  });
}

function normalize(value) {
  return value.replace(/\s+/g, " ").trim();
}

function escapeCell(value) {
  return String(value || "—")
    .replaceAll("|", "\\|")
    .replaceAll("\n", "<br>");
}

function parseTasks(file) {
  const relative = path.relative(repoRoot, file).replaceAll(path.sep, "/");
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  const tasks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^\s*-\s+\[([ xX])\]\s+(.*)$/);
    if (!match) continue;
    const body = [match[2]];
    let cursor = index + 1;
    while (
      cursor < lines.length &&
      !/^\s*-\s+\[[ xX]\]\s+/.test(lines[cursor]) &&
      !/^#{1,6}\s+/.test(lines[cursor])
    ) {
      if (lines[cursor].trim()) body.push(lines[cursor].trim());
      cursor += 1;
    }
    const text = normalize(body.join(" "));
    // The leading task label is part of the durable source identity. Keeping it
    // avoids collapsing intentionally repeated task wording within one file.
    const idMaterial = `${relative}\n${normalize(match[2])}`;
    const id = `task-${crypto.createHash("sha256").update(idMaterial).digest("hex").slice(0, 16)}`;
    tasks.push({
      id,
      path: relative,
      line: index + 1,
      sourceChecked: match[1].toLowerCase() === "x",
      text,
    });
  }
  return tasks;
}

function acceptanceFor(task) {
  const explicit = task.text.match(/Acceptance:\s*(.*)$/i);
  if (explicit) return normalize(explicit[1]);
  const requirement = requirementFor(task);
  return `A reviewed fixture names inputs, expected outputs, and a verification command for "${requirement}".`;
}

function requirementFor(task) {
  return normalize(task.text.split(/\bAcceptance:/i)[0]);
}

function plannedNextAction(task) {
  const requirement = requirementFor(task);
  if (/Acceptance:/i.test(task.text)) {
    return task.sourceChecked
      ? `Independently verify the claimed result for "${requirement}" using the named acceptance artifact, state, or command.`
      : `Produce the named artifact or observable state for "${requirement}", then run its source acceptance check.`;
  }
  return `Define an acceptance fixture for "${requirement}" in ${path.dirname(task.path)} before product implementation.`;
}

function classify(task) {
  const key = `${task.path}:${task.text}`;
  const base = {
    status: task.sourceChecked ? "implemented_unverified" : "not_started",
    evidence: task.sourceChecked
      ? `Source checkbox claims completion at ${task.path}:${task.line}; no independent evidence registered.`
      : "No implementation evidence registered.",
    independent: "",
    next: plannedNextAction(task),
    acceptance: acceptanceFor(task),
    blocker: "",
    duplicates: "",
  };

  const explicitlyStillUnresolved = /\b(still pending|awaiting|waits? on|requires? user|not yet|remains? blocked)\b/i.test(task.text);
  if (/\[blocked(?::|\])/i.test(task.text) && (!task.sourceChecked || explicitlyStillUnresolved)) {
    base.status = "blocked";
    base.blocker = normalize(task.text.match(/\[blocked[^\]]*\]/i)?.[0] || "Named source blocker");
    base.next = `Resolve or obtain authority for ${base.blocker} before producing the named result for "${requirementFor(task)}".`;
  }
  if (/\[decision:/i.test(task.text) && (!task.sourceChecked || explicitlyStillUnresolved)) {
    base.status = "blocked";
    base.blocker = normalize(task.text.match(/\[decision:[^\]]*\]/i)?.[0] || "User decision");
    base.next = `Obtain ${base.blocker} without silently selecting it before producing the named result for "${requirementFor(task)}".`;
  }
  if (/\[in-progress: bounded first slice; no implementation claimed\]/i.test(task.text)) {
    base.status = "in_progress";
    base.evidence = "Bounded first slice selected in source; no implementation claimed.";
    base.next = `Produce only the explicitly bounded artifact for "${requirementFor(task)}" and run its stated acceptance check.`;
  }

  if (
    task.path === "reference/openspec/changes/macos-clicky-parity-surface/tasks.md" &&
    /^1\.2\b/.test(task.text)
  ) {
    base.evidence =
      "Commit f6ec029f616cbedd48b9a50b20946639e34ae66c; Swift tests/static scan in that change; installed and dist executable SHA-256 624068bf65ae520bf695594591ea9791105d49faf08e6ec5b2cb7f57478ec4a2.";
    base.next =
      `Have an independent verifier inspect commit f6ec029f and verify "${requirementFor(task)}" with the non-privileged Swift/static checks.`;
    base.acceptance =
      "Independent verification confirms entered tokens remain memory-only and clear on disconnect/stop.";
    base.blocker = "Independent verification receipt is not yet registered.";
  }
  if (
    task.path === "reference/openspec/changes/macos-clicky-parity-surface/tasks.md" &&
    /^1\.5\b/.test(task.text)
  ) {
    base.evidence =
      "Commit f6ec029f616cbedd48b9a50b20946639e34ae66c adds apple_surfaces/scripts/scan-moa-mac.sh persistence-pattern checks.";
    base.next =
      `Have an independent verifier verify "${requirementFor(task)}" by rerunning the non-privileged source/binary scan.`;
    base.acceptance =
      "Independent scan rejects Keychain/SecItem/generic-password persistence in runnable Apple sources and the packaged binary.";
    base.blocker = "Independent verification receipt is not yet registered.";
  }
  if (task.path === `${selfRelative}/tasks.md` && /^2\.2\b/.test(task.text)) {
    base.status = "implemented_unverified";
    base.evidence =
      "Installed /Users/natnaelkahssay/Applications/MoaMac.app executable matches dist SHA-256 624068bf65ae520bf695594591ea9791105d49faf08e6ec5b2cb7f57478ec4a2; no runtime launch receipt.";
    base.next =
      "Ask the user to operate launch/connect/turn/disconnect/relaunch and record whether any prompt appears.";
    base.blocker =
      "User-operated runtime QA is required; prompt-capable diagnostics are prohibited without explicit approval.";
  }
  if (task.path === `${selfRelative}/tasks.md` && /^2\.3\b/.test(task.text)) {
    base.blocker = "Exact backup targets and deletion authority are intentionally absent.";
  }
  if (task.path === `${selfRelative}/tasks.md` && /^2\.4\b/.test(task.text)) {
    base.blocker = "MOA.app is a separate scope; no evidence may be inherited from MoaMac.app.";
  }
  if (task.path === `${selfRelative}/tasks.md` && /^2\.5\b/.test(task.text)) {
    base.evidence = "Policy recorded: historical and archived prose is non-authoritative.";
  }
  if (/AGEE_GATEWAY_TOKEN/.test(key)) {
    base.status = "blocked";
    base.blocker = "User-authorized AGEE_GATEWAY_TOKEN and live-network authority required.";
  }
  return base;
}

const files = walk(changesRoot).sort();
const tasks = files.flatMap(parseTasks);
const ids = new Set();
for (const task of tasks) {
  if (ids.has(task.id)) throw new Error(`duplicate stable id: ${task.id}`);
  ids.add(task.id);
}

const rows = tasks.map((task) => ({ ...task, ...classify(task) }));
const duplicateGroups = new Map();
for (const row of rows) {
  const duplicateKey = normalize(row.text)
    .replace(/^\S+\s+/, "")
    .replace(/\[(?:in-progress|blocked|decision)[^\]]*\]\s*/gi, "");
  const group = duplicateGroups.get(duplicateKey) || [];
  group.push(row.id);
  duplicateGroups.set(duplicateKey, group);
  row.duplicateKey = duplicateKey;
}
for (const row of rows) {
  const peers = duplicateGroups.get(row.duplicateKey).filter((id) => id !== row.id);
  row.duplicates = peers.join(", ");
}
for (const row of rows) {
  const forbiddenGeneric = [
    "Execute the smallest bounded portion of this source task",
    "Record observable evidence that the exact source task is satisfied",
    "source task is satisfied",
  ];
  if (forbiddenGeneric.some((phrase) => row.next.includes(phrase) || row.acceptance.includes(phrase))) {
    throw new Error(`generic placeholder phrase remains: ${row.id}`);
  }
  const requirement = requirementFor(row);
  if (normalize(row.acceptance).toLowerCase() === normalize(requirement).toLowerCase()) {
    throw new Error(`tautological acceptance repeats requirement: ${row.id}`);
  }
  const specificTokens = new Set(
    requirement.toLowerCase().match(/[a-z0-9_./:-]{4,}/g) || [],
  );
  const observableText = `${row.next} ${row.acceptance}`.toLowerCase();
  const overlap = [...specificTokens].filter((token) => observableText.includes(token));
  if (specificTokens.size > 0 && overlap.length < Math.min(2, specificTokens.size)) {
    throw new Error(`next action/acceptance is not task-specific: ${row.id}`);
  }
  const nextOverlap = [...specificTokens].filter((token) => row.next.toLowerCase().includes(token));
  if (specificTokens.size > 0 && nextOverlap.length < Math.min(2, specificTokens.size)) {
    throw new Error(`next action does not retain task operation/scope: ${row.id}`);
  }
  if (/^(done|complete|task completed|requirement satisfied|works as expected)\.?$/i.test(normalize(row.acceptance))) {
    throw new Error(`overly generic acceptance: ${row.id}`);
  }
  if (row.status !== "verified_complete" && (!row.next || !row.acceptance)) {
    throw new Error(`incomplete row lacks next action/acceptance: ${row.id}`);
  }
  if (row.status === "verified_complete" && (!row.evidence || !row.independent)) {
    throw new Error(`verified_complete lacks evidence/independent verification: ${row.id}`);
  }
}

for (const file of files) {
  const fileRows = rows.filter((row) => row.path === path.relative(repoRoot, file).replaceAll(path.sep, "/"));
  if (fileRows.length > 0 && !fileRows.some((row) => row.sourceChecked)) {
    const selected = fileRows.filter((row) => row.status === "in_progress");
    if (selected.length !== 1) {
      throw new Error(`zero-progress program must have exactly one bounded in-progress slice: ${file}`);
    }
  }
}

const counts = Object.fromEntries(
  ["verified_complete", "implemented_unverified", "in_progress", "blocked", "not_started"]
    .map((status) => [status, rows.filter((row) => row.status === status).length]),
);
const header = [
  "# Canonical Progress Ledger",
  "",
  "<!-- GENERATED FILE. Run ./generate-progress-ledger.mjs --write; validate with ./generate-progress-ledger.mjs -->",
  "",
  `Source files: ${files.length}. Source checkboxes: ${tasks.length}. Ledger rows: ${rows.length}.`,
  "",
  `Status counts: verified_complete=${counts.verified_complete}; implemented_unverified=${counts.implemented_unverified}; in_progress=${counts.in_progress}; blocked=${counts.blocked}; not_started=${counts.not_started}.`,
  "",
  "Only `verified_complete` counts as complete. A checked source box defaults to `implemented_unverified` until exact evidence and independent verification are registered.",
  "",
  "| Stable ID | Source | Source text | Status | Evidence | Independent verification | Smallest next action | Acceptance check | Blocker / authority | Duplicates |",
  "|---|---|---|---|---|---|---|---|---|---|",
];
const table = rows.map((row) =>
  `| ${row.id} | ${escapeCell(`${row.path}:${row.line}`)} | ${escapeCell(row.text)} | ${row.status} | ${escapeCell(row.evidence)} | ${escapeCell(row.independent)} | ${escapeCell(row.next)} | ${escapeCell(row.acceptance)} | ${escapeCell(row.blocker)} | ${escapeCell(row.duplicates)} |`
);
const output = `${[...header, ...table, ""].join("\n")}`;

if (process.argv.includes("--write")) {
  fs.writeFileSync(ledgerPath, output);
  console.log(`wrote ${rows.length} rows from ${files.length} active task files`);
} else {
  if (!fs.existsSync(ledgerPath)) throw new Error("progress-ledger.md is missing");
  const checked = fs.readFileSync(ledgerPath, "utf8");
  if (checked !== output) {
    throw new Error("progress-ledger.md is stale; run generate-progress-ledger.mjs --write");
  }
  console.log(
    `validated ${tasks.length} source checkboxes = ${rows.length} unique ledger rows; ` +
    `incomplete rows have next action + acceptance; verified_complete rows have evidence + independent verification`,
  );
}
