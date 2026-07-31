"use strict";

function createSessionReadHandlers(deps) {
  const {
    authorized, sendJson, sendConversation, sessionSummaryPayload, defaultSessionId,
    threadListPayload, threadStore, sanitizeOptionalId, sessionContextPayload,
    listVoiceTurnsForSession, historyMessagesPayload, resolveContextTurnLimit,
    listChatTurnRecordsForSession, sessionMessagesPayload, latestContextPayload,
  } = deps;

  async function routeSessionReads(request, response, url) {
    if (request.method !== "GET") return false;
    const path = url.pathname;
    const conversation = path.startsWith("/v1/conversations/");
    const sessions = path === "/v1/sessions";
    const sessionDefault = path === "/v1/sessions/default";
    const threads = path === "/v1/threads";
    const activeThread = path === "/v1/threads/active";
    const sessionContext = path.startsWith("/v1/sessions/") && path.endsWith("/context");
    const sessionMessages = path.startsWith("/v1/sessions/") && path.endsWith("/messages");
    const voiceTurns = path.startsWith("/v1/sessions/") && path.endsWith("/turns") && !path.endsWith("/chat-turns");
    const history = path === "/v1/history/messages";
    const chatTurns = path.startsWith("/v1/sessions/") && path.endsWith("/chat-turns");
    const latestContext = path === "/v1/context/latest";
    if (!(conversation || sessions || sessionDefault || threads || activeThread || sessionContext || sessionMessages || voiceTurns || history || chatTurns || latestContext)) return false;
    if (!authorized(request)) {
      sendJson(response, 401, { error: "missing or invalid gateway token" });
      return true;
    }

    if (conversation) {
      sendConversation(response, path.slice("/v1/conversations/".length));
    } else if (sessions) {
      sendJson(response, 200, sessionSummaryPayload(Number(url.searchParams.get("limit") || 25)));
    } else if (sessionDefault) {
      sendJson(response, 200, { session_id: defaultSessionId() });
    } else if (threads) {
      const sessionId = url.searchParams.get("session_id") || url.searchParams.get("conversation_id") || defaultSessionId();
      sendJson(response, 200, threadListPayload(sessionId, Number(url.searchParams.get("limit") || 50)));
    } else if (activeThread) {
      sendActiveThread(response, url);
    } else if (sessionContext) {
      const sessionId = decodeSessionPath(path, "/context");
      sendJson(response, 200, sessionContextPayload({
        sessionId,
        branchId: url.searchParams.get("branch_id") || "default",
        allBranches: ["1", "true"].includes(url.searchParams.get("all_branches")),
        turnLimit: url.searchParams.get("turn_limit"),
      }));
    } else if (sessionMessages) {
      const parsedLimit = parseSessionMessageLimit(url.searchParams.get("limit"));
      if (!parsedLimit.valid) {
        sendJson(response, 400, { error: "invalid session message limit" });
        return true;
      }
      sendJson(response, 200, await sessionMessagesPayload({
        sessionId: decodeSessionPath(path, "/messages"),
        branchId: url.searchParams.get("branch_id") || "",
        limit: parsedLimit.value,
      }));
    } else if (voiceTurns) {
      const sessionId = decodeSessionPath(path, "/turns");
      sendJson(response, 200, { session_id: sanitizeOptionalId(sessionId, "default"), turns: listVoiceTurnsForSession(sessionId) });
    } else if (history) {
      sendJson(response, 200, historyMessagesPayload({
        sessionId: url.searchParams.get("session_id") || url.searchParams.get("conversation_id") || "",
        q: url.searchParams.get("q") || url.searchParams.get("query") || "",
        limit: Number(url.searchParams.get("limit") || 50),
      }));
    } else if (chatTurns) {
      sendChatTurns(response, url, decodeSessionPath(path, "/chat-turns"));
    } else {
      sendJson(response, 200, latestContextPayload());
    }
    return true;
  }

  function sendActiveThread(response, url) {
    const sessionId = sanitizeOptionalId(url.searchParams.get("session_id") || url.searchParams.get("conversation_id"), defaultSessionId());
    const surface = String(url.searchParams.get("surface") || "").slice(0, 60);
    const active = threadStore.getActive(sessionId, surface);
    const meta = threadStore.getThread(sessionId, active.branch_id);
    sendJson(response, 200, {
      session_id: sessionId,
      surface,
      active: {
        ...active,
        kind: meta?.kind || (active.branch_id === "default" ? "default" : "new"),
        label: meta?.label || (active.branch_id === "default" ? "Main thread" : active.branch_id),
      },
    });
  }

  function sendChatTurns(response, url, sessionId) {
    const safeId = sanitizeOptionalId(sessionId, "default");
    const limit = resolveContextTurnLimit(url.searchParams.get("limit"));
    const all = listChatTurnRecordsForSession(safeId);
    sendJson(response, 200, {
      session_id: safeId,
      total: all.length,
      limit,
      turns: all.slice(-limit).map((record) => ({
        turn_id: String(record.turn_id || ""),
        conversation_id: String(record.conversation_id || safeId),
        session_id: String(record.session_id || safeId),
        source: String(record.source || ""),
        model: String(record.model || ""),
        profile_version: String(record.profile_version || ""),
        created_at: String(record.created_at || record.ts || ""),
        response_text: String(record.response_text || ""),
      })),
    });
  }

  function decodeSessionPath(path, suffix) {
    return decodeURIComponent(path.slice("/v1/sessions/".length, -suffix.length));
  }

  return { routeSessionReads, sendActiveThread, sendChatTurns, decodeSessionPath };
}

function parseSessionMessageLimit(value) {
  if (value == null || value === "") return { valid: true, value: undefined };
  if (!/^\d+$/.test(value)) return { valid: false };
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 200) return { valid: false };
  return { valid: true, value: parsed };
}

module.exports = { createSessionReadHandlers, parseSessionMessageLimit };
