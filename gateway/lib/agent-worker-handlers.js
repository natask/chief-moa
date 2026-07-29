"use strict";

function createAgentWorkerHandlers({
  authorizedAgent, agentAuthError, readJsonBody, sendJson,
  workerPull, WorkerPullError, randomId, cleanError, ownerActor,
  readAgentRun, rememberRunOutcome, syncWorkGraphFromRun, appendAgentEvent,
  recordCanonicalCompletion,
}) {
  if (typeof recordCanonicalCompletion !== "function") {
    throw new TypeError("agent worker handlers require recordCanonicalCompletion");
  }
  function sendWorkerError(response, error) {
    if (error instanceof WorkerPullError) {
      sendJson(response, error.status, {
        error: {
          code: error.code,
          message: error.message,
          retryable: Boolean(error.retryable),
        },
        request_id: randomId("req"),
      });
      return;
    }
    sendJson(response, 400, {
      error: {
        code: "invalid_request",
        message: cleanError(error),
        retryable: false,
      },
      request_id: randomId("req"),
    });
  }

  async function withWorkerError(response, operation) {
    try {
      await operation();
    } catch (error) {
      sendWorkerError(response, error);
    }
  }

  async function handleResult(request, response, id) {
    await withWorkerError(response, async () => {
      const auth = workerPull.authenticate(request, "agent_runs:complete");
      const body = await readJsonBody(request);
      const result = workerPull.result(id, body, auth);
      try {
        const run = readAgentRun(id);
        rememberRunOutcome(run);
        await recordCanonicalCompletion(run);
        syncWorkGraphFromRun(run).catch((error) => {
          appendAgentEvent(id, "work_node_sync_failed", { error: cleanError(error) });
        });
      } catch (error) {
        appendAgentEvent(id, "completion_hooks_failed", { error: cleanError(error) });
        throw error;
      }
      sendJson(response, 200, result);
    });
  }

  async function routeAgentWorkers(request, response, url) {
    if (url.pathname === "/v1/agent/workers/registrations" && request.method === "POST") {
      if (!authorizedAgent(request)) {
        sendJson(response, 401, agentAuthError());
      } else {
        await withWorkerError(response, async () => {
          sendJson(response, 201, workerPull.createRegistration(await readJsonBody(request), { actor: ownerActor() }));
        });
      }
      return true;
    }
    if (url.pathname === "/v1/agent/workers/register" && request.method === "POST") {
      await withWorkerError(response, async () => {
        sendJson(response, 201, workerPull.registerWorker(await readJsonBody(request)));
      });
      return true;
    }
    if (url.pathname === "/v1/agent/workers/claim" && request.method === "POST") {
      await withWorkerError(response, async () => {
        const auth = workerPull.authenticate(request, "agent_runs:claim");
        sendJson(response, 200, workerPull.claim(await readJsonBody(request), auth));
      });
      return true;
    }

    const suffixes = [
      ["/heartbeat", "agent_runs:heartbeat", "heartbeat"],
      ["/events", "agent_runs:append_event", "appendEvents"],
    ];
    for (const [suffix, scope, method] of suffixes) {
      if (request.method === "POST" && url.pathname.startsWith("/v1/agent/runs/") && url.pathname.endsWith(suffix)) {
        const id = url.pathname.slice("/v1/agent/runs/".length, -suffix.length);
        await withWorkerError(response, async () => {
          const auth = workerPull.authenticate(request, scope);
          sendJson(response, 200, workerPull[method](id, await readJsonBody(request), auth));
        });
        return true;
      }
    }
    if (request.method === "POST" && url.pathname.startsWith("/v1/agent/runs/") && url.pathname.endsWith("/result")) {
      const id = url.pathname.slice("/v1/agent/runs/".length, -"/result".length);
      await handleResult(request, response, id);
      return true;
    }
    return false;
  }

  return { routeAgentWorkers, sendWorkerError };
}

module.exports = { createAgentWorkerHandlers };
