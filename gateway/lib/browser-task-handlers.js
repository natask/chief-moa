"use strict";

function createBrowserTaskHandlers(deps) {
  const {
    authorizedAgent, agentAuthError, sendJson, readJsonBody, listBrowserTasks,
    claimNextBrowserTask, appendAgentEvent, recordBrowserTaskProductEvent,
    summarizeBrowserTask, createBrowserTask, cleanError, truncate, sanitizeId,
    browserTaskExists, randomId, sanitizeBrowserActionResults,
    sanitizeBrowserPageState, sanitizeBrowserScreenshot, readBrowserTask,
    updateBrowserTask, agentRunExists, readAgentRun, updateAgentRun,
    launchBrowserAgentTaskInternal, browserAgentLoop,
  } = deps;
  const now = typeof deps.now === "function" ? deps.now : () => new Date().toISOString();

  async function routeBrowserTasks(request, response, url) {
    const path = url.pathname;
    const legacyCollection = path === "/v1/browser/tasks";
    const legacyClaim = path === "/v1/browser/tasks/claim" && request.method === "POST";
    const legacyReceipt = request.method === "POST" && path.startsWith("/v1/browser/tasks/") && path.endsWith("/receipts");
    const agentCollection = path === "/v1/browser/agent-tasks";
    const agentClaim = path === "/v1/browser/agent-tasks/claim" && request.method === "POST";
    const agentStep = request.method === "POST" && path.startsWith("/v1/browser/agent-tasks/") && path.endsWith("/steps");
    const agentFinish = request.method === "POST" && path.startsWith("/v1/browser/agent-tasks/") && path.endsWith("/finish");
    const agentRead = request.method === "GET" && path.startsWith("/v1/browser/agent-tasks/");
    const matched = (legacyCollection && ["GET", "POST"].includes(request.method)) || legacyClaim || legacyReceipt ||
      (agentCollection && ["GET", "POST"].includes(request.method)) || agentClaim || agentStep || agentFinish || agentRead;
    if (!matched) return false;
    if (!authorizedAgent(request)) { sendJson(response, 401, agentAuthError()); return true; }
    if (legacyCollection && request.method === "GET") {
      sendJson(response, 200, { tasks: listBrowserTasks(queryOptions(url)) });
    } else if (legacyCollection) await handleCreateBrowserTask(request, response);
    else if (legacyClaim) await handleClaimBrowserTask(request, response);
    else if (legacyReceipt) await handleBrowserTaskReceipt(request, response, sliceId(path, "/v1/browser/tasks/", "/receipts"));
    else if (agentCollection && request.method === "GET") {
      sendJson(response, 200, { tasks: browserAgentLoop.list(queryOptions(url)) });
    } else if (agentCollection) await handleCreateBrowserAgentTask(request, response);
    else if (agentClaim) await handleClaimBrowserAgentTask(request, response);
    else if (agentStep) await handleBrowserAgentTaskStep(request, response, sliceId(path, "/v1/browser/agent-tasks/", "/steps"));
    else if (agentFinish) await handleBrowserAgentTaskFinish(request, response, sliceId(path, "/v1/browser/agent-tasks/", "/finish"));
    else {
      const task = browserAgentLoop.get(decodeURIComponent(path.slice("/v1/browser/agent-tasks/".length)));
      if (!task) sendJson(response, 404, { error: "browser agent task not found" });
      else sendJson(response, 200, { task });
    }
    return true;
  }

  async function handleClaimBrowserTask(request, response) {
    const body = await readJsonBody(request);
    const clientId = String(body.client_id || body.client || "agee-extension").trim().slice(0, 120);
    const task = claimNextBrowserTask(clientId);
    if (!task) { sendJson(response, 204, {}); return; }
    if (task.agent_run_id) appendAgentEvent(task.agent_run_id, "browser_task_claimed", {
      browser_task_id: task.id, client_id: task.claimed_by, lease_expires_at: task.lease_expires_at,
    });
    await recordBrowserTaskProductEvent(task, "claimed");
    sendJson(response, 200, { task: summarizeBrowserTask(task, { includeActions: true }) });
  }

  async function handleCreateBrowserTask(request, response) {
    const body = await readJsonBody(request);
    let task;
    try { task = createBrowserTask({ ...body, source: body.source || "api" }); }
    catch (error) { sendJson(response, 400, { error: cleanError(error) }); return; }
    if (task.agent_run_id) appendAgentEvent(task.agent_run_id, "browser_task_queued", {
      browser_task_id: task.id, instruction: truncate(task.instruction, 2000), url: task.url,
      action_count: task.cdp_actions.length,
    });
    await recordBrowserTaskProductEvent(task, "queued");
    sendJson(response, 202, { task: summarizeBrowserTask(task, { includeActions: true }) });
  }

  async function handleBrowserTaskReceipt(request, response, id) {
    const taskId = sanitizeId(id);
    if (!browserTaskExists(taskId)) { sendJson(response, 404, { error: "browser task not found" }); return; }
    const body = await readJsonBody(request);
    const timestamp = now();
    const ok = body.ok !== false && !body.error;
    const receipt = {
      id: randomId("receipt"), ts: timestamp, ok,
      client_id: String(body.client_id || "agee-extension").slice(0, 120),
      summary: truncate(String(body.summary || ""), 2000),
      error: body.error ? truncate(String(body.error), 2000) : "",
      action_results: sanitizeBrowserActionResults(body.action_results),
      page_state: sanitizeBrowserPageState(body.page_state), screenshot: sanitizeBrowserScreenshot(body.screenshot),
    };
    const current = readBrowserTask(taskId);
    const receipts = Array.isArray(current.receipts) ? current.receipts.concat([receipt]) : [receipt];
    const task = updateBrowserTask(taskId, {
      status: ok ? "completed" : "failed", updated_at: timestamp, finished_at: timestamp,
      receipts, error: receipt.error,
    });
    if (task.agent_run_id && agentRunExists(task.agent_run_id)) {
      appendAgentEvent(task.agent_run_id, "browser_task_receipt", {
        browser_task_id: task.id, ok: receipt.ok, summary: receipt.summary,
        error: receipt.error, page_state: receipt.page_state,
      });
      const run = readAgentRun(task.agent_run_id);
      updateAgentRun(task.agent_run_id, {
        updated_at: timestamp,
        output: [String(run.output || "").trim(), receipt.ok
          ? `Browser task ${task.id} completed: ${receipt.summary || "receipt received"}`
          : `Browser task ${task.id} failed: ${receipt.error || receipt.summary || "receipt received"}`
        ].filter(Boolean).join("\n\n"),
      });
    }
    await recordBrowserTaskProductEvent(task, "receipt", receipt);
    sendJson(response, 200, { task: summarizeBrowserTask(task), receipt });
  }

  async function handleCreateBrowserAgentTask(request, response) {
    const body = await readJsonBody(request);
    try {
      const created = launchBrowserAgentTaskInternal(body);
      sendJson(response, 202, { task: browserAgentLoop.summarize(created.task, { includeSteps: true }) });
    } catch (error) { sendJson(response, 400, { error: cleanError(error) }); }
  }

  async function handleClaimBrowserAgentTask(request, response) {
    const body = await readJsonBody(request);
    const clientId = String(body.client_id || body.client || "agee-extension").trim().slice(0, 120);
    const task = browserAgentLoop.claim(clientId);
    if (!task) { sendJson(response, 204, {}); return; }
    if (task.agent_run_id && agentRunExists(task.agent_run_id)) appendAgentEvent(task.agent_run_id, "browser_agent_task_claimed", {
      browser_agent_task_id: task.id, client_id: task.claimed_by, lease_expires_at: task.lease_expires_at,
    });
    sendJson(response, 200, { task: browserAgentLoop.summarize(task, { includeSteps: true }) });
  }

  async function handleBrowserAgentTaskStep(request, response, id) {
    const body = await readJsonBody(request);
    let result;
    try { result = await browserAgentLoop.step(id, body); }
    catch (error) { sendJson(response, 400, { error: cleanError(error) }); return; }
    if (result.error) { sendJson(response, result.code || 400, { error: result.error }); return; }
    if (result.task?.agent_run_id && agentRunExists(result.task.agent_run_id)) appendAgentEvent(result.task.agent_run_id, "browser_agent_task_step", {
      browser_agent_task_id: result.task.id, step: result.step, action_kind: result.action.kind, done: result.done,
    });
    sendJson(response, 200, { action: result.action, step: result.step, done: result.done });
  }

  async function handleBrowserAgentTaskFinish(request, response, id) {
    const body = await readJsonBody(request);
    const result = browserAgentLoop.finish(id, body);
    if (result.error) { sendJson(response, result.code || 400, { error: result.error }); return; }
    const timestamp = now();
    if (result.agent_run_id && agentRunExists(result.agent_run_id)) {
      appendAgentEvent(result.agent_run_id, "browser_agent_task_finished", {
        browser_agent_task_id: result.task.id, status: result.status, summary: result.summary,
      });
      const run = readAgentRun(result.agent_run_id);
      updateAgentRun(result.agent_run_id, {
        status: result.status === "done" ? "completed" : "failed", updated_at: timestamp, finished_at: timestamp,
        output: [String(run.output || "").trim(), result.status === "done"
          ? `Browser agent task ${result.task.id} finished: ${result.summary || "done"}`
          : `Browser agent task ${result.task.id} ${result.status}: ${result.summary || result.status}`
        ].filter(Boolean).join("\n\n"),
      });
    }
    sendJson(response, 200, { task: result.task });
  }

  return { routeBrowserTasks, handleClaimBrowserTask, handleCreateBrowserTask, handleBrowserTaskReceipt,
    handleCreateBrowserAgentTask, handleClaimBrowserAgentTask, handleBrowserAgentTaskStep, handleBrowserAgentTaskFinish };
}

function queryOptions(url) { return { status: url.searchParams.get("status") || "", limit: Number(url.searchParams.get("limit") || 25) }; }
function sliceId(path, prefix, suffix) { return path.slice(prefix.length, -suffix.length); }

module.exports = { createBrowserTaskHandlers, queryOptions, sliceId };
