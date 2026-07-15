"use strict";

function createEventProjectHandlers(deps) {
  const { eventSubstrate, normalizeEventType, authorized, authorizedAgent, agentAuthError,
    projectStore, readJsonBody, sendJson, cleanError, databaseConfigured = false } = deps;

  async function routeEventProjects(request, response, url) {
    const pathname = url.pathname;
    if (pathname === "/v1/events/status" && request.method === "GET") {
      if (!authorized(request)) return denyGateway(response);
      sendJson(response, 200, { event_substrate: await eventStatus() }); return true;
    }
    if (pathname === "/v1/events" && request.method === "GET") {
      if (!authorized(request)) return denyGateway(response);
      sendJson(response, 200, { events: await eventSubstrate.listEvents({
        event_type: query(url, "event_type", "eventType"),
        event_type_prefix: query(url, "event_type_prefix", "eventTypePrefix"),
        stream_id: query(url, "stream_id", "streamId"), origin_id: query(url, "origin_id", "originId"),
        correlation_id: query(url, "correlation_id", "correlationId"),
        idempotency_key: query(url, "idempotency_key", "idempotencyKey"),
        order: url.searchParams.get("order") || "", limit: Number(url.searchParams.get("limit") || 100),
      }) });
      return true;
    }
    if (pathname === "/v1/events" && request.method === "POST") {
      if (!authorized(request)) return denyGateway(response);
      await createEvent(request, response); return true;
    }
    const isProjects = pathname === "/v1/projects";
    const projectId = pathname.startsWith("/v1/projects/") ? pathname.slice("/v1/projects/".length) : "";
    if (!(isProjects || projectId)) return false;
    if (!authorizedAgent(request)) {
      sendJson(response, 401, agentAuthError()); return true;
    }
    if (isProjects && request.method === "GET") {
      sendJson(response, 200, { projects: projectStore.list() }); return true;
    }
    if (isProjects && request.method === "POST") {
      await createProject(request, response); return true;
    }
    if (projectId && request.method === "PATCH") {
      await updateProject(request, response, decodeURIComponent(projectId)); return true;
    }
    return false;
  }

  function denyGateway(response) {
    sendJson(response, 401, { error: "missing or invalid gateway token" }); return true;
  }

  async function eventStatus() {
    try { return await eventSubstrate.storageInfo(); }
    catch (error) { return { mode: "error", error: cleanError(error), postgres_configured: databaseConfigured }; }
  }

  async function createEvent(request, response) {
    const body = await readJsonBody(request);
    try {
      const type = normalizeEventType(body.event_type || body.eventType || body.type);
      if (type === "telemetry.semantic.v1") throw new Error("semantic telemetry event type is reserved for the internal validated exporter");
      const event = await eventSubstrate.appendEvent({ ...body, actor: body.actor || { kind: "gateway", id: "api" } });
      sendJson(response, 201, { event });
    } catch (error) { sendJson(response, 400, { error: cleanError(error) }); }
  }

  async function createProject(request, response) {
    const body = await readJsonBody(request);
    try { sendJson(response, 201, { project: projectStore.create(body) }); }
    catch (error) { sendJson(response, 400, { error: cleanError(error) }); }
  }

  async function updateProject(request, response, id) {
    const body = await readJsonBody(request);
    try {
      const project = projectStore.update(id, body);
      if (!project) { sendJson(response, 404, { error: "project not found" }); return; }
      sendJson(response, 200, { project });
    } catch (error) { sendJson(response, 400, { error: cleanError(error) }); }
  }

  return { routeEventProjects, eventStatus, createEvent, createProject, updateProject };
}

function query(url, preferred, alias) { return url.searchParams.get(preferred) || url.searchParams.get(alias) || ""; }

module.exports = { createEventProjectHandlers, query };
