"use strict";

function createThreadSwitchHandlers(deps) {
  const {
    authorized, sendJson, readJsonBody, sanitizeOptionalId, sanitizeOptionalBlankId,
    defaultSessionId, profileDeviceIdFromBody, newBranchId, branchLatestTurn,
    threadStore, isIncognitoBranch, threadListPayload,
  } = deps;
  const now = typeof deps.now === "function" ? deps.now : () => new Date();

  async function routeThreadSwitch(request, response, url) {
    if (request.method !== "POST" || url.pathname !== "/v1/threads/switch") return false;
    if (!authorized(request)) {
      sendJson(response, 401, { error: "missing or invalid gateway token" });
      return true;
    }
    await handleThreadSwitch(request, response);
    return true;
  }

  async function handleThreadSwitch(request, response) {
    const body = await readJsonBody(request);
    const sessionId = sanitizeOptionalId(body.session_id || body.conversation_id, defaultSessionId());
    const surface = String(body.surface || body.source || "").slice(0, 60);
    const deviceId = profileDeviceIdFromBody(body);
    const requestedAction = String(body.action || "").toLowerCase();
    const label = String(body.thread_label || body.label || "").slice(0, 120);
    let branchId = sanitizeOptionalBlankId(body.branch_id || body.branchId);
    let kind = "continue";
    let parentBranchId = "";
    let forkPoint = null;

    if (!branchId && ["new", "fork", "incognito"].includes(requestedAction)) {
      kind = requestedAction;
      branchId = newBranchId(requestedAction);
      if (requestedAction === "fork") {
        parentBranchId = sanitizeOptionalId(body.parent_branch_id || threadStore.getActive(sessionId, surface).branch_id, "default");
        forkPoint = branchLatestTurn(sessionId, parentBranchId);
      }
    }
    if (!branchId) branchId = "default";

    let meta = null;
    if (!isIncognitoBranch(branchId)) {
      meta = threadStore.ensureThread(sessionId, branchId, {
        kind: kind === "continue" ? undefined : kind,
        label: label || undefined,
        parent_branch_id: parentBranchId || undefined,
        fork_point: forkPoint || undefined,
      });
      if (kind === "fork" && parentBranchId) seedForkSummary(sessionId, branchId, parentBranchId);
    }

    const state = threadStore.recordSwitch(sessionId, {
      branch_id: branchId,
      surface,
      device_id: deviceId,
      at: now().toISOString(),
    });
    sendJson(response, 200, {
      session_id: sessionId,
      surface,
      active: state.active,
      thread: meta || {
        session_id: sessionId,
        branch_id: branchId,
        kind: isIncognitoBranch(branchId) ? "incognito" : "default",
        label: isIncognitoBranch(branchId) ? "Incognito" : "",
        parent_branch_id: parentBranchId,
        fork_point: forkPoint,
      },
      threads: threadListPayload(sessionId).threads,
    });
  }

  function seedForkSummary(sessionId, branchId, parentBranchId) {
    const parentSummary = threadStore.readSummary(sessionId, parentBranchId);
    if (parentSummary?.summary && !threadStore.readSummary(sessionId, branchId)) {
      threadStore.writeSummary(sessionId, branchId, parentSummary.summary, { turn_count: 0, source: "fork-seed" });
    }
  }

  return { routeThreadSwitch, handleThreadSwitch, seedForkSummary };
}

module.exports = { createThreadSwitchHandlers };
