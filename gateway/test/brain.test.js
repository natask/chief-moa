"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createBrain } = require("../lib/brain");

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "brain-unit-"));
}

function missingBin(root) {
  return path.join(root, "definitely-missing-gbrain");
}

function createFakeBin(root, mode = "success") {
  const bin = path.join(root, `fake-gbrain-${mode}`);
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (process.env.BRAIN_FAKE_LOG) fs.appendFileSync(process.env.BRAIN_FAKE_LOG, JSON.stringify({ args, home: process.env.GBRAIN_HOME || "" }) + "\\n");
if (args[0] === "--help") process.exit(0);
if (${JSON.stringify(mode)} === "silent-fail") process.exit(9);
if (${JSON.stringify(mode)} === "fail") { process.stderr.write("command failed safely"); process.exit(7); }
if (${JSON.stringify(mode)} === "stdout-fail") { process.stdout.write("stdout failure"); process.exit(8); }
if (args[0] === "query") {
  process.stdout.write("[0.75] moa/memory/one -- First memory\\nmoa/memory/two -- Second memory\\ninvalid line\\n[-0.25] moa/memory/three -- Third memory\\n");
  process.exit(0);
}
if (args[0] === "list") {
  process.stdout.write("moa/memory/standing-one\\tnote\\t2026-01-01\\tUser likes tea\\r\\ninvalid\\nmoa/memory/standing-two\\tnote\\t2026-01-02\\tTitle\\twith tab\\n\\tbad\\tdate\\t\\n");
  process.exit(0);
}
process.exit(0);
`;
  fs.writeFileSync(bin, source, { mode: 0o755 });
  return bin;
}

function withEnv(patch, action) {
  const before = {};
  for (const [key, value] of Object.entries(patch)) {
    before[key] = process.env[key];
    if (value == null) delete process.env[key]; else process.env[key] = value;
  }
  try { return action(); }
  finally {
    for (const [key, value] of Object.entries(before)) {
      if (value == null) delete process.env[key]; else process.env[key] = value;
    }
  }
}

test("file fallback remembers, ranks, and returns standing facts without touching gbrain", () => {
  const root = tempRoot();
  try {
    const logs = [];
    const brain = createBrain({ bin: missingBin(root), storeDir: path.join(root, "store"), recallLimit: 3, log: (...args) => logs.push(args) });
    assert.equal(brain.mode(), "file");
    assert.equal(brain.mode(), "file", "availability probe is memoized");
    assert.equal(brain.available(), false);
    assert.equal(brain.remember("  "), false);
    assert.equal(brain.remember(null), false);
    assert.deepEqual(brain.recall(" "), []);
    assert.deepEqual(brain.recall(null), []);
    assert.deepEqual(brain.recall("a to"), []);
    assert.deepEqual(brain.recallStandingFacts(4), []);

    assert.equal(brain.remember("The user likes green tea.", {
      slug: " Custom Slug!* ", kind: "preference", tags: ["memory", "standing"], title: "Tea preference",
    }), true);
    assert.equal(brain.remember("Tea setup notes and kettle details.", { kind: "note", tags: ["memory"] }), true);
    assert.equal(brain.remember("The user likes coffee too.", { tags: ["standing"] }), true);
    assert.equal(brain.remember("First line title\nsecond line", { tags: "not-an-array" }), true);

    const records = fs.readFileSync(brain.factsFile, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(records[0].slug, "custom-slug");
    assert.equal(records[0].kind, "preference");
    assert.deepEqual(records[3].tags, ["memory"]);
    assert.equal(records[3].title, "First line title");
    assert.match(records[1].slug, /^moa\/memory\/note-/);

    const recalled = brain.recall("green tea kettle", 2);
    assert.equal(recalled.length, 2);
    assert.equal(recalled[0].score >= recalled[1].score, true);
    assert.match(recalled[0].snippet, /tea/i);
    assert.equal(brain.recall("coffee", Infinity).length, 1);
    const standing = brain.recallStandingFacts("bad");
    assert.equal(standing.length, 2);
    assert.match(standing[0].snippet, /coffee/i);
    assert.deepEqual(logs, []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("file fallback skips corrupt records and bounds work-done metadata", () => {
  const root = tempRoot();
  try {
    const brain = createBrain({ bin: missingBin(root), storeDir: root, recallLimit: 2, log: () => {} });
    fs.writeFileSync(brain.factsFile, "not-json\n");
    assert.equal(brain.rememberWorkDone(" "), false);
    assert.equal(brain.rememberWorkDone(null), false);
    assert.equal(brain.rememberWorkDone("Completed the release task", { tags: ["release"], title: "" }), true);
    assert.equal(brain.rememberWorkDone("Second task", { tags: "bad" }), true);
    const rows = fs.readFileSync(brain.factsFile, "utf8").split("\n").filter(Boolean);
    assert.equal(rows.length, 3);
    const first = JSON.parse(rows[1]);
    assert.deepEqual(first.tags, ["memory", "work-done", "release"]);
    assert.equal(first.title, "Task done");
    assert.equal(brain.recall("release task", 0).length, 2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("file write failures are logged and remain fail-soft", () => {
  const root = tempRoot();
  try {
    const blocker = path.join(root, "not-a-directory");
    fs.writeFileSync(blocker, "file");
    const logs = [];
    const brain = createBrain({ bin: missingBin(root), storeDir: blocker, log: (level, message) => logs.push({ level, message }) });
    assert.equal(brain.remember("A fact"), false);
    assert.equal(logs[0].level, "warn");
    assert.match(logs[0].message, /brain\.remember \(file\) failed/);
    assert.deepEqual(brain.recall("fact"), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("gbrain mode writes deterministic pages and parses query and list output", () => {
  const root = tempRoot();
  const logFile = path.join(root, "calls.jsonl");
  try {
    withEnv({ BRAIN_FAKE_LOG: logFile }, () => {
      const brain = createBrain({ bin: createFakeBin(root), gbrainHome: path.join(root, "home"), recallLimit: 5, log: () => {} });
      assert.equal(brain.mode(), "gbrain");
      assert.equal(brain.available(), true);
      assert.equal(brain.remember("Body text", {
        slug: "Moa/Memory/Explicit", title: "Title: quoted", tags: ["memory", "standing"],
      }), true);
      assert.equal(brain.remember("first useful line\nmore", { slug: "!!!", tags: [] }), true);
      const recalled = brain.recall("question", 2);
      assert.deepEqual(recalled, [
        { score: 0.75, slug: "moa/memory/one", snippet: "First memory" },
        { score: null, slug: "moa/memory/two", snippet: "Second memory" },
      ]);
      assert.equal(brain.recall("question", "bad").length, 3);
      assert.deepEqual(brain.recallStandingFacts(1), [
        { slug: "moa/memory/standing-one", snippet: "User likes tea", score: null },
      ]);
      assert.equal(brain.recallStandingFacts(5)[1].snippet, "Title\twith tab");
      assert.equal(brain.rememberWorkDone("Shipped it", { slug: "work/one" }), true);

      const calls = fs.readFileSync(logFile, "utf8").trim().split("\n").map(JSON.parse);
      assert.ok(calls.every((call) => call.home === path.join(root, "home")));
      const firstPut = calls.find((call) => call.args[0] === "put");
      assert.equal(firstPut.args[1], "moa/memory/explicit");
      assert.match(firstPut.args[3], /title: "Title: quoted"/);
      assert.match(firstPut.args[3], /  - memory\n  - standing/);
      const notePut = calls.filter((call) => call.args[0] === "put")[1];
      assert.equal(notePut.args[1], "note");
      assert.match(notePut.args[3], /title: first useful line/);
      assert.ok(calls.some((call) => call.args.join(" ").includes("--no-expand")));
      assert.ok(calls.some((call) => call.args.join(" ").includes("updated_desc")));
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("gbrain command failures expose stderr or stdout and never throw", () => {
  for (const mode of ["fail", "stdout-fail", "silent-fail"]) {
    const root = tempRoot();
    try {
      const logs = [];
      const brain = createBrain({ bin: createFakeBin(root, mode), storeDir: path.join(root, "store"), log: (level, message) => logs.push({ level, message }) });
      assert.equal(brain.mode(), "gbrain");
      assert.equal(brain.remember("Fact"), false);
      assert.deepEqual(brain.recall("Fact"), []);
      assert.deepEqual(brain.recallStandingFacts(), []);
      assert.equal(logs.length, 3);
      assert.ok(logs.every((row) => row.level === "warn" && /exit [789]/.test(row.message)));
      assert.match(logs[0].message, mode === "fail" ? /command failed safely/ : mode === "stdout-fail" ? /stdout failure/ : /\(no output\)/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test("a binary disappearing after a successful probe reports ENOENT fail-soft", () => {
  for (const operation of ["remember", "recall", "standing"]) {
    const root = tempRoot();
    try {
      const logs = [];
      const bin = createFakeBin(root);
      const brain = createBrain({ bin, log: (level, message) => logs.push({ level, message }) });
      assert.equal(brain.mode(), "gbrain");
      fs.unlinkSync(bin);
      const result = operation === "remember" ? brain.remember("Fact")
        : operation === "recall" ? brain.recall("Fact")
          : brain.recallStandingFacts();
      assert.deepEqual(result, operation === "remember" ? false : []);
      assert.match(logs[0].message, /gbrain binary not found on PATH/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test("availability catches invalid executable values and default logger warns safely", () => {
  const root = tempRoot();
  const warnings = [];
  const originalWarn = console.warn;
  try {
    const brain = createBrain({ bin: Symbol("invalid"), storeDir: path.join(root, "store"), log: () => {} });
    assert.equal(brain.available(), false);
    assert.equal(brain.mode(), "file");

    console.warn = (line) => warnings.push(line);
    const failing = createBrain({ bin: createFakeBin(root, "fail") });
    assert.equal(failing.remember("Fact"), false);
    assert.match(warnings[0], /^\[brain\] brain\.remember failed:/);
  } finally {
    console.warn = originalWarn;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("unexpected spawn throws are caught independently by every memory operation", () => {
  const childProcess = require("node:child_process");
  const modulePath = require.resolve("../lib/brain");
  const originalSpawnSync = childProcess.spawnSync;
  try {
    for (const operation of ["remember", "recall", "standing"]) {
      let calls = 0;
      childProcess.spawnSync = () => {
        calls += 1;
        if (calls === 1) return { status: 0, error: null, stdout: "", stderr: "" };
        throw new Error(`${operation} spawn threw`);
      };
      delete require.cache[modulePath];
      const { createBrain: createThrowingBrain } = require("../lib/brain");
      const logs = [];
      const brain = createThrowingBrain({ bin: "fake", log: (level, message) => logs.push({ level, message }) });
      assert.equal(brain.mode(), "gbrain");
      const result = operation === "remember" ? brain.remember("Fact")
        : operation === "recall" ? brain.recall("Fact")
          : brain.recallStandingFacts();
      assert.deepEqual(result, operation === "remember" ? false : []);
      assert.match(logs[0].message, new RegExp(`${operation === "standing" ? "recallStandingFacts" : operation} threw`));
      assert.match(logs[0].message, /spawn threw/);
    }
  } finally {
    childProcess.spawnSync = originalSpawnSync;
    delete require.cache[modulePath];
  }
});

test("legacy file rows and empty CLI stdout retain safe recall fallbacks", () => {
  const root = tempRoot();
  try {
    const fileBrain = createBrain({ bin: missingBin(root), storeDir: root, log: () => {} });
    fs.writeFileSync(fileBrain.factsFile, [
      JSON.stringify({ slug: "standing-text", title: "", text: "Standing text fallback", tags: ["standing"] }),
      JSON.stringify({ slug: "title-only", title: "Matching title", text: "", tags: ["memory"] }),
      JSON.stringify({ slug: "empty", tags: ["memory"] }),
      "",
    ].join("\n"));
    assert.equal(fileBrain.recallStandingFacts()[0].snippet, "Standing text fallback");
    assert.equal(fileBrain.recall("matching")[0].snippet, "Matching title");
    assert.deepEqual(fileBrain.recall("absent"), []);

    const childProcess = require("node:child_process");
    const modulePath = require.resolve("../lib/brain");
    const originalSpawnSync = childProcess.spawnSync;
    childProcess.spawnSync = () => ({ status: 0, error: null, stdout: undefined, stderr: undefined });
    delete require.cache[modulePath];
    const { createBrain: createEmptyOutputBrain } = require("../lib/brain");
    const cliBrain = createEmptyOutputBrain({ bin: "fake", log: () => {} });
    assert.equal(cliBrain.mode(), "gbrain");
    assert.deepEqual(cliBrain.recall("question"), []);
    assert.deepEqual(cliBrain.recallStandingFacts(), []);
    childProcess.spawnSync = originalSpawnSync;
    delete require.cache[modulePath];
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("default binary selection and non-Error throws remain fail-soft", () => {
  const root = tempRoot();
  const childProcess = require("node:child_process");
  const modulePath = require.resolve("../lib/brain");
  const originalSpawnSync = childProcess.spawnSync;
  try {
    const defaulted = createBrain({ bin: "", storeDir: path.join(root, "store"), log: () => {} });
    assert.equal(["gbrain", "file"].includes(defaulted.mode()), true);

    for (const thrown of ["string failure", null]) {
      let calls = 0;
      childProcess.spawnSync = () => {
        calls += 1;
        if (calls === 1) return { status: 0, error: null };
        throw thrown;
      };
      delete require.cache[modulePath];
      const { createBrain: createOddFailureBrain } = require("../lib/brain");
      const logs = [];
      const brain = createOddFailureBrain({ bin: "fake", log: (_level, message) => logs.push(message) });
      assert.equal(brain.mode(), "gbrain");
      assert.equal(brain.remember("Fact"), false);
      assert.match(logs[0], thrown === null ? /unknown error/ : /string failure/);
    }
  } finally {
    childProcess.spawnSync = originalSpawnSync;
    delete require.cache[modulePath];
    fs.rmSync(root, { recursive: true, force: true });
  }
});
