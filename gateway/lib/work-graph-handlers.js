"use strict";

function createWorkGraphHandlers(deps) {
  const { workGraph, authorizedAgent, agentAuthError, sendJson, sendWorkNode,
    handleCreateWorkNode, handleWorkNodeAction, handleCreateWorkEvent, handleCreateWorkArtifact } = deps;

  async function routeWorkGraph(request, response, url) {
    const pathname = url.pathname;
    if (!pathname.startsWith("/v1/work/")) return false;
    if (!authorizedAgent(request)) {
      sendJson(response, 401, agentAuthError());
      return true;
    }
    if (pathname === "/v1/work/nodes" && request.method === "GET") {
      const status = url.searchParams.get("status") || "";
      sendJson(response, 200, { nodes: await workGraph.list(status ? { status } : {}) });
      return true;
    }
    if (pathname === "/v1/work/nodes" && request.method === "POST") {
      await handleCreateWorkNode(request, response); return true;
    }
    if (pathname === "/v1/work/events" && request.method === "GET") {
      sendJson(response, 200, { events: await workGraph.listEvents({
        node_id: query(url, "node_id", "nodeId"), run_id: query(url, "run_id", "runId"),
        limit: Number(url.searchParams.get("limit") || 200),
      }) });
      return true;
    }
    if (pathname === "/v1/work/events" && request.method === "POST") {
      await handleCreateWorkEvent(request, response); return true;
    }
    if (pathname === "/v1/work/artifacts" && request.method === "GET") {
      sendJson(response, 200, { artifacts: await workGraph.listArtifacts({
        node_id: query(url, "node_id", "nodeId"), run_id: query(url, "run_id", "runId"),
        kind: url.searchParams.get("kind") || "", q: query(url, "q", "query"),
        limit: Number(url.searchParams.get("limit") || 100),
      }) });
      return true;
    }
    if (pathname === "/v1/work/artifacts" && request.method === "POST") {
      await handleCreateWorkArtifact(request, response); return true;
    }
    if (pathname.startsWith("/v1/work/nodes/") && request.method === "GET") {
      await sendWorkNode(response, pathname.slice("/v1/work/nodes/".length)); return true;
    }
    if (pathname.startsWith("/v1/work/nodes/") && request.method === "POST") {
      await handleWorkNodeAction(request, response, pathname.slice("/v1/work/nodes/".length)); return true;
    }
    return false;
  }
  return { routeWorkGraph };
}

function query(url, preferred, alias) {
  return url.searchParams.get(preferred) || url.searchParams.get(alias) || "";
}

module.exports = { createWorkGraphHandlers, query };
