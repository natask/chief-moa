"use strict";

function createAgentRunLaunchHandlers({
  authorizedAgent, agentAuthError, readJsonBody, sendJson, cleanError,
  sanitizeId, runExists, readAgentRun, createAgentRun, executeAgentRun,
  activeRuns, agentRunBodyWithSessionContext, useWorkerPullForAgentRuns,
  agentRunPayload, appendAgentEvent, truncate, agentPromptWithSessionContext,
}) {
  function authorize(request, response) {
    if (authorizedAgent(request)) return true;
    sendJson(response, 401, agentAuthError());
    return false;
  }

  function startLocalRun(id) {
    const active = { child: null, cancelRequested: false, promise: null };
    const promise = executeAgentRun(id, active).finally(() => activeRuns.delete(id));
    active.promise = promise;
    activeRuns.set(id, active);
    return promise;
  }

  async function handleLaunch(request, response) {
    const body = await readJsonBody(request);
    let run;
    try {
      run = createAgentRun(agentRunBodyWithSessionContext(body));
    } catch (error) {
      sendJson(response, 400, { error: cleanError(error) });
      return;
    }
    if (useWorkerPullForAgentRuns()) {
      sendJson(response, 202, {
        ...agentRunPayload(readAgentRun(run.id)),
        worker_pull: { queued: true, claim_url: "/v1/agent/workers/claim" },
      });
      return;
    }
    const promise = startLocalRun(run.id);
    if (body.wait === false) {
      sendJson(response, 202, agentRunPayload(readAgentRun(run.id)));
      return;
    }
    await promise;
    sendJson(response, 200, agentRunPayload(readAgentRun(run.id)));
  }

  async function handleFollowup(request, response, id) {
    const safeId = sanitizeId(id);
    if (!runExists(safeId)) {
      sendJson(response, 404, { error: "agent run not found" });
      return;
    }
    const parent = readAgentRun(safeId);
    const body = await readJsonBody(request);
    const text = String(body.prompt || body.text || body.transcript || "").trim();
    if (!text) {
      sendJson(response, 400, { error: "follow-up text is required" });
      return;
    }
    appendAgentEvent(parent.id, "follow_up", {
      text: truncate(text, 4000),
      source: String(body.source || "android-overlay").slice(0, 80),
    });
    const continuationPrompt = [
      "Continue the prior Moa agent run with this new user follow-up.", "",
      "Parent run:", parent.id, "", "Parent prompt:", truncate(parent.prompt || "", 6000), "",
      "Parent latest output:", truncate(parent.output || parent.stderr || parent.stdout || "", 6000), "",
      "New user follow-up:", text,
    ].join("\n");
    const prompt = agentPromptWithSessionContext(continuationPrompt, {
      sessionId: body.session_id || body.conversation_id || parent.conversation_id,
      branchId: body.branch_id || "default",
      allBranches: body.all_branches_context === true,
    });
    let run;
    try {
      run = createAgentRun({
        conversation_id: body.conversation_id || parent.conversation_id,
        source: body.source || "android-follow-up",
        harness: body.harness || parent.harness,
        working_dir: body.working_dir || parent.working_dir,
        prompt, screen: body.screen, parent_run_id: parent.id,
        profile_version: body.profile_version || parent.profile_version,
      });
    } catch (error) {
      sendJson(response, 400, { error: cleanError(error) });
      return;
    }
    if (useWorkerPullForAgentRuns()) {
      sendJson(response, 202, {
        ...agentRunPayload(readAgentRun(run.id)), parent_run_id: parent.id,
        worker_pull: { queued: true, claim_url: "/v1/agent/workers/claim" },
      });
      return;
    }
    startLocalRun(run.id);
    sendJson(response, 202, { ...agentRunPayload(readAgentRun(run.id)), parent_run_id: parent.id });
  }

  async function routeAgentRunLaunches(request, response, url) {
    if (url.pathname === "/v1/agent/runs" && request.method === "POST") {
      if (authorize(request, response)) await handleLaunch(request, response);
      return true;
    }
    if (request.method === "POST" && url.pathname.startsWith("/v1/agent/runs/") && url.pathname.endsWith("/followups")) {
      if (authorize(request, response)) {
        const id = url.pathname.slice("/v1/agent/runs/".length, -"/followups".length);
        await handleFollowup(request, response, id);
      }
      return true;
    }
    return false;
  }

  return { routeAgentRunLaunches, handleLaunch, handleFollowup };
}

module.exports = { createAgentRunLaunchHandlers };
