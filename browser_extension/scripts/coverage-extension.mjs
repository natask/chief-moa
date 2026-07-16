import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import coverageLibrary from "istanbul-lib-coverage";
import instrumentLibrary from "istanbul-lib-instrument";
import {
  EXCLUDED_SOURCE_FILES,
  RUNTIME_SOURCE_FILES,
  validateProductionSourceClassification,
} from "./extension-production-sources.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const { createCoverageMap } = coverageLibrary;
const { createInstrumenter } = instrumentLibrary;
validateProductionSourceClassification(root);

const testFiles = readdirSync(join(root, "scripts"))
  .filter((name) => /^test-.*\.mjs$/.test(name))
  .sort()
  .map((name) => `scripts/${name}`);
if (testFiles.length === 0) throw new Error("coverage requires at least one unit test file");

const temporary = mkdtempSync(join(tmpdir(), "agee-extension-coverage-"));
const reportDirectory = join(temporary, "report");
const c8Entry = join(root, "node_modules", "c8", "bin", "c8.js");
const run = spawnSync(process.execPath, [
  c8Entry,
  "--reporter=json",
  `--reports-dir=${reportDirectory}`,
  "--include=extension/**/*.js",
  "--exclude=extension/vendor/**",
  "--exclude=extension/dev.js",
  process.execPath,
  "--test",
  ...testFiles,
], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

process.stdout.write(run.stdout || "");
process.stderr.write(run.stderr || "");
if (run.status !== 0) {
  rmSync(temporary, { recursive: true, force: true });
  throw new Error(`coverage unit tests failed with exit code ${run.status}`);
}

const executedRaw = JSON.parse(readFileSync(join(reportDirectory, "coverage-final.json"), "utf8"));
const executedByPath = new Map(
  Object.entries(executedRaw).map(([path, coverage]) => [resolve(path), coverage]),
);
const coverageMap = createCoverageMap({});
const executionKinds = new Map();

for (const relative of RUNTIME_SOURCE_FILES) {
  const absolute = resolve(root, relative);
  const executed = executedByPath.get(absolute);
  if (executed) {
    coverageMap.addFileCoverage(executed);
    executionKinds.set(relative, "v8");
    continue;
  }

  const instrumenter = createInstrumenter({ compact: true, esModules: true });
  instrumenter.instrumentSync(readFileSync(absolute, "utf8"), absolute);
  const staticZero = instrumenter.lastFileCoverage();
  if (!staticZero) throw new Error(`eligible source is absent from coverage metadata: ${relative}`);
  coverageMap.addFileCoverage(staticZero);
  executionKinds.set(relative, "static-zero");
}

const metadataFiles = new Set(coverageMap.files().map((path) => resolve(path)));
const absent = RUNTIME_SOURCE_FILES.filter((file) => !metadataFiles.has(resolve(root, file)));
if (absent.length) throw new Error(`eligible sources absent from coverage metadata: ${absent.join(", ")}`);
for (const excluded of Object.keys(EXCLUDED_SOURCE_FILES)) {
  if (metadataFiles.has(resolve(root, excluded))) {
    throw new Error(`excluded source leaked into production coverage: ${excluded}`);
  }
}

const summary = coverageMap.getCoverageSummary();
const metrics = Object.fromEntries(
  ["lines", "branches", "functions"].map((name) => [name, {
    covered: summary[name].covered,
    total: summary[name].total,
    pct: Number(summary[name].pct),
  }]),
);
const ratchet = JSON.parse(readFileSync(join(root, "scripts", "coverage-ratchet.json"), "utf8"));
const failures = [];
const focusedThresholds = new Map([
  ["extension/browser-agent-loop-policy.js", 90],
  ["extension/browser-turn-protocol.js", 90],
  ["extension/options.js", 90],
  ["extension/tweaks.js", 90],
  ["extension/livekit-voice.js", 90],
  ["extension/offscreen-audio-worklet.js", 90],
  ["extension/voice-capture-gesture.js", 90],
  ["extension/voice-draft-protocol.js", 90],
  ["extension/ui-spec-runtime.js", 90],
  ["extension/offscreen-livekit.js", 90],
  ["extension/offscreen.js", 90],
  ["extension/sidepanel.js", 90],
  ["extension/page-observation-runtime.js", 90],
  ["extension/content-voice-policy-runtime.js", 90],
  ["extension/content-companion-policy-runtime.js", 90],
  ["extension/content-extension-api-runtime.js", 90],
  ["extension/content-context-control-runtime.js", 90],
  ["extension/content-note-controller-runtime.js", 90],
]);
const focusedResults = [];
for (const [relative, minimum] of focusedThresholds) {
  const focused = coverageMap.fileCoverageFor(resolve(root, relative)).toSummary();
  const result = Object.fromEntries(
    ["lines", "branches", "functions"].map((name) => [name, Number(focused[name].pct)]),
  );
  focusedResults.push({ relative, minimum, result });
  for (const name of ["lines", "branches", "functions"]) {
    if (result[name] + 0.005 < minimum) {
      failures.push(`${relative} ${name} ${result[name].toFixed(2)}% is below focused gate ${minimum}%`);
    }
  }
}
for (const name of ["lines", "branches", "functions"]) {
  const minimum = Number(ratchet.minimum_percent?.[name]);
  if (!Number.isFinite(minimum)) failures.push(`${name} ratchet is not numeric`);
  else if (metrics[name].pct + 0.005 < minimum) {
    failures.push(`${name} ${metrics[name].pct.toFixed(2)}% is below ratchet ${minimum.toFixed(2)}%`);
  }
}

const executedCount = [...executionKinds.values()].filter((kind) => kind === "v8").length;
console.log("production extension coverage (vendor, UI markup/styles, tests, and dev tooling excluded)");
for (const name of ["lines", "branches", "functions"]) {
  const metric = metrics[name];
  console.log(`  ${name}: ${metric.pct.toFixed(2)}% (${metric.covered}/${metric.total})`);
}
console.log(`  V8-executed sources: ${executedCount}/${RUNTIME_SOURCE_FILES.length}; conservative zero metadata: ${RUNTIME_SOURCE_FILES.length - executedCount}`);
for (const { relative, minimum, result } of focusedResults) {
  console.log(`  focused ${relative}: ${result.lines.toFixed(2)}% lines, ${result.branches.toFixed(2)}% branches, ${result.functions.toFixed(2)}% functions (gate ${minimum}%)`);
}
console.log(`  goal: ${Number(ratchet.goal_percent).toFixed(0)}%; current ratchet: ${JSON.stringify(ratchet.minimum_percent)}`);

rmSync(temporary, { recursive: true, force: true });
if (failures.length) throw new Error(`coverage ratchet failed: ${failures.join("; ")}`);
