import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const contentSource = readFileSync(new URL("../extension/content.js", import.meta.url), "utf8");
const backgroundSource = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
const steeringSource = readFileSync(new URL("../extension/steering-ui.js", import.meta.url), "utf8");
const context = vm.createContext({});
vm.runInContext(steeringSource, context);
const helpers = context.AgeeSteeringUi;

assert.equal(
  helpers.formatPageIdentity({ title: "Project board", hostname: "example.test", pathname: "/projects/7" }),
  "Project board · example.test/projects/7",
);
assert.equal(
  helpers.formatPageIdentity({ title: "", hostname: "example.test", pathname: "/" }),
  "example.test",
);
assert.ok(!helpers.formatPageIdentity({ title: "x".repeat(100), hostname: "example.test" }).includes("x".repeat(73)));

const oldTurn = {};
const replacementTurn = {};
let currentTurn = oldTurn;
const delayedSetup = Promise.resolve().then(() => helpers.isCurrentLiveVoiceState(oldTurn, currentTurn, () => true));
currentTurn = replacementTurn;
assert.equal(await delayedSetup, false);
assert.equal(helpers.isCurrentLiveVoiceState(replacementTurn, currentTurn, () => true), true);

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

assert.match(contentSource, /origin === "single"\) beginCurrentThreadSteeringCapture\(replacement\)/);
assert.match(contentSource, /if \(state\.assistantSpeechSuppressed\) return;/);
assert.match(contentSource, /replacement_kind = replacement\.kind/);
assert.match(contentSource, /message\.next_turn_id = replacement\.turnId/);
assert.match(contentSource, /message\.boundary_id = replacement\.boundaryId/);
assert.match(contentSource, /if \(!state\.voiceSessionId\) state\.pendingSteeringReplacement = replacement/);
assert.match(contentSource, /if \(state\.pendingSteeringReplacement\) sendLiveVoiceControl\(state, liveCancelTurnMessage\(state, 0, state\.pendingSteeringReplacement\)\)\.finally/);
assert.match(contentSource, /if \(state\.commitWhenReady\) commitLiveVoiceTurn\(state\)/);
assert.match(backgroundSource, /all_branches_context: false/);
assert.match(contentSource, /contextAction: state\.contextControls\.action/);
assert.match(backgroundSource, /options\.contextAction \? \{ context_action: options\.contextAction, all_branches_context: false \}/);
assert.match(backgroundSource, /files: \["ui-spec-runtime\.js", "steering-ui\.js", "document-context\.js", "content\.js"\]/);
assert.match(backgroundSource, /activeThreadBranch\(cfg\)/);
assert.doesNotMatch(contentSource, /agee-mode-select|data-agent-mode-control/);
assert.match(contentSource, /state\?\.steeredAtGeneration && state\.steeredAtGeneration <= steeringGeneration/);
assert.match(contentSource, /scheduleCueRetirement\(cueId\)/);
assert.match(steeringSource, /sendMessage\(\{ cmd: "history" \}\)/);

console.log("browser steering UI tests passed");
