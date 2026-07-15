"use strict";

function createVoiceControlHandlers(deps) {
  const {
    authorized, sendJson, handleVoiceRetranscribe, handleVoiceTurnsList,
    handleVoiceTurnGet, voiceDiagnosisPayload, sendVoiceAudio,
    handleVoiceSessionTicket, handleLivekitToken, livekitConfigured,
    livekitNotConfiguredPayload, handleInternalVoiceReason,
    handleInternalVoiceSynthesize, handleInternalVoiceTurnRecord, handleVoiceFrame,
  } = deps;

  async function routeVoiceControls(request, response, url) {
    const path = url.pathname;
    const retranscribe = request.method === "POST" && path.startsWith("/v1/voice/turns/") && path.endsWith("/retranscribe");
    const turns = request.method === "GET" && path === "/v1/voice/turns";
    const turn = request.method === "GET" && path.startsWith("/v1/voice/turns/");
    const diagnosis = request.method === "GET" && path === "/v1/voice/diagnosis";
    const audio = request.method === "GET" && path.startsWith("/v1/voice/audio/");
    const ticket = request.method === "POST" && path === "/v1/voice/session-ticket";
    const livekitToken = request.method === "POST" && path === "/v1/voice/livekit/token";
    const reason = request.method === "POST" && path === "/v1/internal/voice/reason";
    const synthesize = request.method === "POST" && path === "/v1/internal/voice/synthesize";
    const turnRecord = request.method === "POST" && path === "/v1/internal/voice/turn-record";
    const frames = request.method === "POST" && path === "/v1/voice/frames";
    if (!(retranscribe || turns || turn || diagnosis || audio || ticket || livekitToken || reason || synthesize || turnRecord || frames)) return false;
    if (!authorized(request)) {
      sendJson(response, 401, { error: "missing or invalid gateway token" });
      return true;
    }

    if (retranscribe) await handleVoiceRetranscribe(request, response, url);
    else if (turns) handleVoiceTurnsList(response, url);
    else if (turn) {
      const turnId = decodeURIComponent(path.slice("/v1/voice/turns/".length)).trim();
      handleVoiceTurnGet(response, turnId, url.searchParams.get("session_id") || "");
    } else if (diagnosis) handleDiagnosis(response, url);
    else if (audio) sendVoiceAudio(request, response, url);
    else if (ticket) await handleVoiceSessionTicket(request, response);
    else if (livekitToken) await handleLivekitToken(request, response);
    else if (reason) await handleLivekitGated(request, response, handleInternalVoiceReason);
    else if (synthesize) await handleInternalVoiceSynthesize(request, response);
    else if (turnRecord) await handleLivekitGated(request, response, handleInternalVoiceTurnRecord);
    else await handleVoiceFrame(request, response);
    return true;
  }

  function handleDiagnosis(response, url) {
    const sessionId = url.searchParams.get("session_id") || url.searchParams.get("conversation_id") || "";
    if (!sessionId) {
      sendJson(response, 400, { error: "session_id is required for a bounded voice diagnosis query" });
      return;
    }
    sendJson(response, 200, voiceDiagnosisPayload({
      sessionId,
      turnId: url.searchParams.get("turn_id") || "",
      limit: Number(url.searchParams.get("limit") || 10),
    }));
  }

  async function handleLivekitGated(request, response, handler) {
    if (!livekitConfigured()) {
      sendJson(response, 503, livekitNotConfiguredPayload());
      return;
    }
    await handler(request, response);
  }

  return { routeVoiceControls, handleDiagnosis, handleLivekitGated };
}

module.exports = { createVoiceControlHandlers };
