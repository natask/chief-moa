"use strict";

function createSupervisorHandlers(deps) {
  const {
    authorizedAgent, agentAuthError, sendJson, harnessStatus, workGraph,
    listAllAgentRuns, isTerminalRunStatus, provider, model, providerConfigured,
    dataDir, brain, voiceSessionServer, effectiveInstruction, truncate,
  } = deps;
  const now = typeof deps.now === "function" ? deps.now : () => new Date();

  async function routeSupervisor(request, response, url) {
    const harnesses = request.method === "GET" && url.pathname === "/v1/agent/harnesses";
    const status = request.method === "GET" && url.pathname === "/v1/supervisor/status";
    if (!(harnesses || status)) return false;
    if (!authorizedAgent(request)) {
      sendJson(response, 401, agentAuthError());
      return true;
    }
    if (harnesses) sendJson(response, 200, { harnesses: harnessStatus() });
    else sendJson(response, 200, await statusPayload());
    return true;
  }

  async function statusPayload() {
    const nodes = await workGraph.list();
    const byStatus = {};
    for (const status of workGraph.statuses()) {
      byStatus[status] = nodes.filter((node) => node.status === status).length;
    }
    const allRuns = listAllAgentRuns().sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    return {
      generated_at: now().toISOString(),
      frame: "node_based_execution_with_thin_supervisor",
      supervisor: {
        standing_chief_agent: false,
        conductor_loop: false,
        remote_model_poll_cadence_ms: null,
        description: "The supervisor is a query and launch surface over durable work nodes and disposable executor runs.",
      },
      storage: {
        agent_runs: "json-files",
        ...(typeof workGraph.storageInfo === "function" ? workGraph.storageInfo() : {
          work_graph: workGraph.graphPath,
          postgres_configured: false,
        }),
      },
      gateway: { provider, model, provider_configured: providerConfigured(), data_dir: dataDir },
      brain: { available: brain.available(), role: "memory_only", slug_prefix: brain.slugPrefix },
      voice: {
        stream_provider: voiceSessionServer.status(),
        transcript_turn_endpoint: "/v1/voice/turns",
        streaming_endpoint: voiceSessionServer.endpoint,
      },
      harnesses: harnessStatus(),
      work_graph: {
        total: nodes.length,
        by_status: byStatus,
        active: nodes.filter((node) => ["open", "running", "blocked"].includes(node.status)).slice(0, 25).map(workNodeSummary),
      },
      agent_runs: {
        active: allRuns.filter((run) => !isTerminalRunStatus(run.status)),
        recent: allRuns.slice(0, 25),
      },
    };
  }

  function workNodeSummary(node) {
    return {
      id: node.id,
      title: node.title,
      status: node.status,
      parent_id: node.parentId,
      executor: node.executor,
      queue_count: Array.isArray(node.queue) ? node.queue.length : 0,
      next_step: node.nextStep || "",
      effective_instruction: truncate(effectiveInstruction(node), 240),
      updated_at: node.updatedAt,
    };
  }

  return { routeSupervisor, statusPayload, workNodeSummary };
}

module.exports = { createSupervisorHandlers };
