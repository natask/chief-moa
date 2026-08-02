"use strict";

// Start only provider work that explicitly advertises a content-free prewarm.
// The deliberately narrow input cannot carry transcript or audio content.
function startVoicePrewarm(provider, turn, logger = console.error) {
  const input = {
    session_id: turn.sessionId,
    branch_id: turn.branchId,
    turn_id: turn.turnId,
    profile: {
      reasoning_provider: turn.effectiveProfile?.reasoning_provider,
      model: turn.effectiveProfile?.model,
    },
  };
  for (const stage of [provider?.reasonerStage, provider?.ttsStage]) {
    if (stage?.capabilities?.connection_prewarm !== true) continue;
    Promise.resolve()
      .then(() => stage.prewarm(input))
      .catch((error) => logger(JSON.stringify({
        level: "warn",
        at: "voice_prewarm_failed",
        stage: stage.kind,
        provider_id: stage.id,
        session_id: input.session_id,
        branch_id: input.branch_id,
        turn_id: input.turn_id,
        error: cleanError(error),
      })));
  }
}

function cleanError(error) {
  return String(error?.message || error || "unknown error").replace(/[\r\n]+/g, " ").slice(0, 240);
}

module.exports = { startVoicePrewarm };
