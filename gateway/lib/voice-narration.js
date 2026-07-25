// Self-prompting "speak-forever" narration for the cascaded voice path
// (OpenSpec change voice-speak-forever-output-loop). The loop lives inside ONE
// streaming turn: the reasoner re-prompts the model for the next narration
// beat through the SAME sanitizer and chunked-TTS pipeline, so the client sees
// one ordinary (long) streamed turn. Everything here is inert unless the
// VOICE_SPEAK_FOREVER master env is set — this mode spends money in a loop,
// so the default is OFF, the opposite polarity of VOICE_STREAMING.

const NARRATION_CONTINUE_PROMPT = "Continue the narration from exactly where your previous message stopped. Do not repeat, re-introduce, or summarize anything you already said, and do not greet again. If the narration has genuinely concluded, call the finish_narration tool instead of padding with filler.";

// Read per call (not module-load consts) so an env flip needs no restart,
// matching VOICE_STREAMING / MODEL_AUTOCONTINUE_MAX_ROUNDS.
function speakForeverEnabled(env = process.env) {
  return String(env.VOICE_SPEAK_FOREVER || "").trim() === "1";
}

function positiveIntFrom(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

// All three spend caps are deliberately finite — unlike the MAX_TOKENS
// auto-continue's Infinity default — because narration is voluntary spend.
function speakForeverCaps(env = process.env) {
  return {
    maxRounds: positiveIntFrom(env.VOICE_SPEAK_FOREVER_MAX_ROUNDS, 25),
    maxSegments: positiveIntFrom(env.VOICE_SPEAK_FOREVER_MAX_SEGMENTS, 200),
    maxMs: positiveIntFrom(env.VOICE_SPEAK_FOREVER_MAX_MS, 600000),
    maxBufferedSegments: positiveIntFrom(env.VOICE_SPEAK_FOREVER_MAX_BUFFERED_SEGMENTS, 6),
  };
}

function narrationActionCalled(toolResults, type) {
  return Array.isArray(toolResults)
    && toolResults.some((entry) => entry?.result?.action?.type === type);
}

// The engagement/exit tools, siblings of stay_silent. A tool call is
// sanitizer-invisible (tool-round text is buffered), so the exit can never
// leak a sentinel into TTS. Empty when the master env is off or the turn is
// deliberately text-only — an unexposed tool cannot be called.
function narrationToolDefs(env = process.env, options = {}) {
  const modality = String(options.modality || "").trim().toLowerCase();
  if (!speakForeverEnabled(env) || modality === "text") {
    return [];
  }
  return [
    {
      name: "begin_continuous_narration",
      description: "The user explicitly asked for open-ended continuous narration (\"tell me a story until I say stop\", \"keep teaching me this\", \"keep talking\"). Call this once, then start narrating; the gateway keeps prompting you for the next beat until the user interrupts, you call finish_narration, or a hard cap trips. Do not call it for ordinary questions that want one bounded answer.",
      parameters: { type: "object", properties: {} },
      handler: () => ({ ok: true, action: { type: "begin_continuous_narration" } }),
    },
    {
      name: "finish_narration",
      description: "End the continuous narration because it has genuinely concluded. Call this instead of padding a finished narration with filler.",
      parameters: { type: "object", properties: {} },
      handler: () => ({ ok: true, action: { type: "finish_narration" } }),
    },
  ];
}

// System-prompt guidance shown only when the narration tools are exposed,
// landing next to the existing stop/silence instructions.
function narrationDirective() {
  return [
    "Continuous narration (speak-forever) is available this turn:",
    "- If the user asks for open-ended narration (a story until they say stop, keep teaching, keep talking), call begin_continuous_narration once, then narrate.",
    "- While narrating, the gateway prompts you for the next beat automatically; continue seamlessly each time without re-greeting.",
    "- When the narration genuinely concludes, call finish_narration. Never pad a finished narration with filler.",
    "- A stop/quiet request still means silence: call stay_silent as usual.",
  ].join("\n");
}

// The narration loop (design D3): self-prompt rounds through the caller's
// model-round closure, which feeds the SAME onTextDelta/isActive hooks as the
// initial round. The caps and the pacing gate are checked BEFORE each new
// round, so a cap or a barge-in never starts another model call. Exit reasons
// mirror design D5: finished | silenced | interrupted | capped_rounds |
// capped_segments | capped_ms | tts_error.
async function runNarrationLoop(options) {
  const caps = options.caps || speakForeverCaps();
  const callRound = options.callRound;
  const isActive = typeof options.isActive === "function" ? options.isActive : () => true;
  const drainBelow = typeof options.drainBelow === "function" ? options.drainBelow : async () => ({ ok: true });
  const segmentsEnqueued = typeof options.segmentsEnqueued === "function" ? options.segmentsEnqueued : () => 0;
  const speakCapped = typeof options.speakCapped === "function" ? options.speakCapped : () => false;
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const messages = Array.isArray(options.messages) ? options.messages : [];
  const startedAtMs = now();

  let result = options.initialResult && typeof options.initialResult === "object"
    ? options.initialResult
    : { text: "", tool_results: [] };
  let rounds = 1;
  let text = String(result.text || "").trim();
  const toolResults = Array.isArray(result.tool_results) ? result.tool_results.slice() : [];
  let stopReason = "";
  if (narrationActionCalled(result.tool_results, "stay_silent")) {
    stopReason = "silenced";
  } else if (narrationActionCalled(result.tool_results, "finish_narration")) {
    stopReason = "finished";
  }

  while (!stopReason) {
    if (rounds >= caps.maxRounds) {
      stopReason = "capped_rounds";
      break;
    }
    // A finite operator speak cap (VOICE_STREAM_MAX_CHARS / voice_max_chars)
    // silently stops the sanitizer; the loop yields to it instead of
    // generating beats nobody will hear.
    if (segmentsEnqueued() >= caps.maxSegments || speakCapped()) {
      stopReason = "capped_segments";
      break;
    }
    if (now() - startedAtMs >= caps.maxMs) {
      stopReason = "capped_ms";
      break;
    }
    if (isActive() === false) {
      stopReason = "interrupted";
      break;
    }
    // Pacing gate (design D4): the next model round may not start until the
    // pipeline has drained below the buffered-segment bound. The gate resolves
    // {ok:false} on supersession/failure so a narration round never awaits a
    // dead pipeline.
    let drain;
    try {
      drain = await drainBelow(caps.maxBufferedSegments);
    } catch {
      drain = { ok: false, reason: "superseded" };
    }
    if (!drain || drain.ok !== true) {
      stopReason = drain && drain.reason === "failed" ? "tts_error" : "interrupted";
      break;
    }
    // Re-check liveness after the (possibly long) drain wait: a barge-in that
    // landed during playback must not trigger another model round.
    if (isActive() === false) {
      stopReason = "interrupted";
      break;
    }
    messages.push({ role: "assistant", content: String(result.text || "") });
    messages.push({ role: "user", content: NARRATION_CONTINUE_PROMPT });
    result = await callRound(messages);
    rounds += 1;
    const roundText = String(result?.text || "").trim();
    if (roundText) {
      text = text ? `${text} ${roundText}` : roundText;
    }
    if (Array.isArray(result?.tool_results)) {
      toolResults.push(...result.tool_results);
    }
    if (narrationActionCalled(result?.tool_results, "stay_silent")) {
      stopReason = "silenced";
      break;
    }
    // A round with no speakable text is the model's implicit "done" — never
    // loop on emptiness.
    if (narrationActionCalled(result?.tool_results, "finish_narration") || !roundText) {
      stopReason = "finished";
      break;
    }
  }

  return { text, rounds, stop_reason: stopReason, tool_results: toolResults };
}

module.exports = {
  NARRATION_CONTINUE_PROMPT,
  speakForeverEnabled,
  speakForeverCaps,
  narrationToolDefs,
  narrationDirective,
  narrationActionCalled,
  runNarrationLoop,
};
