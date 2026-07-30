#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const SKIP_DIRECTORIES = new Set([
  ".claude",
  ".codex",
  ".context",
  ".entire",
  ".git",
  ".gradle",
  ".idea",
  ".pnpm-store",
  "build",
  "dist",
  "node_modules",
  ".worktrees",
]);

const DEFAULT_DECOMMISSIONED_HOSTS = ["10.147.17.10"];
const SUCCESSOR_LABELS = ["successor", "superseded by", "replaced by"];
const AUTHORITY_PATTERNS = [
  /\bsource of truth\b/giu,
  /\bmaster record\b/giu,
  /\bcurrent (?:product|architecture|documentation|system) authority\b/giu,
  /\bcanonical (?:product|architecture|documentation|system) (?:record|authority)\b/giu,
  /\bauthoritative (?:product|architecture|documentation|system) (?:record|source|authority)\b/giu,
];

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function relativePath(root, absolutePath) {
  const relative = path.relative(root, absolutePath);
  return relative ? toPosix(relative) : ".";
}

async function walkMarkdown(root) {
  const files = [];

  async function walk(directory) {
    if (directory !== root) {
      try {
        await fs.lstat(path.join(directory, ".git"));
        return;
      } catch {
        // This is part of the current checkout rather than a nested checkout.
      }
    }
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) files.push(absolute);
    }
  }

  await walk(root);
  return files;
}

function lineNumberAt(text, index) {
  let lines = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (text.charCodeAt(cursor) === 10) lines += 1;
  }
  return lines;
}

function normalizeLinkDestination(raw) {
  let destination = raw.trim();
  if (destination.startsWith("<")) {
    const end = destination.indexOf(">");
    destination = end === -1 ? destination.slice(1) : destination.slice(1, end);
  } else {
    destination = destination.split(/\s+["']/u, 1)[0];
  }
  return destination;
}

function markdownLinks(text) {
  const links = [];
  const inlineStart = /(?<!!)\[[^\]]*\]\(/gu;
  const definitions = /^\s{0,3}\[[^\]]+\]:\s*(\S+)/gmu;
  for (const match of text.matchAll(inlineStart)) {
    const destinationStart = match.index + match[0].length;
    let depth = 1;
    let escaped = false;
    let cursor = destinationStart;
    for (; cursor < text.length; cursor += 1) {
      const character = text[cursor];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      if (character === "(") depth += 1;
      else if (character === ")") depth -= 1;
      if (depth === 0) break;
    }
    if (depth !== 0) continue;
    links.push({
      destination: normalizeLinkDestination(text.slice(destinationStart, cursor)),
      line: lineNumberAt(text, match.index),
    });
  }
  for (const match of text.matchAll(definitions)) {
    links.push({ destination: normalizeLinkDestination(match[1]), line: lineNumberAt(text, match.index) });
  }
  return links;
}

function withoutFencedCode(text) {
  let inFence = false;
  return text.split("\n").map((line) => {
    if (/^\s{0,3}(?:```|~~~)/u.test(line)) {
      inFence = !inFence;
      return "";
    }
    return inFence ? "" : line;
  }).join("\n");
}

function localDestination(destination, sourceFile, root) {
  if (!destination || destination.startsWith("#")) return null;
  if (/^(?:https?:|mailto:|tel:|data:|javascript:)/iu.test(destination)) return null;
  const withoutFragment = destination.split(/[?#]/u, 1)[0];
  if (!withoutFragment) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(withoutFragment);
  } catch {
    decoded = withoutFragment;
  }
  const absolute = path.isAbsolute(decoded)
    ? path.resolve(decoded)
    : path.resolve(path.dirname(sourceFile), decoded);
  const relative = path.relative(root, absolute);
  const outside = relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  const display = outside
    ? toPosix(absolute)
    : relativePath(root, absolute);
  return { absolute, display, outside };
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

async function resolveMarkdownTarget(absolute, { root, realRoot, allowDirectory }) {
  if (!isInside(root, absolute)) return { path: null, status: "outside-repository-lexical" };
  const candidates = [absolute];
  if (!path.extname(absolute)) candidates.push(`${absolute}.md`, path.join(absolute, "README.md"));
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      const realCandidate = await fs.realpath(candidate);
      if (!isInside(realRoot, realCandidate)) return { path: null, status: "outside-repository-realpath" };
      if (stat.isFile()) return { path: realCandidate, status: "valid-file" };
      if (stat.isDirectory()) {
        const readme = path.join(candidate, "README.md");
        try {
          if ((await fs.stat(readme)).isFile()) {
            const realReadme = await fs.realpath(readme);
            if (!isInside(realRoot, realReadme)) return { path: null, status: "outside-repository-realpath" };
            return { path: realReadme, status: "valid-file" };
          }
        } catch {
          return allowDirectory
            ? { path: realCandidate, status: "valid-directory" }
            : { path: null, status: "directory-without-readme" };
        }
      }
    } catch {
      // Continue through the bounded resolution candidates.
    }
  }
  return { path: null, status: "missing" };
}

function authorityClaims(text, file) {
  const claims = [];
  for (const pattern of AUTHORITY_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      claims.push({ phrase: match[0].toLowerCase(), file, line: lineNumberAt(text, match.index) });
    }
  }
  return claims;
}

function successorMetadata(text, file) {
  const results = [];
  const lines = text.split("\n");
  let inFence = false;
  for (let index = 0; index < Math.min(lines.length, 80); index += 1) {
    const line = lines[index];
    if (/^\s{0,3}(?:```|~~~)/u.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    for (const label of SUCCESSOR_LABELS) {
      const expression = new RegExp(`^\\s*(?:[-*>]\\s*)?(?:\\*\\*)?${label}(?:\\*\\*)?\\s*:\\s*(.+)$`, "iu");
      const match = line.match(expression);
      if (!match) continue;
      const linked = markdownLinks(match[1]);
      results.push({
        file,
        line: index + 1,
        label,
        declared: match[1].trim(),
        destination: linked[0]?.destination ?? null,
      });
    }
  }
  return results;
}

function openspecProgress(text) {
  const checkboxes = [...text.matchAll(/^\s*-\s*\[([ xX])\]/gmu)];
  const total = checkboxes.length;
  const completed = checkboxes.filter((match) => match[1].toLowerCase() === "x").length;
  return { completed, total };
}

async function openspecCandidates(root) {
  const changesRoot = path.join(root, "reference", "openspec", "changes");
  let entries;
  try {
    entries = await fs.readdir(changesRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const candidates = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.name === "archive") continue;
    const taskFile = path.join(changesRoot, entry.name, "tasks.md");
    let text;
    try {
      text = await fs.readFile(taskFile, "utf8");
    } catch {
      candidates.push({ change: entry.name, status: "active", completed: 0, total: 0, reason: "no tasks.md" });
      continue;
    }
    const progress = openspecProgress(text);
    const complete = progress.total > 0 && progress.completed === progress.total;
    candidates.push({
      change: entry.name,
      status: complete ? "completed-candidate" : "active",
      ...progress,
      reason: complete ? "all task checkboxes are complete" : "unchecked or absent task checkboxes remain",
    });
  }
  return candidates;
}

export async function auditDocumentation({
  root = process.cwd(),
  decommissionedHosts = DEFAULT_DECOMMISSIONED_HOSTS,
} = {}) {
  const absoluteRoot = await fs.realpath(path.resolve(root));
  const realRoot = absoluteRoot;
  const markdownFiles = await walkMarkdown(absoluteRoot);
  const documents = new Map();
  for (const absolute of markdownFiles) {
    documents.set(absolute, {
      absolute,
      file: relativePath(absoluteRoot, absolute),
      text: await fs.readFile(absolute, "utf8"),
      incoming: [],
    });
  }

  const brokenLinks = [];
  const staleHosts = [];
  const claims = [];
  const successors = [];
  for (const document of documents.values()) {
    const prose = withoutFencedCode(document.text);
    claims.push(...authorityClaims(prose, document.file));
    successors.push(...successorMetadata(document.text, document.file));
    for (const host of decommissionedHosts) {
      const escaped = host.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      for (const match of document.text.matchAll(new RegExp(escaped, "gu"))) {
        staleHosts.push({ host, file: document.file, line: lineNumberAt(document.text, match.index) });
      }
    }
    for (const link of markdownLinks(prose)) {
      const local = localDestination(link.destination, document.absolute, absoluteRoot);
      if (!local) continue;
      const resolution = local.outside
        ? { path: null, status: "outside-repository-lexical" }
        : await resolveMarkdownTarget(local.absolute, { root: absoluteRoot, realRoot, allowDirectory: true });
      if (!resolution.path) {
        brokenLinks.push({
          source: document.file,
          line: link.line,
          destination: link.destination,
          resolved: local.display,
          reason: resolution.status,
        });
        continue;
      }
      const target = documents.get(resolution.path);
      if (target) target.incoming.push({ source: document.file, line: link.line });
    }
  }

  const incomingLinks = [...documents.values()].map(({ file, incoming }) => ({
    file,
    incoming: incoming.sort((left, right) => left.source.localeCompare(right.source) || left.line - right.line),
  }));
  incomingLinks.sort((left, right) => right.incoming.length - left.incoming.length || left.file.localeCompare(right.file));

  const claimsByPhrase = new Map();
  for (const claim of claims) {
    const group = claimsByPhrase.get(claim.phrase) ?? [];
    group.push(claim);
    claimsByPhrase.set(claim.phrase, group);
  }
  const duplicateAuthorityPhraseMentions = [...claimsByPhrase.entries()]
    .filter(([, occurrences]) => new Set(occurrences.map(({ file }) => file)).size > 1)
    .map(([phrase, occurrences]) => ({ phrase, occurrences }))
    .sort((left, right) => left.phrase.localeCompare(right.phrase));

  for (const successor of successors) {
    if (!successor.destination) {
      successor.status = "unparseable";
      successor.resolved = null;
      continue;
    }
    const source = documents.get(path.join(absoluteRoot, successor.file));
    const local = localDestination(successor.destination, source.absolute, absoluteRoot);
    const resolution = !local
      ? { path: null, status: "not-local" }
      : local.outside
        ? { path: null, status: "outside-repository-lexical" }
        : await resolveMarkdownTarget(local.absolute, { root: absoluteRoot, realRoot, allowDirectory: false });
    if (resolution.path === source.absolute) {
      successor.status = "self-successor";
      successor.resolved = successor.file;
    } else if (resolution.path && resolution.path.toLowerCase().endsWith(".md")) {
      successor.status = "valid";
      successor.resolved = relativePath(absoluteRoot, resolution.path);
    } else {
      successor.status = resolution.path ? "successor-not-markdown" : resolution.status;
      successor.resolved = resolution.path ? relativePath(absoluteRoot, resolution.path) : local?.display ?? null;
    }
  }

  const openspec = await openspecCandidates(absoluteRoot);
  const archiveCandidates = [
    ...openspec.filter(({ status }) => status === "completed-candidate").map(({ change, reason }) => ({
      kind: "openspec-change",
      path: `reference/openspec/changes/${change}`,
      reason,
    })),
    ...successors.filter(({ status }) => status === "valid").map(({ file, resolved }) => ({
      kind: "superseded-document",
      path: file,
      reason: `declares successor ${resolved}`,
    })),
  ];

  return {
    root: absoluteRoot,
    summary: {
      markdownDocuments: documents.size,
      localIncomingLinks: incomingLinks.reduce((sum, document) => sum + document.incoming.length, 0),
      unlinkedDocuments: incomingLinks.filter(({ incoming }) => incoming.length === 0).length,
      duplicateAuthorityPhraseGroups: duplicateAuthorityPhraseMentions.length,
      brokenLocalLinks: brokenLinks.length,
      decommissionedHostMentions: staleHosts.length,
      activeOpenSpecChanges: openspec.filter(({ status }) => status === "active").length,
      completedOpenSpecCandidates: openspec.filter(({ status }) => status === "completed-candidate").length,
      successorDeclarations: successors.length,
      archiveCandidates: archiveCandidates.length,
    },
    incomingLinks,
    duplicateAuthorityPhraseMentions,
    staleReferences: {
      brokenLocalLinks: brokenLinks.sort((left, right) => left.source.localeCompare(right.source) || left.line - right.line),
      decommissionedHosts: staleHosts.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line),
    },
    openspec,
    successorMetadata: successors.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line),
    archiveCandidates,
  };
}

function markdownTable(headers, rows) {
  if (rows.length === 0) return "_None found._";
  const escape = (value) => String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
  return [
    `| ${headers.map(escape).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(escape).join(" | ")} |`),
  ].join("\n");
}

export function renderMarkdown(report) {
  const linked = report.incomingLinks.filter(({ incoming }) => incoming.length > 0);
  const unlinked = report.incomingLinks.filter(({ incoming }) => incoming.length === 0);
  const active = report.openspec.filter(({ status }) => status === "active");
  const completed = report.openspec.filter(({ status }) => status === "completed-candidate");
  return `# Documentation authority audit

This is a read-only inventory. A candidate is not permission to move, archive,
or delete anything. Review useful facts and incoming links before changing a file.

## Summary

${markdownTable(["Measure", "Count"], Object.entries(report.summary))}

## Incoming Markdown links

${markdownTable(["Document", "Incoming links", "Sources"], linked.map(({ file, incoming }) => [file, incoming.length, incoming.map(({ source, line }) => `${source}:${line}`).join("<br>")]))}

### Documents with no incoming Markdown link

${unlinked.map(({ file }) => `- \`${file}\``).join("\n") || "_None found._"}

## Duplicate authority phrase mentions

These are raw phrase mentions. They are a review queue, not proof that two
documents claim authority over the same scope.

${markdownTable(["Phrase", "Occurrences"], report.duplicateAuthorityPhraseMentions.map(({ phrase, occurrences }) => [phrase, occurrences.map(({ file, line }) => `${file}:${line}`).join("<br>")]))}

## Stale references

### Broken local Markdown paths

${markdownTable(["Source", "Declared", "Resolved as", "Reason"], report.staleReferences.brokenLocalLinks.map(({ source, line, destination, resolved, reason }) => [`${source}:${line}`, destination, resolved, reason]))}

### Decommissioned hosts

${markdownTable(["Host", "Location"], report.staleReferences.decommissionedHosts.map(({ host, file, line }) => [host, `${file}:${line}`]))}

## OpenSpec state candidates

### Active

${markdownTable(["Change", "Completed", "Total", "Reason"], active.map(({ change, completed: done, total, reason }) => [change, done, total, reason]))}

### Completed candidates still under changes

${markdownTable(["Change", "Completed", "Total", "Reason"], completed.map(({ change, completed: done, total, reason }) => [change, done, total, reason]))}

## Successor metadata

Recognized forms are \`Successor:\`, \`Superseded by:\`, and \`Replaced by:\`
when followed by a Markdown link.

${markdownTable(["Document", "Declaration", "Status", "Resolved successor"], report.successorMetadata.map(({ file, line, label, status, resolved }) => [`${file}:${line}`, label, status, resolved ?? "—"]))}

## Archive candidates for human review

${markdownTable(["Kind", "Path", "Reason"], report.archiveCandidates.map(({ kind, path: candidatePath, reason }) => [kind, candidatePath, reason]))}
`;
}

function parseArguments(argv) {
  const options = { root: process.cwd(), format: "markdown", decommissionedHosts: [...DEFAULT_DECOMMISSIONED_HOSTS] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--root") options.root = argv[++index];
    else if (argument === "--format") options.format = argv[++index];
    else if (argument === "--decommissioned-host") options.decommissionedHosts.push(argv[++index]);
    else if (argument === "--help") options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.root) throw new Error("--root requires a directory");
  if (!new Set(["json", "markdown"]).has(options.format)) throw new Error("--format must be json or markdown");
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write("Usage: node scripts/docs/authority-audit.mjs [--root DIR] [--format markdown|json] [--decommissioned-host HOST]\n");
    return;
  }
  const report = await auditDocumentation(options);
  process.stdout.write(options.format === "json" ? `${JSON.stringify(report, null, 2)}\n` : renderMarkdown(report));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
