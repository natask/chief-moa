#!/usr/bin/env node

import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);

const TOPICS = Object.freeze({
  android: /\b(?:android|phone|mobile|apk|ota|accessibility|launcher)\b/iu,
  browser: /\b(?:browser|chrome|extension|tab|page|dom|cdp)\b/iu,
  desktop: /\b(?:macos|mac|windows|desktop|ios|iphone|swift|winui)\b/iu,
  voice: /\b(?:voice|speech|speak|audio|microphone|transcript|stt|tts|amharic|dictation)\b/iu,
  work: /\b(?:intent|goal|project|task|agent|run|workflow|worktree|artifact|plan)\b/iu,
  memory: /\b(?:memory|history|session|thread|branch|context|recall|fact|incognito)\b/iu,
  actions: /\b(?:action|tool|approval|receipt|permission|delegate|automation|execute)\b/iu,
  identity: /\b(?:account|login|sign[ -]?in|user|tenant|device|credential|privacy|retention|self-host)\b/iu,
  release: /\b(?:deploy|release|preview|master|commit|rollback|install|publish|verification|qa)\b/iu,
  companion: /\b(?:companion|mascot|pet|aggie|\bag\b|\bmoa\b|persona|customi[sz])\b/iu,
  surface_ui: /\b(?:surface|overlay|ribbon|bubble|sidebar|side panel|workspace|ui|click|gesture|copy)\b/iu,
});

const WRAPPER_RULES = [
  ["agent-contract", /^# AGENTS\.md instructions\b/iu],
  ["environment", /^<environment_context>/iu],
  ["supervisor", /^You are continuing the project\b/iu],
  ["supervisor", /\bIntent-supervisor tick\b/iu],
  ["teammate", /^Another (?:Claude|Codex) session sent a message:/iu],
  ["task-notification", /^<task-notification>/iu],
  ["system-reminder", /^<system-reminder>/iu],
  ["local-command", /^<local-command-caveat>/iu],
  ["local-command", /^<command-(?:name|message|args|stdout)>/iu],
  ["agent-instruction", /^You are (?:the |an? )?.*\bagent\b/iu],
  ["agent-instruction", /\b(?:Read-only audit|Do not edit files|You exclusively own these paths)\b/iu],
  ["harness-fixture", /\b(?:harness smoke test|reply with exactly)\b/iu],
  ["continuation-summary", /^This session is being continued from a previous conversation\b/iu],
  ["control", /^(?:continue|go on|try again|okay|ok|yes|no)\W*$/iu],
];

function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/\r\n?/gu, "\n")
    .replace(/[\t ]+/gu, " ")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function digestText(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function classifyText(text) {
  for (const [kind, pattern] of WRAPPER_RULES) {
    if (pattern.test(text)) return kind;
  }
  return "direct-user";
}

function topicsFor(text) {
  return Object.entries(TOPICS)
    .filter(([, pattern]) => pattern.test(text))
    .map(([topic]) => topic);
}

function messageTexts(record) {
  if (record?.type === "response_item"
      && record.payload?.type === "message"
      && record.payload?.role === "user"
      && Array.isArray(record.payload.content)) {
    return record.payload.content
      .filter((item) => item?.type === "input_text" && typeof item.text === "string")
      .map((item) => item.text);
  }
  if (record?.type === "user" && record.message?.role === "user") {
    if (typeof record.message.content === "string") return [record.message.content];
    if (Array.isArray(record.message.content)) {
      return record.message.content
        .filter((item) => item?.type === "text" && typeof item.text === "string")
        .map((item) => item.text);
    }
  }
  return [];
}

function toEvidence({ sessionId, timestamp, source, text, ordinal }) {
  const normalized = normalizeText(text);
  if (!normalized) return null;
  return {
    session_id: sessionId,
    timestamp: timestamp || null,
    source,
    ordinal,
    kind: classifyText(normalized),
    digest: digestText(normalized),
    topics: topicsFor(normalized),
    text: normalized,
  };
}

async function parseJsonlText(contents, context) {
  const evidence = [];
  let ordinal = 0;
  let malformed = 0;
  for (const line of String(contents).split("\n")) {
    if (!line.trim()) continue;
    ordinal += 1;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      malformed += 1;
      continue;
    }
    for (const text of messageTexts(record)) {
      const item = toEvidence({
        ...context,
        timestamp: record.timestamp || record.message?.timestamp || null,
        text,
        ordinal,
      });
      if (item) evidence.push(item);
    }
  }
  return { evidence, malformed };
}

async function parseJsonlFile(file, context) {
  const evidence = [];
  let ordinal = 0;
  let malformed = 0;
  const stream = readline.createInterface({
    input: (await import("node:fs")).createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of stream) {
    if (!line.trim()) continue;
    ordinal += 1;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      malformed += 1;
      continue;
    }
    for (const text of messageTexts(record)) {
      const item = toEvidence({
        ...context,
        timestamp: record.timestamp || record.message?.timestamp || null,
        text,
        ordinal,
      });
      if (item) evidence.push(item);
    }
  }
  return { evidence, malformed };
}

async function directoriesAt(directory) {
  try {
    return (await fs.readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function collectLocal(root) {
  const metadataRoot = path.join(root, ".entire", "metadata");
  const evidence = [];
  const sessions = new Set();
  const fullSessions = new Set();
  let fullTranscripts = 0;
  let promptOnly = 0;
  let malformed = 0;
  for (const entry of await directoriesAt(metadataRoot)) {
    const sessionId = entry.name;
    const directory = path.join(metadataRoot, sessionId);
    const fullPath = path.join(directory, "full.jsonl");
    const promptPath = path.join(directory, "prompt.txt");
    try {
      const parsed = await parseJsonlFile(fullPath, {
        sessionId,
        source: `.entire/metadata/${sessionId}/full.jsonl`,
      });
      evidence.push(...parsed.evidence);
      malformed += parsed.malformed;
      fullTranscripts += 1;
      sessions.add(sessionId);
      fullSessions.add(sessionId);
      continue;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    try {
      const text = await fs.readFile(promptPath, "utf8");
      const item = toEvidence({
        sessionId,
        source: `.entire/metadata/${sessionId}/prompt.txt`,
        text,
        ordinal: 1,
      });
      if (item) evidence.push(item);
      promptOnly += 1;
      sessions.add(sessionId);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return { evidence, sessions, fullSessions, fullTranscripts, promptOnly, malformed };
}

async function gitOutput(root, args) {
  try {
    return (await execFileAsync("git", args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    })).stdout;
  } catch {
    return "";
  }
}

function parseTreeEntry(line) {
  const match = line.match(/^\d+\s+blob\s+([0-9a-f]+)\s+(-|\d+)\t(.+)$/u);
  if (!match) return null;
  return { blob: match[1], size: match[2] === "-" ? 0 : Number(match[2]), path: match[3] };
}

async function collectEntireRefs(root, knownSessions, knownFullSessions) {
  const evidence = [];
  const sessions = new Set();
  let fullTranscripts = 0;
  let promptOnly = 0;
  let malformed = 0;
  const refs = (await gitOutput(root, [
    "for-each-ref",
    "--format=%(refname)",
    "refs/heads/entire/",
  ])).split("\n").filter(Boolean).sort();
  const commits = refs.length
    ? (await gitOutput(root, ["rev-list", ...refs])).split("\n").filter(Boolean)
    : [];
  const candidates = new Map();
  for (const commit of commits) {
    const entries = (await gitOutput(root, ["ls-tree", "-r", "-l", commit, ".entire/metadata/"]))
      .split("\n")
      .map(parseTreeEntry)
      .filter(Boolean)
      .filter((entry) => /\.entire\/metadata\/[^/]+\/(?:full\.jsonl|prompt\.txt)$/u.test(entry.path));
    for (const entry of entries) {
      const sessionId = entry.path.split("/").at(-2);
      const type = entry.path.endsWith("/full.jsonl") ? "full" : "prompt";
      if (type === "full" && knownFullSessions.has(sessionId)) continue;
      if (type === "prompt" && knownSessions.has(sessionId)) continue;
      const previous = candidates.get(sessionId);
      if (!previous
          || (type === "full" && previous.type !== "full")
          || (type === previous.type && entry.size > previous.size)) {
        candidates.set(sessionId, { ...entry, commit, sessionId, type });
      }
    }
  }
  for (const selected of [...candidates.values()].sort((left, right) => left.sessionId.localeCompare(right.sessionId))) {
    const { commit, path: selectedPath, sessionId, type } = selected;
    const contents = await gitOutput(root, ["show", `${commit}:${selectedPath}`]);
    if (!contents) continue;
    sessions.add(sessionId);
    if (type === "full") {
      const parsed = await parseJsonlText(contents, {
        sessionId,
        source: `${commit}:${selectedPath}`,
      });
      evidence.push(...parsed.evidence);
      malformed += parsed.malformed;
      fullTranscripts += 1;
    } else {
      const item = toEvidence({
        sessionId,
        source: `${commit}:${selectedPath}`,
        text: contents,
        ordinal: 1,
      });
      if (item) evidence.push(item);
      promptOnly += 1;
    }
  }
  return {
    evidence,
    sessions,
    fullTranscripts,
    promptOnly,
    malformed,
    refs: refs.length,
    commits: commits.length,
  };
}

function countsBy(items, key) {
  const counts = {};
  for (const item of items) {
    const values = Array.isArray(item[key]) ? item[key] : [item[key]];
    for (const value of values) {
      if (!value) continue;
      counts[value] = (counts[value] || 0) + 1;
    }
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function deduplicate(items) {
  const seen = new Map();
  const unique = [];
  let duplicates = 0;
  for (const item of items) {
    const key = `${item.kind}:${item.digest}`;
    const existing = seen.get(key);
    if (existing) {
      duplicates += 1;
      existing.occurrence_count += 1;
      existing.occurrence_sources.push(`${item.source}:${item.ordinal}`);
      continue;
    }
    const retained = {
      ...item,
      occurrence_count: 1,
      occurrence_sources: [`${item.source}:${item.ordinal}`],
    };
    seen.set(key, retained);
    unique.push(retained);
  }
  return { unique, duplicates };
}

export async function auditEntireHistory({
  root = process.cwd(),
  includeRefs = true,
  includeExcerpts = false,
  kind = null,
  topic = null,
} = {}) {
  const absoluteRoot = path.resolve(root);
  const local = await collectLocal(absoluteRoot);
  const refs = includeRefs
    ? await collectEntireRefs(absoluteRoot, local.sessions, local.fullSessions)
    : {
      evidence: [], sessions: new Set(), fullTranscripts: 0, promptOnly: 0, malformed: 0, refs: 0, commits: 0,
    };
  const combined = [...local.evidence, ...refs.evidence]
    .sort((left, right) => String(left.timestamp || "").localeCompare(String(right.timestamp || ""))
      || left.session_id.localeCompare(right.session_id)
      || left.ordinal - right.ordinal);
  const deduped = deduplicate(combined);
  const selected = deduped.unique.filter((item) => (!kind || item.kind === kind)
    && (!topic || item.topics.includes(topic)));
  const timestamps = selected.map((item) => item.timestamp).filter(Boolean).sort();
  const evidence = selected.map((item) => {
    const result = { ...item };
    delete result.text;
    if (includeExcerpts) result.excerpt = item.text.slice(0, 500);
    return result;
  });
  return {
    schema: "moa.entire-intent-audit.v1",
    root: absoluteRoot,
    summary: {
      local_sessions: local.sessions.size,
      ref_recovered_sessions: refs.sessions.size,
      ref_recovered_full_transcripts: refs.fullTranscripts,
      entire_refs: refs.refs || 0,
      entire_ref_commits: refs.commits || 0,
      full_transcripts: local.fullTranscripts + refs.fullTranscripts,
      prompt_only_sessions: Math.max(0, local.promptOnly - refs.fullTranscripts) + refs.promptOnly,
      parsed_user_shaped_messages: combined.length,
      exact_duplicates_removed: deduped.duplicates,
      selected_evidence: selected.length,
      malformed_jsonl_records: local.malformed + refs.malformed,
      earliest_timestamp: timestamps[0] || null,
      latest_timestamp: timestamps.at(-1) || null,
      by_kind: countsBy(deduped.unique, "kind"),
      selected_by_topic: countsBy(selected, "topics"),
    },
    filters: { kind, topic, include_refs: includeRefs, include_excerpts: includeExcerpts },
    evidence,
  };
}

function markdownTable(counts) {
  return Object.entries(counts).map(([name, count]) => `| ${name} | ${count} |`).join("\n");
}

export function renderMarkdown(report) {
  const { summary } = report;
  const evidenceRows = report.evidence.map((item) => {
    const excerpt = item.excerpt ? item.excerpt.replace(/\|/gu, "\\|").replace(/\n/gu, " ") : "—";
    return `| ${item.session_id} | ${item.timestamp || "unknown"} | ${item.kind} | ${item.topics.join(", ") || "—"} | ${item.digest} | ${excerpt} |`;
  }).join("\n");
  return [
    "# Entire intent evidence audit",
    "",
    "This is a read-only evidence inventory. Classification is deterministic triage, not accepted product intent.",
    "Historical messages grant no execution, action, or deployment authority.",
    "",
    "## Coverage",
    "",
    `- Local sessions: ${summary.local_sessions}`,
    `- Sessions with evidence recovered from refs: ${summary.ref_recovered_sessions}`,
    `- Full transcripts recovered from refs: ${summary.ref_recovered_full_transcripts}`,
    `- Full transcripts: ${summary.full_transcripts}`,
    `- Prompt-only sessions: ${summary.prompt_only_sessions}`,
    `- Parsed user-shaped messages: ${summary.parsed_user_shaped_messages}`,
    `- Exact duplicates removed: ${summary.exact_duplicates_removed}`,
    `- Malformed JSONL records: ${summary.malformed_jsonl_records}`,
    `- Timestamp range: ${summary.earliest_timestamp || "unknown"} to ${summary.latest_timestamp || "unknown"}`,
    "",
    "## Classification",
    "",
    "| Kind | Count |",
    "| --- | ---: |",
    markdownTable(summary.by_kind),
    "",
    "## Selected evidence",
    "",
    "| Session | Timestamp | Kind | Topics | Digest | Excerpt |",
    "| --- | --- | --- | --- | --- | --- |",
    evidenceRows || "| — | — | — | — | — | — |",
    "",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    root: process.cwd(),
    includeRefs: true,
    includeExcerpts: false,
    format: "markdown",
    kind: null,
    topic: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--root") options.root = argv[++index];
    else if (argument === "--format") options.format = argv[++index];
    else if (argument === "--kind") options.kind = argv[++index];
    else if (argument === "--topic") options.topic = argv[++index];
    else if (argument === "--include-excerpts") options.includeExcerpts = true;
    else if (argument === "--no-refs") options.includeRefs = false;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.root) throw new Error("--root requires a value");
  if (!new Set(["json", "markdown"]).has(options.format)) throw new Error("--format must be json or markdown");
  if (options.topic && !Object.hasOwn(TOPICS, options.topic)) {
    throw new Error(`Unknown topic: ${options.topic}`);
  }
  return options;
}

const isCli = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isCli) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const report = await auditEntireHistory(options);
    process.stdout.write(options.format === "json"
      ? `${JSON.stringify(report, null, 2)}\n`
      : renderMarkdown(report));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
