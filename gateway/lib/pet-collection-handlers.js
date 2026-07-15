"use strict";

function createPetCollectionHandlers({
  companionCatalog,
  catalogVersion,
  authorizedAgent,
  agentAuthError,
  readJsonBody,
  sendJson,
  cleanError,
  petInputFromBody,
  manifestV2FieldsFromBody,
  petPreviewPayload,
}) {
  function authorize(request, response) {
    if (authorizedAgent(request)) return true;
    sendJson(response, 401, agentAuthError());
    return false;
  }

  function collectionPayload(url, kind) {
    const query = url?.searchParams?.get("q") || url?.searchParams?.get("query") || "";
    const limit = Number(url?.searchParams?.get("limit") || 100);
    if (kind === "agents") {
      return {
        version: catalogVersion,
        generated_at: new Date().toISOString(),
        query,
        agents: companionCatalog.listAgents({ query, limit }),
        endpoints: {
          list: "/v1/agent/pets/agents",
          create: "/v1/agent/pets/agents",
          bookmarks: "/v1/agent/pets/bookmarks",
        },
      };
    }
    return {
      version: catalogVersion,
      generated_at: new Date().toISOString(),
      query,
      bookmarks: companionCatalog.listBookmarks({ query, limit }),
      endpoints: {
        list: "/v1/agent/pets/bookmarks",
        create: "/v1/agent/pets/bookmarks",
        agents: "/v1/agent/pets/agents",
      },
    };
  }

  async function createAgent(request, response) {
    const body = await readJsonBody(request);
    try {
      const agent = companionCatalog.createAgent({
        text: body?.text || body?.request || body?.prompt || body?.description,
        name: body?.name,
        voice: body?.voice,
        pet: petInputFromBody(body),
        image_data_url: body?.image_data_url || body?.imageDataUrl || body?.source_image || body?.sourceImage,
        rules: body?.rules,
        ...manifestV2FieldsFromBody(body),
      });
      const preview = companionCatalog.preview({ companion_id: agent.companion_id });
      sendJson(response, 201, {
        version: catalogVersion,
        agent,
        preview: petPreviewPayload(preview),
        active_profile_mutated: false,
      });
    } catch (error) {
      sendJson(response, 400, { error: cleanError(error) });
    }
  }

  async function createBookmark(request, response) {
    const body = await readJsonBody(request);
    try {
      sendJson(response, 201, {
        version: catalogVersion,
        bookmark: companionCatalog.createBookmark(body || {}),
      });
    } catch (error) {
      sendJson(response, 404, { error: cleanError(error) });
    }
  }

  async function routePetCollections(request, response, url) {
    const collection = url.pathname.match(/^\/v1\/agent\/pets\/(agents|bookmarks)$/);
    if (collection && request.method === "GET") {
      if (!authorize(request, response)) return true;
      sendJson(response, 200, collectionPayload(url, collection[1]));
      return true;
    }
    if (collection && request.method === "POST") {
      if (!authorize(request, response)) return true;
      if (collection[1] === "agents") await createAgent(request, response);
      else await createBookmark(request, response);
      return true;
    }
    const item = url.pathname.match(/^\/v1\/agent\/pets\/(agents|bookmarks)\/([^/]+)$/);
    if (item && request.method === "GET") {
      if (!authorize(request, response)) return true;
      const kind = item[1];
      const value = kind === "agents"
        ? companionCatalog.getAgent(decodeURIComponent(item[2]))
        : companionCatalog.getBookmark(decodeURIComponent(item[2]));
      if (!value) {
        sendJson(response, 404, { error: kind === "agents" ? "agent not found" : "bookmark not found" });
        return true;
      }
      sendJson(response, 200, {
        version: catalogVersion,
        [kind === "agents" ? "agent" : "bookmark"]: value,
      });
      return true;
    }
    return false;
  }

  return { routePetCollections, collectionPayload, createAgent, createBookmark };
}

module.exports = { createPetCollectionHandlers };
