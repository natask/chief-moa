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
  let section = "Unsectioned work";
  for (let index = 0; index < lines.length; index += 1) {
    const heading = lines[index].match(/^#{1,6}\s+(.*)$/);
    if (heading) section = normalize(heading[1]);
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
      section,
    });
  }
  return tasks;
}

function requirementFor(task) {
  return normalize(task.text.split(/\b(?:Acceptance|Verification):/i)[0]);
}

function explicitField(task, label) {
  const match = task.text.match(new RegExp(`${label}:\\s*(.*?)(?=\\s+(?:Acceptance|Verification):|$)`, "i"));
  return match ? normalize(match[1]) : "";
}

const CATEGORY_RULES = [
  ["test_verification", /\b(test|tests|verify|verification|validate|validation|prove|smoke|qa|assert|check|benchmark|fixture|coverage)\b/i],
  ["documentation_spec", /\b(document|documentation|spec|proposal|design\.md|architecture\.md|readme|runbook|guide|checklist|ledger|write up|record .* in)\b/i],
  ["audit_inventory", /\b(audit|inventory|enumerate|catalog(?:ue)?|inspect|scan|trace|map all|review all)\b/i],
  ["decision_design", /\b(decide|decision|choose|confirm|align|define .*boundar|design|adopt|evaluate .* against|policy)\b/i],
  ["deployment_release", /\b(deploy|deployment|release|promot|rollout|ship|publish|production)\b/i],
  ["operations_observability", /\b(observability|monitor|metric|alert|dashboard|health|operations|operator|telemetry|logging|log |receipt|incident|backup|restore)\b/i],
  ["research_evaluation", /\b(research|investigate|compare|assess|evaluate|spike|survey)\b/i],
  ["refactor_migration", /\b(refactor|migrat|move |split |extract|convert|rename|replace|restructure|decompos|consolidat|backfill)\b/i],
  ["implementation_code", /\b(add|implement|create|build|expose|route|bind|make|support|enforce|store|render|integrate|wire|persist|remove|disable|allow|reject|return|handle|update)\b/i],
];

function categoryFor(task) {
  const requirement = requirementFor(task);
  for (const [category, pattern] of CATEGORY_RULES) {
    if (pattern.test(requirement)) return category;
  }
  return "unknown";
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function owningChange(task) {
  return task.path.replace(/\/tasks\.md$/, "");
}

function meaningfulTerms(task, limit = 7) {
  const stop = new Set([
    "acceptance", "verification", "with", "from", "that", "this", "then", "into",
    "only", "every", "where", "when", "before", "after", "under", "using", "without",
    "through", "existing", "required", "require", "add", "implement", "define", "make",
    "update", "ensure", "record", "prove", "verify", "task", "ready", "blocked", "decision",
  ]);
  const words = requirementFor(task).toLowerCase().match(/[a-z][a-z0-9_.:/-]{3,}/g) || [];
  return [...new Set(words.filter((word) => !stop.has(word) && !/^\d/.test(word)))].slice(0, limit);
}

function mentionedArtifact(task) {
  const candidates = [...requirementFor(task).matchAll(/`([^`]+)`/g)].map((match) => match[1]);
  const file = candidates.find((value) =>
    /(?:^|\/)[\w.-]+\.(?:md|json|ya?ml|m?js|cjs|ts|tsx|jsx|swift|kt|kts|sql|sh|toml|html|css)$/.test(value) ||
    /^(?:gateway|apple_surfaces|android|browser|scripts|reference|test|tests|\.fabro)\//.test(value)
  );
  if (file) return file;
  const bare = requirementFor(task).match(/\b(?:ARCHITECTURE|README|CONTRIBUTING|AGENTS|proposal|design|tasks)\.md\b/i);
  return bare?.[0] || "";
}

function planningArtifact(task, category) {
  const suffix = {
    implementation_code: "implementation-plan",
    test_verification: "verification-receipt",
    documentation_spec: "documentation-review",
    audit_inventory: "inventory",
    decision_design: "decision-record",
    deployment_release: "release-plan",
    operations_observability: "operations-check",
    research_evaluation: "evaluation",
    refactor_migration: "migration-plan",
    unknown: "acceptance-design",
  }[category];
  return `${owningChange(task)}/evidence/${task.id}-${suffix}.md`;
}

function progressDesign(task) {
  const category = categoryFor(task);
  const mentioned = mentionedArtifact(task);
  // A source-named path is the product target. Incomplete work still gets a
  // durable per-task planning/verification record rather than pretending the
  // product target already exists.
  const artifact = category === "unknown" ? planningArtifact(task, category) : (mentioned || planningArtifact(task, category));
  const supportArtifact = planningArtifact(task, category);
  const terms = meaningfulTerms(task);
  const scope = terms.length ? terms.join(", ") : `${path.basename(owningChange(task))} task ${task.id}`;
  const inputs =
    `${task.path}:${task.line} under “${task.section}”; scoped inputs/entities: ${scope}.`;
  const explicitAcceptance = explicitField(task, "Acceptance");
  const expected = explicitAcceptance
    ? `Observable result: ${explicitAcceptance}`
    : `${category.replaceAll("_", " ")} output for ${scope}, with failure/edge conditions recorded in ${supportArtifact}.`;
  const sourceVerification = explicitField(task, "Verification");
  let method;
  let command;

  if (sourceVerification) {
    method = `Run the source-named verification and attach its exit status/output to ${supportArtifact}.`;
    const commands = [...sourceVerification.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
    const executableCommands = commands.filter((value) =>
      /^(?:cd |npm |node |bash |sh |\.\/|scripts\/|openspec |fabro |swift |git |rg |test )/.test(value)
    );
    command = executableCommands.length
      ? `Command: \`${executableCommands.join(" && ")}\`; receipt target: ${supportArtifact}`
      : `Independent review: execute “${sourceVerification.replace(/\.$/, "")}” and record reviewer, date, and result in ${supportArtifact}`;
  } else if (category === "decision_design" || category === "research_evaluation") {
    method = `Independent reviewer checks ${supportArtifact} against the source boundary and records approve/revise with rationale.`;
    command = `test -f ${shellQuote(supportArtifact)} && rg -n ${shellQuote("^(Inputs|Options|Decision|Consequences|Verification):")} ${shellQuote(supportArtifact)}`;
  } else if (category === "documentation_spec") {
    method = `Review the named document diff for the scoped terms, then record the reviewer and result in ${supportArtifact}.`;
    command = `Command: \`test -f ${shellQuote(artifact)} && git diff --check -- ${shellQuote(artifact)}\`; review receipt: ${supportArtifact}`;
  } else {
    method = `Validate ${supportArtifact}, then run the ${category.replaceAll("_", " ")} check named in its Verification section.`;
    command = `test -f ${shellQuote(supportArtifact)} && rg -n ${shellQuote("^(Inputs|Target|Expected output|Verification):")} ${shellQuote(supportArtifact)}`;
  }

  if (category === "unknown") {
    method = `Validate ${supportArtifact}; an independent reviewer must classify its source task before product work starts.`;
    command = `test -f ${shellQuote(supportArtifact)} && rg -n ${shellQuote("^(Inputs|Target|Expected output|Verification|Category rationale):")} ${shellQuote(supportArtifact)}`;
  }

  const actionVerb = task.sourceChecked ? "Verify and annotate" : "Create";
  const next =
    `${actionVerb} ${supportArtifact}; target ${artifact}; use inputs from ${task.path}:${task.line}; execute the recorded verification.`;
  const acceptance =
    `${supportArtifact} exists with Inputs, Target, Expected output, and Verification fields; the named command/review passes for ${scope}.`;
  return { category, artifact, inputs, expected, method, command, next, acceptance };
}

function classify(task) {
  const key = `${task.path}:${task.text}`;
  const progress = progressDesign(task);
  const base = {
    status: task.sourceChecked ? "implemented_unverified" : "not_started",
    evidence: task.sourceChecked
      ? `Source checkbox claims completion at ${task.path}:${task.line}; no independent evidence registered.`
      : "No implementation evidence registered.",
    independent: "",
    ...progress,
    blocker: "",
    duplicates: "",
  };

  const explicitlyStillUnresolved = /\b(still pending|awaiting|waits? on|requires? user|not yet|remains? blocked)\b/i.test(task.text);
  if (/\[blocked(?::|\])/i.test(task.text) && (!task.sourceChecked || explicitlyStillUnresolved)) {
    base.status = "blocked";
    base.blocker = normalize(task.text.match(/\[blocked[^\]]*\]/i)?.[0] || "Named source blocker");
    base.next = `Resolve or obtain authority for ${base.blocker}, record the resolution in ${planningArtifact(task, base.category)}, then proceed against ${base.artifact}.`;
  }
  const decisionsResolved =
    task.path === "reference/openspec/changes/production-grade-hosted-product/tasks.md" &&
    /\[decision:\s*[2345]\]/i.test(task.text);
  if (/\[decision:/i.test(task.text) && !decisionsResolved && (!task.sourceChecked || explicitlyStillUnresolved)) {
    base.status = "blocked";
    base.blocker = normalize(task.text.match(/\[decision:[^\]]*\]/i)?.[0] || "User decision");
    base.next = `Obtain ${base.blocker}, record the authorized choice in ${planningArtifact(task, base.category)}, then proceed against ${base.artifact}.`;
  }
  if (/\[in-progress: bounded first slice; no implementation claimed\]/i.test(task.text)) {
    base.status = "in_progress";
    base.evidence = "Bounded first slice selected in source; no implementation claimed.";
    base.next = `Produce only ${base.artifact}, update ${planningArtifact(task, base.category)}, and run ${base.command}.`;
  }

  if (
    task.path === "reference/openspec/changes/macos-clicky-parity-surface/tasks.md" &&
    /^1\.2\b/.test(task.text)
  ) {
    base.evidence =
      "Commit f6ec029f616cbedd48b9a50b20946639e34ae66c; Swift tests/static scan in that change; installed and dist executable SHA-256 624068bf65ae520bf695594591ea9791105d49faf08e6ec5b2cb7f57478ec4a2.";
    base.next =
      `Have an independent verifier inspect commit f6ec029f, run the non-privileged Swift/static checks, and attach the session-only token receipt to ${planningArtifact(task, base.category)}.`;
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
      `Have an independent verifier rerun the non-privileged source/binary scan and attach the persistence-pattern result to ${planningArtifact(task, base.category)}.`;
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
  const requiredProgressFields = [
    "category", "artifact", "inputs", "expected", "method", "command", "next", "acceptance",
  ];
  for (const field of requiredProgressFields) {
    if (!normalize(row[field])) throw new Error(`${row.id} lacks ${field}`);
  }
  if (!CATEGORY_RULES.some(([category]) => category === row.category) && row.category !== "unknown") {
    throw new Error(`${row.id} has invalid category ${row.category}`);
  }
  if (!/(?:\/|[\w-]\.[a-z0-9]+$)/i.test(row.artifact)) {
    throw new Error(`${row.id} lacks an actual or proposed repository artifact path`);
  }
  if (!row.inputs.includes(`${row.path}:${row.line}`) || !/scoped inputs\/entities:/i.test(row.inputs)) {
    throw new Error(`${row.id} lacks a concrete source/input boundary`);
  }
  if (!/\b(?:test -f|git diff --check|npm |node |swift |gradle|openspec |fabro |rg -n|bash |scripts\/|independent review:)/i.test(row.command)) {
    throw new Error(`${row.id} lacks an exact non-privileged command or named independent review`);
  }
  const normalizedRequirement = normalize(requirement).toLowerCase();
  for (const [field, value] of [["next action", row.next], ["acceptance", row.acceptance]]) {
    const normalizedValue = normalize(value).toLowerCase();
    if (normalizedRequirement.length >= 40 && normalizedValue.includes(normalizedRequirement)) {
      throw new Error(`${row.id} ${field} copies the requirement instead of designing progress`);
    }
  }
  if (row.category === "unknown") {
    if (!/acceptance-design\.md$/.test(row.artifact) || !/Category rationale/.test(row.command)) {
      throw new Error(`${row.id} unknown task lacks acceptance-design artifact/schema validation`);
    }
  }
  const categoryRequirements = {
    test_verification: /\b(?:test|verification|check|receipt|fixture|qa|smoke)\b/i,
    documentation_spec: /\b(?:document|review|diff|spec)\b/i,
    audit_inventory: /\b(?:inventory|audit|scan|review|check)\b/i,
    decision_design: /\b(?:decision|options|review|consequences)\b/i,
    deployment_release: /\b(?:release|deploy|promotion|rollout|check)\b/i,
    operations_observability: /\b(?:operations|monitor|metric|health|receipt|check)\b/i,
    research_evaluation: /\b(?:evaluation|research|options|review)\b/i,
    refactor_migration: /\b(?:migration|refactor|plan|check)\b/i,
    implementation_code: /\b(?:implementation|target|check|test|verification)\b/i,
  };
  if (row.category !== "unknown" && !categoryRequirements[row.category].test(`${row.artifact} ${row.expected} ${row.method}`)) {
    throw new Error(`${row.id} lacks category-specific progress design for ${row.category}`);
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

const templateMaximums = {};
for (const field of ["inputs", "expected", "method", "command", "next", "acceptance"]) {
  const frequency = new Map();
  for (const row of rows) {
    const value = normalize(row[field]).toLowerCase();
    frequency.set(value, (frequency.get(value) || 0) + 1);
  }
  const max = Math.max(...frequency.values());
  templateMaximums[field] = max;
  if (max > 3) {
    const [value] = [...frequency].find(([, count]) => count === max);
    throw new Error(`boilerplate repetition in ${field}: maximum duplicate frequency ${max}: ${value}`);
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
const categoryCounts = Object.fromEntries(
  [...CATEGORY_RULES.map(([category]) => category), "unknown"]
    .map((category) => [category, rows.filter((row) => row.category === category).length]),
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
  `Task-type counts: ${Object.entries(categoryCounts).map(([category, count]) => `${category}=${count}`).join("; ")}.`,
  "",
  "Only `verified_complete` counts as complete. A checked source box defaults to `implemented_unverified` until exact evidence and independent verification are registered.",
  "",
  "| Stable ID | Source | Source text | Task type | Status | Evidence | Independent verification | Next artifact | Inputs | Expected output or state | Verification method | Verification command or review | Smallest next action | Acceptance check | Blocker / authority | Duplicates |",
  "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
];
const table = rows.map((row) =>
  `| ${row.id} | ${escapeCell(`${row.path}:${row.line}`)} | ${escapeCell(row.text)} | ${row.category} | ${row.status} | ${escapeCell(row.evidence)} | ${escapeCell(row.independent)} | ${escapeCell(row.artifact)} | ${escapeCell(row.inputs)} | ${escapeCell(row.expected)} | ${escapeCell(row.method)} | ${escapeCell(row.command)} | ${escapeCell(row.next)} | ${escapeCell(row.acceptance)} | ${escapeCell(row.blocker)} | ${escapeCell(row.duplicates)} |`
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
    `incomplete rows have typed progress designs; verified_complete rows have evidence + independent verification\n` +
    `statuses ${Object.entries(counts).map(([key, value]) => `${key}=${value}`).join(" ")}\n` +
    `categories ${Object.entries(categoryCounts).map(([key, value]) => `${key}=${value}`).join(" ")}\n` +
    `maximum exact-template duplicates ${Object.entries(templateMaximums).map(([key, value]) => `${key}=${value}`).join(" ")}`,
  );
}
