import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const contentSource = readFileSync(new URL("../extension/content.js", import.meta.url), "utf8");

function extractFunction(source, name) {
  const signature = `function ${name}(`;
  const start = source.indexOf(signature);
  if (start === -1) throw new Error(`could not find function ${name} in content.js`);
  const bodyMarker = source.indexOf(") {", start);
  const braceOpen = bodyMarker === -1 ? -1 : bodyMarker + 2;
  if (braceOpen === -1) throw new Error(`could not find body for ${name}`);
  let depth = 0;
  for (let index = braceOpen; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

const helperNames = [
  "compactPageIdentityPart",
  "formatPageIdentity",
  "formatSteeredAssistantText",
  "selectResolvedCueIds",
];
const helperSource = helperNames.map((name) => extractFunction(contentSource, name)).join("\n");
const context = vm.createContext({ STEERING_BOUNDARY_MARKER: "— steered here; prior response stopped —" });
vm.runInContext(`${helperSource}\nglobalThis.helpers = { formatPageIdentity, formatSteeredAssistantText, selectResolvedCueIds };`, context);
const { helpers } = context;

assert.equal(
  helpers.formatPageIdentity({ title: "Project board", hostname: "example.test", pathname: "/projects/7" }),
  "Project board · example.test/projects/7",
);
assert.equal(
  helpers.formatPageIdentity({ title: "", hostname: "example.test", pathname: "/" }),
  "example.test",
);
assert.ok(!helpers.formatPageIdentity({ title: "x".repeat(100), hostname: "example.test" }).includes("x".repeat(73)));

const marker = "— steered here; prior response stopped —";
assert.equal(
  helpers.formatSteeredAssistantText("First sentence. Second sentence.", "First sentence."),
  `First sentence.\n\n${marker}\n\nSecond sentence.`,
);
assert.equal(
  helpers.formatSteeredAssistantText("The whole later reply", ""),
  `${marker}\n\nThe whole later reply`,
);
assert.equal(
  helpers.formatSteeredAssistantText("A replacement chunk", "Already visible"),
  `Already visible\n\n${marker}\n\nA replacement chunk`,
);

assert.deepEqual(
  [...helpers.selectResolvedCueIds([
    { id: "done-1", active: false },
    { id: "running", active: true },
    { id: "steered", active: false, protected: true },
    { id: "done-2", active: false },
  ])],
  ["done-1", "done-2"],
);

assert.match(contentSource, /origin === "single"\) beginCurrentThreadSteeringCapture\(\)/);
assert.match(contentSource, /if \(state\.assistantSpeechSuppressed\) return;/);
assert.match(contentSource, /sendLiveVoiceControl\(state, liveCancelTurnMessage\(state,/);
assert.match(contentSource, /state\?\.steeredAtGeneration && state\.steeredAtGeneration <= steeringGeneration/);
assert.match(contentSource, /scheduleCueRetirement\(cueId\)/);
assert.match(contentSource, /safeRuntimeSendMessage\(\{ cmd: "history" \}\)/);

console.log("browser steering UI tests passed");
