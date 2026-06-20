#!/usr/bin/env node
"use strict";

// Smoke for the presentation evaluator brain. Proves the judge end to end with
// NO mic and NO network: a stub model stands in for the real provider, so this
// runs in `npm run check`. It asserts:
//
//   1. buildEvaluatorMessages embeds the deck, the transcript, and the rubric,
//      and switches shape between live and final modes.
//   2. parseFinal recovers scores from a fenced/messy JSON reply and recomputes
//      the weighted total from the rubric (the number can't drift).
//   3. parseLive accepts both JSON and a bare one-line nudge.
//   4. A full "session": feed sample turns through a stub model -> a verdict.

const assert = require("node:assert");
const path = require("node:path");

const {
  buildEvaluatorMessages,
  parseFinal,
  parseLive,
  computeWeighted,
  RUBRIC,
} = require(path.join(path.resolve(__dirname, ".."), "lib", "presentation-evaluator"));

// The real Moa pitch beats (ground truth the judge scores against).
const DECK = [
  "Map all the work you do in the browser. Moa runs it as agents you watch and steer.",
  "We open fifty tabs. Soon we run fifty agents.",
  "Agent sprawl: launch a second agent and you lose the first. No map, no memory.",
  "What one agent does: text/image/audio/video in, work in a tab, result out.",
  "Every agent is one thread of work. Moa keeps the map. Latest word wins.",
  "You steer it by talking. Each agent runs in its own background tab and pings you.",
  "It already runs: speak, build context, work in a tab, ping. Gateway live.",
  "You own it: self-hosted, yours to change, every device, any model.",
  "Who is building it: Natnael Kahssay, MIT, YC, Code Four.",
  "We used to manage tabs. Now Moa maps the work.",
];

const SAMPLE_TURNS = [
  { transcript: "Everyone here has fifty tabs open right now. Soon every one of those is an agent.", slide: 2 },
  { transcript: "The problem is you launch a second agent and lose the first. No map, no memory.", slide: 3 },
  { transcript: "Here it is running live. I speak, it builds context, it works in a background tab and pings me. The gateway is up at this IP, two hundred.", slide: 7 },
  { transcript: "The hard bet is the map: every thread of work, and the latest word wins when I change my mind.", slide: 5 },
  { transcript: "I left MIT, built Code Four through YC, building Moa next.", slide: 9 },
  { transcript: "We used to manage tabs. Now Moa maps the work.", slide: 10 },
];

function main() {
  // 1. message construction
  const finalMsgs = buildEvaluatorMessages({ deck: DECK, turns: SAMPLE_TURNS, mode: "final" });
  assert.equal(finalMsgs.length, 1, "one user message");
  const fc = finalMsgs[0].content;
  assert.ok(fc.includes("Moa maps the work"), "deck beat embedded");
  assert.ok(fc.includes("background tab and pings"), "transcript embedded");
  assert.ok(fc.includes("proof"), "rubric key embedded");
  assert.ok(fc.includes("STRICT JSON"), "final mode asks for json scorecard");

  const liveMsgs = buildEvaluatorMessages({ deck: DECK, turns: SAMPLE_TURNS.slice(0, 2), mode: "live", elapsedSec: 35 });
  assert.ok(liveMsgs[0].content.includes("LIVE"), "live mode flagged");
  assert.ok(liveMsgs[0].content.includes("35s into the pitch"), "elapsed time surfaced");
  assert.ok(!liveMsgs[0].content.includes("STRICT JSON"), "live mode is not the scorecard");

  // 2. final parse recovers messy JSON and recomputes the weighted total
  const messyReply = "Here's my call:\n```json\n" +
    JSON.stringify({
      scores: { hook: 8, problem: 9, proof: 9, bet: 7, why_you: 8, close: 9 },
      weighted: 999, // deliberately wrong — must be overridden by recompute
      will_win: true,
      verdict: "Strong, demo-led, the proof slide carries it.",
      biggest_fix: "Tighten the bet: say why the map is hard.",
    }) + "\n```\nGo win it.";
  const final = parseFinal(messyReply);
  assert.ok(final.ok, "final parsed");
  assert.equal(final.scores.proof, 9, "proof score recovered");
  const expected = computeWeighted(final.scores);
  assert.equal(final.weighted, expected, "weighted recomputed from rubric, not trusted from model");
  assert.notEqual(final.weighted, 999, "bogus model total discarded");
  assert.equal(final.will_win, final.weighted >= 70, "win flag derived from the real total");

  // weighted must honour the rubric weights (proof is the heaviest card)
  const proofHeavy = computeWeighted({ hook: 0, problem: 0, proof: 10, bet: 0, why_you: 0, close: 0 });
  const hookHeavy = computeWeighted({ hook: 10, problem: 0, proof: 0, bet: 0, why_you: 0, close: 0 });
  assert.ok(proofHeavy > hookHeavy, "proof weighted heavier than hook");

  // 3. live parse: json and bare line
  assert.deepEqual(
    parseLive('{"nudge":"Slow down and show the live demo now.","on_track":true}'),
    { ok: true, nudge: "Slow down and show the live demo now.", on_track: true }
  );
  const bare = parseLive("You buried the demo — show it before the bet.");
  assert.ok(bare.ok && bare.nudge.includes("show it"), "bare nudge accepted");

  // 4. full session through a stub model (no network)
  const stubModel = async (messages) => {
    assert.ok(messages[0].content.includes("background tab"), "model sees the transcript");
    return JSON.stringify({
      scores: { hook: 7, problem: 8, proof: 9, bet: 6, why_you: 7, close: 8 },
      will_win: true,
      verdict: "Demo-led and real. The map bet needs one more sentence of why-it's-hard.",
      biggest_fix: "Name the hard part of the work-graph out loud.",
    });
  };
  return runSession(stubModel).then((result) => {
    assert.ok(result.ok, "session produced a verdict");
    assert.ok(result.weighted >= 0 && result.weighted <= 100, "score in range");
    assert.ok(result.verdict.length > 0, "verdict present");
    console.log("smoke-presentation: OK");
    console.log(`  sample verdict -> ${result.weighted}/100, will_win=${result.will_win}`);
    console.log(`  "${result.verdict}"`);
  });
}

// Mirror what the gateway route will do: build messages, call the model, parse.
async function runSession(modelFn) {
  const messages = buildEvaluatorMessages({ deck: DECK, turns: SAMPLE_TURNS, mode: "final" });
  const reply = await modelFn(messages);
  return parseFinal(reply);
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
