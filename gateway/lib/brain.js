"use strict";

// The Brain: a thin, fail-soft client over the installed `gbrain` CLI.
//
// Scope is MEMORY ONLY. The Brain accumulates durable facts about the user
// (name, preferences, persona) and a record of what tasks accomplished, so the
// Steward (gateway) can recall them before it answers or acts. It is NOT the
// operational store: agent-run state, run status, and the config-the-infra-reads
// (voice/persona profile) stay in their existing flat-file / profile stores. We
// only ever WRITE memories here and READ them back.
//
// Supported gbrain interface (verified against gbrain 0.42.x):
//   - write:  `gbrain put <slug> --content <markdown-with-frontmatter>`
//   - read:   `gbrain query <question> --limit N` (hybrid recall)
// Brain location is isolated via the GBRAIN_HOME env var (when set, the whole
// `.gbrain` directory IS that path) so tests never touch the real ~/.gbrain.
//
// FAIL SOFT: if gbrain is absent or errors, we log a warning and return an empty
// result / false. A memory miss must NEVER break a chat or voice turn.

const { spawnSync } = require("node:child_process");

const DEFAULT_BIN = process.env.GBRAIN_BIN || "gbrain";
const DEFAULT_RECALL_LIMIT = Number(process.env.BRAIN_RECALL_LIMIT || 5);
const SPAWN_TIMEOUT_MS = Number(process.env.BRAIN_TIMEOUT_MS || 15000);
// Slug prefix keeps Moa's memories in their own namespace inside the brain so
// they are easy to explore and never collide with other gbrain sources.
const SLUG_PREFIX = process.env.BRAIN_SLUG_PREFIX || "moa/memory";

function createBrain(options = {}) {
  const bin = options.bin || DEFAULT_BIN;
  // gbrainHome lets a caller (and the smoke test) point at a throwaway brain.
  // When set, it is exported as GBRAIN_HOME for every spawned gbrain call, so
  // the real ~/.gbrain is never touched.
  const gbrainHome = options.gbrainHome || process.env.GBRAIN_HOME || "";
  const recallLimit = Number(options.recallLimit || DEFAULT_RECALL_LIMIT);
  const log = options.log || defaultLog;

  function childEnv() {
    const env = { ...process.env };
    if (gbrainHome) {
      env.GBRAIN_HOME = gbrainHome;
    }
    return env;
  }

  function run(args) {
    const result = spawnSync(bin, args, {
      encoding: "utf8",
      timeout: SPAWN_TIMEOUT_MS,
      env: childEnv(),
      // No stdin; never inherit, so a hang can't block a turn.
      stdio: ["ignore", "pipe", "pipe"],
    });
    return result;
  }

  // Write a memory. `text` is the durable fact/persona/work statement; `meta`
  // carries optional { kind, tags, slug, title } to organize it. Returns true on
  // success, false on any failure (logged, never thrown).
  function remember(text, meta = {}) {
    const body = String(text || "").trim();
    if (!body) {
      return false;
    }
    const slug = buildSlug(meta.slug, meta.kind);
    const content = buildPageContent(body, meta);
    try {
      const result = run(["put", slug, "--content", content]);
      if (result.error || result.status !== 0) {
        log("warn", `brain.remember failed: ${describeFailure(result)}`);
        return false;
      }
      return true;
    } catch (error) {
      log("warn", `brain.remember threw: ${cleanError(error)}`);
      return false;
    }
  }

  // Recall memories relevant to `query`. Returns an array of
  // { slug, snippet, score } (possibly empty). Never throws.
  function recall(query, limit = recallLimit) {
    const question = String(query || "").trim();
    if (!question) {
      return [];
    }
    const max = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.round(Number(limit)) : recallLimit;
    try {
      const result = run(["query", question, "--limit", String(max), "--no-expand"]);
      if (result.error || result.status !== 0) {
        log("warn", `brain.recall failed: ${describeFailure(result)}`);
        return [];
      }
      return parseRecallOutput(result.stdout, max);
    } catch (error) {
      log("warn", `brain.recall threw: ${cleanError(error)}`);
      return [];
    }
  }

  // Pull the user's STANDING facts (name, preferences, persona) deterministically
  // via tag, independent of the turn's wording. These are the facts the Steward
  // should know on EVERY turn. Returns [{ slug, snippet }] (snippet = the page
  // title, which for standing facts IS the fact). Never throws.
  function recallStandingFacts(limit = recallLimit) {
    const max = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.round(Number(limit)) : recallLimit;
    try {
      const result = run(["list", "--tag", "standing", "--limit", String(max), "--sort", "updated_desc"]);
      if (result.error || result.status !== 0) {
        log("warn", `brain.recallStandingFacts failed: ${describeFailure(result)}`);
        return [];
      }
      return parseListOutput(result.stdout, max);
    } catch (error) {
      log("warn", `brain.recallStandingFacts threw: ${cleanError(error)}`);
      return [];
    }
  }

  // Record what a task/agent run accomplished as an explorable memory.
  function rememberWorkDone(summary, meta = {}) {
    const body = String(summary || "").trim();
    if (!body) {
      return false;
    }
    return remember(body, {
      ...meta,
      kind: "work",
      tags: ["memory", "work-done"].concat(Array.isArray(meta.tags) ? meta.tags : []),
      title: meta.title || "Task done",
    });
  }

  // Probe whether the gbrain binary is callable at all. Used by the smoke test
  // and health surfaces; not on the hot path.
  function available() {
    try {
      const result = run(["--help"]);
      return !result.error && result.status === 0;
    } catch {
      return false;
    }
  }

  return {
    remember,
    recall,
    recallStandingFacts,
    rememberWorkDone,
    available,
    slugPrefix: SLUG_PREFIX,
    gbrainHome,
  };
}

// Build a unique, namespaced slug. Memories are append-style: each write gets a
// fresh slug so we never clobber an earlier fact.
function buildSlug(explicit, kind) {
  if (explicit && typeof explicit === "string" && explicit.trim()) {
    return sanitizeSlug(explicit.trim());
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = Math.random().toString(36).slice(2, 8);
  const part = String(kind || "note");
  // Sanitize the WHOLE slug (lowercases the ISO timestamp's T/Z) so gbrain's
  // post-write tag step finds the page it just created.
  return sanitizeSlug(`${SLUG_PREFIX}/${part}-${stamp}-${rand}`);
}

function sanitizeSlug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 120) || "note";
}

// gbrain pages are fat-markdown with YAML frontmatter. Keep it minimal and
// deterministic; the body is the recallable text.
function buildPageContent(body, meta) {
  const tags = Array.isArray(meta.tags) && meta.tags.length
    ? meta.tags
    : ["memory"];
  const title = String(meta.title || firstLine(body) || "Memory").slice(0, 80);
  const lines = [
    "---",
    "type: note",
    `title: ${yamlScalar(title)}`,
    "tags:",
    ...tags.map((tag) => `  - ${yamlScalar(String(tag))}`),
    "---",
    "",
    body,
    "",
  ];
  return lines.join("\n");
}

// Parse `gbrain query` stdout lines of the form:
//   [0.4659] moa/memory/note-... -- The user wants to be called Bob.
// Tolerant of formatting drift: any line with a slug and a snippet is captured.
function parseRecallOutput(stdout, max) {
  const out = [];
  const lines = String(stdout || "").split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const match = line.match(/^\[(-?\d+(?:\.\d+)?)\]\s+(\S+)\s+--\s+(.*)$/);
    if (match) {
      out.push({
        score: Number(match[1]),
        slug: match[2],
        snippet: match[3].trim(),
      });
      continue;
    }
    // Fallback: a "slug -- snippet" line with no score.
    const loose = line.match(/^(\S+)\s+--\s+(.*)$/);
    if (loose) {
      out.push({ score: null, slug: loose[1], snippet: loose[2].trim() });
    }
  }
  return out.slice(0, max);
}

// Parse `gbrain list` stdout lines of the form (tab-separated):
//   slug \t type \t YYYY-MM-DD \t title
// For standing facts the title IS the stored fact, so we surface it as snippet.
function parseListOutput(stdout, max) {
  const out = [];
  const lines = String(stdout || "").split("\n");
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim()) continue;
    const cols = line.split("\t");
    if (cols.length >= 4) {
      const slug = cols[0].trim();
      const title = cols.slice(3).join("\t").trim();
      if (slug && title) {
        out.push({ slug, snippet: title, score: null });
      }
    }
  }
  return out.slice(0, max);
}

function firstLine(text) {
  return String(text || "").split("\n").map((l) => l.trim()).find(Boolean) || "";
}

function yamlScalar(value) {
  const v = String(value);
  // Quote if it contains YAML-significant characters.
  if (/[:#\[\]{}&*!|>'"%@`]/.test(v) || /^\s|\s$/.test(v)) {
    return JSON.stringify(v);
  }
  return v;
}

function describeFailure(result) {
  if (!result) return "no result";
  if (result.error) return cleanError(result.error);
  const stderr = String(result.stderr || "").trim();
  const stdout = String(result.stdout || "").trim();
  const detail = stderr || stdout || "(no output)";
  return `exit ${result.status}: ${detail.slice(0, 300)}`;
}

function cleanError(error) {
  if (error && error.code === "ENOENT") {
    return "gbrain binary not found on PATH (install gbrain to enable the Brain)";
  }
  return String(error?.message || error || "unknown error").slice(0, 300);
}

function defaultLog(level, message) {
  // Memory is best-effort; surface as a warning, never raise. No secrets are
  // logged here -- only the user-authored memory text the caller passed.
  const line = `[brain] ${message}`;
  if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

module.exports = { createBrain };
