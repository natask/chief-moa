"use strict";

const presentationEvaluator = require("./presentation-evaluator");

function createPresentationHandlers(deps) {
  const {
    authorized,
    sendJson,
    readJsonBody,
    sanitizeOptionalId,
    listVoiceTurnsForSession,
    callModel,
    effectiveProfile,
    cleanError,
  } = deps;
  const evaluator = deps.evaluator || presentationEvaluator;

  async function routePresentation(request, response, url) {
    if (request.method !== "POST" || url.pathname !== "/v1/presentation/evaluate") return false;
    if (!authorized(request)) {
      sendJson(response, 401, { error: "missing or invalid gateway token" });
      return true;
    }
    await handleEvaluate(request, response);
    return true;
  }

  async function handleEvaluate(request, response) {
    const body = await readJsonBody(request);
    const mode = body.mode === "live" ? "live" : "final";
    const sessionId = body.session_id ? sanitizeOptionalId(body.session_id, "default") : null;
    const turns = Array.isArray(body.turns) && body.turns.length
      ? body.turns
      : sessionId
        ? listVoiceTurnsForSession(sessionId)
        : [];

    if (turns.length === 0) {
      sendJson(response, 400, { error: "no transcript: pass session_id with captured turns, or turns inline" });
      return;
    }

    const messages = evaluator.buildEvaluatorMessages({
      deck: body.deck,
      turns,
      mode,
      elapsedSec: Number(body.elapsed_sec),
    });
    let reply;
    try {
      reply = await callModel(messages, effectiveProfile());
    } catch (error) {
      sendJson(response, 502, { error: `evaluator model call failed: ${cleanError(error)}` });
      return;
    }
    const result = mode === "live" ? evaluator.parseLive(reply) : evaluator.parseFinal(reply);
    sendJson(response, 200, { mode, session_id: sessionId, turns_seen: turns.length, ...result });
  }

  return { routePresentation, handleEvaluate };
}

module.exports = { createPresentationHandlers };
