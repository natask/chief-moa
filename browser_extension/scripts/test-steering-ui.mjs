import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const contentSource = readFileSync(new URL("../extension/content.js", import.meta.url), "utf8");
const backgroundSource = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");

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
  "normalizeRoutingContext",
  "projectSessionLanes",
  "routingReceiptText",
  "selectedBranchRouting",
];
const helperSource = helperNames.map((name) => extractFunction(contentSource, name)).join("\n");
const context = vm.createContext({
  STEERING_BOUNDARY_MARKER: "— steered here; prior response stopped —",
  ROUTING_ACTIONS: new Set(["continue", "new", "fork", "incognito"]),
});
vm.runInContext(`${helperSource}\nglobalThis.helpers = { formatPageIdentity, formatSteeredAssistantText, normalizeRoutingContext, projectSessionLanes, routingReceiptText, selectedBranchRouting };`, context);
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

const projected = helpers.projectSessionLanes([
  { cueId: "main-1", context: { action: "continue", branch_id: "main", thread_label: "Main", persisted: true } },
  { cueId: "fork-1", context: { action: "fork", branch_id: "fork-a", thread_label: "Research", persisted: true } },
  { cueId: "fork-2", context: { action: "continue", branch_id: "fork-a", thread_label: "Research", persisted: true } },
], "main");
assert.deepEqual(JSON.parse(JSON.stringify(projected.visibleCardIds)), ["main-1"]);
assert.equal(projected.lanes.length, 2);
assert.equal(projected.lanes.find((lane) => lane.id === "main").current, true);
assert.deepEqual(JSON.parse(JSON.stringify(projected.lanes.find((lane) => lane.id === "fork-a").cardIds)), ["fork-1", "fork-2"]);
assert.equal(helpers.normalizeRoutingContext({ action: "new" }).action, "new");
assert.equal(helpers.normalizeRoutingContext({ action: "fork" }).action, "fork");
assert.equal(helpers.routingReceiptText({ action: "continue", thread_label: "Main" }), "Continued · Main");
assert.equal(helpers.routingReceiptText({ action: "new" }), "New thread");
assert.equal(helpers.routingReceiptText({ action: "fork" }), "Forked");
assert.deepEqual(
  JSON.parse(JSON.stringify(helpers.selectedBranchRouting({ action: "" }, "branch-main"))),
  { contextAction: "continue", branchId: "branch-main" },
);
assert.deepEqual(
  JSON.parse(JSON.stringify(helpers.selectedBranchRouting({ action: "new" }, "branch-main"))),
  { contextAction: "new", branchId: "" },
);
assert.deepEqual(
  JSON.parse(JSON.stringify(helpers.selectedBranchRouting({ action: "incognito" }, "branch-main"))),
  { contextAction: "incognito", branchId: "" },
);

assert.match(contentSource, /origin === "single"\) beginCurrentThreadSteeringCapture\(\)/);
assert.match(contentSource, /if \(state\.assistantSpeechSuppressed\) return;/);
assert.match(contentSource, /sendLiveVoiceControl\(state, liveCancelTurnMessage\(state,/);
assert.match(contentSource, /state\?\.steeredAtGeneration && state\.steeredAtGeneration <= steeringGeneration/);
assert.doesNotMatch(contentSource, /scheduleCueRetirement\(cueId\)/);
assert.match(contentSource, /lane\.timeline\.appendChild\(card\)/);
assert.match(contentSource, /if \(msg\.context\) applyCueRoutingContext\(msg\.cueId, msg\.context\)/);
assert.match(backgroundSource, /context: browserContextReceipt\(data\)/);
assert.match(backgroundSource, /context_action: contextAction/);
assert.match(contentSource, /branchId: branchRouting\.branchId/);
assert.match(backgroundSource, /branch_id: branchId \|\| cueId/);
assert.match(contentSource, /const branchRouting = selectedBranchRouting\(context, selectedLaneId\);[\s\S]*?cmd: "voiceSessionStart"[\s\S]*?branchId: branchRouting\.branchId/);
assert.match(backgroundSource, /const branchBound = Boolean\(String\(opts\.branchId \|\| ""\)\.trim\(\)\);/);
assert.match(backgroundSource, /const threadSwitchBound = \["new", "fork", "incognito"\]\.includes\(contextAction\);/);
assert.match(backgroundSource, /if \(!branchBound && !threadSwitchBound && tabId !== PANEL_TAB_ID && await isLivekitVoiceEnabled\(\)\)/);
assert.match(backgroundSource, /let branchForSession = String\(branchId \|\| ""\)\.trim\(\) \|\| cueId;/);
assert.ok((backgroundSource.match(/branchId: msg\.branchId/g) || []).length >= 2);
assert.match(contentSource, /safeRuntimeSendMessage\(\{ cmd: "history" \}\)/);

console.log("browser steering UI tests passed");
