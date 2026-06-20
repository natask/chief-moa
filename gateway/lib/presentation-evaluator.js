"use strict";

// Presentation evaluator — the brain behind "record me presenting and judge it."
//
// A presentation session captures spoken turns (the gemini-live voice session
// transcribes each utterance and stores it under one session_id) and, when
// available, the deck beats and slide the speaker is on. This module turns that
// running record into a judgement. It is pure: it builds the model messages and
// parses the reply. The server injects the real model call; the smoke injects a
// stub. No network here, so it stays unit-testable.
//
// Two modes:
//   live  — one short nudge the speaker can act on WHILE presenting.
//   final — full scorecard + a straight "will you win" verdict at the end.

// What hackathon judges actually weight. Order is the order a pitch should hit
// them in. Weights sum to 100; the final score is their weighted average.
const RUBRIC = [
  { key: "hook", label: "Hook", weight: 15, ask: "First ~10 seconds. Do I lean in or check my phone?" },
  { key: "problem", label: "Problem", weight: 20, ask: "Is the pain sharp, real, and felt by the audience?" },
  { key: "proof", label: "Proof it runs", weight: 25, ask: "Did they SHOW it working, not just claim it? Highest-weight card." },
  { key: "bet", label: "The bet", weight: 20, ask: "Is the hard, differentiated idea clear and believable?" },
  { key: "why_you", label: "Why you", weight: 10, ask: "Credibility in ~10 seconds, no longer." },
  { key: "close", label: "Close", weight: 10, ask: "One line that sticks after they sit down." },
];

const RUBRIC_KEYS = RUBRIC.map((r) => r.key);

// Render the deck beats as ground truth so the judge scores delivery against
// what the slides actually promise, not against a guess.
function renderDeck(deck) {
  if (!Array.isArray(deck) || deck.length === 0) {
    return "(deck beats not provided — judge on the transcript alone.)";
  }
  return deck
    .map((beat, i) => `  ${String(i + 1).padStart(2, "0")}. ${String(beat).trim()}`)
    .join("\n");
}

// Flatten the captured turns into a plain transcript with running marks.
function renderTranscript(turns) {
  if (!Array.isArray(turns) || turns.length === 0) {
    return "(nothing captured yet.)";
  }
  return turns
    .map((t, i) => {
      const said = String(t.transcript || t.text || "").trim();
      if (!said) return null;
      const slide = t.slide != null ? ` [slide ${t.slide}]` : "";
      return `  ${String(i + 1).padStart(3, "0")}${slide}: ${said}`;
    })
    .filter(Boolean)
    .join("\n");
}

const RUBRIC_BLOCK = RUBRIC.map(
  (r) => `  - ${r.key} (${r.label}, ${r.weight}%): ${r.ask}`
).join("\n");

// Build the messages for the model. Returns the chat `messages` array the
// gateway's callModel expects (the system prompt is applied by the caller).
function buildEvaluatorMessages({ deck, turns, mode = "final", elapsedSec } = {}) {
  const isLive = mode === "live";
  const elapsed = Number.isFinite(elapsedSec) ? `${Math.round(elapsedSec)}s into the pitch. ` : "";

  const shared = `You are a blunt hackathon judge scoring a live pitch. No flattery, no hedging.

The deck the speaker is presenting (ground truth):
${renderDeck(deck)}

What they have said so far (live transcript):
${renderTranscript(turns)}

Score against these six criteria:
${RUBRIC_BLOCK}`;

  const liveAsk = `${shared}

${elapsed}Mode: LIVE. The speaker is still talking. Give exactly ONE short nudge they can act on in the next 20 seconds. One sentence. If they are crushing it, say so in one sentence instead. Reply as JSON: {"nudge":"...","on_track":true|false}`;

  const finalAsk = `${shared}

Mode: FINAL. The pitch is over. Score each criterion 0-10. Then give a straight verdict.
Reply as STRICT JSON, no prose outside it:
{
  "scores": { ${RUBRIC_KEYS.map((k) => `"${k}": <0-10>`).join(", ")} },
  "weighted": <0-100>,
  "will_win": true|false,
  "verdict": "<two sentences max, blunt>",
  "biggest_fix": "<the single highest-leverage change before the next run>"
}`;

  return [{ role: "user", content: isLive ? liveAsk : finalAsk }];
}

// Pull the first JSON object out of a model reply, tolerant of fenced code or
// stray prose. Returns null if there is nothing parseable.
function extractJson(text) {
  const raw = String(text || "");
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch (error) {
    return null;
  }
}

// Normalize a final reply into a stable shape, recomputing the weighted score
// from the per-criterion scores so the number cannot drift from the rubric.
function parseFinal(text) {
  const obj = extractJson(text);
  if (!obj || typeof obj !== "object") {
    return { ok: false, raw: String(text || "").slice(0, 400) };
  }
  const scores = {};
  for (const r of RUBRIC) {
    const v = Number(obj.scores ? obj.scores[r.key] : undefined);
    scores[r.key] = Number.isFinite(v) ? Math.max(0, Math.min(10, v)) : null;
  }
  const weighted = computeWeighted(scores);
  return {
    ok: true,
    scores,
    weighted,
    will_win: weighted != null ? weighted >= 70 : Boolean(obj.will_win),
    verdict: String(obj.verdict || "").trim(),
    biggest_fix: String(obj.biggest_fix || "").trim(),
  };
}

function parseLive(text) {
  const obj = extractJson(text);
  if (obj && typeof obj === "object" && (obj.nudge || obj.on_track != null)) {
    return { ok: true, nudge: String(obj.nudge || "").trim(), on_track: Boolean(obj.on_track) };
  }
  // Live mode tolerates a bare sentence — the nudge is the whole point.
  const bare = String(text || "").trim();
  return bare ? { ok: true, nudge: bare.slice(0, 240), on_track: true } : { ok: false };
}

// Weighted average over the criteria that have a score, on a 0-100 scale.
function computeWeighted(scores) {
  let num = 0;
  let den = 0;
  for (const r of RUBRIC) {
    const v = scores ? scores[r.key] : null;
    if (Number.isFinite(v)) {
      num += v * r.weight;
      den += r.weight;
    }
  }
  if (den === 0) return null;
  return Math.round((num / den) * 10);
}

module.exports = {
  RUBRIC,
  RUBRIC_KEYS,
  buildEvaluatorMessages,
  parseFinal,
  parseLive,
  computeWeighted,
  extractJson,
};
