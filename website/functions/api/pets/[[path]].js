// Gateway-backed pet studio proxy.
// Keeps MOA_GATEWAY_TOKEN in Cloudflare Pages secrets instead of browser JS.

const ROUTES = new Map([
  ["", "/v1/agent/pets"],
  ["preview", "/v1/agent/pets/preview"],
  ["apply", "/v1/agent/pets/apply"],
  ["generate", "/v1/agent/pets/generate"],
  ["companions", "/v1/agent/companions"],
  ["active", "/v1/agent/pets/active"],
  ["agents", "/v1/agent/pets/agents"],
  ["bookmarks", "/v1/agent/pets/bookmarks"],
]);

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

export async function onRequest({ request, env, params }) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (request.method !== "GET" && request.method !== "POST") {
    return json(405, { error: "Use GET or POST." });
  }

  const key = routeKey(params?.path);
  const upstreamPath = upstreamPathFor(key);
  if (!upstreamPath) {
    return json(404, { error: "Unknown pet studio route." });
  }

  const base = stripTrailingSlash(env.MOA_GATEWAY_URL || env.AG_GATEWAY_URL || "");
  const token = env.MOA_GATEWAY_TOKEN || env.AG_GATEWAY_TOKEN || "";
  if (!base || !token) {
    return json(503, {
      error: "Pet studio gateway is not configured.",
      requirement: "Set MOA_GATEWAY_URL and MOA_GATEWAY_TOKEN as Pages secrets.",
    });
  }

  const inputUrl = new URL(request.url);
  const upstreamUrl = `${base}${upstreamPath}${inputUrl.search}`;
  const upstream = await fetch(upstreamUrl, {
    method: request.method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": request.headers.get("content-type") || "application/json",
      "x-moa-surface": "website-pet-studio",
    },
    body: request.method === "GET" ? undefined : request.body,
  });

  const headers = corsHeaders();
  headers.set("content-type", upstream.headers.get("content-type") || "application/json; charset=utf-8");
  return new Response(upstream.body, { status: upstream.status, headers });
}

function routeKey(path) {
  if (Array.isArray(path)) return path.filter(Boolean).join("/");
  return String(path || "").replace(/^\/+|\/+$/g, "");
}

function upstreamPathFor(key) {
  if (ROUTES.has(key)) return ROUTES.get(key);
  if (/^agents\/[^/]+$/.test(key)) return `/v1/agent/pets/${key}`;
  if (/^bookmarks\/[^/]+$/.test(key)) return `/v1/agent/pets/${key}`;
  return "";
}

function stripTrailingSlash(value) {
  return String(value || "").replace(/\/+$/g, "");
}

function corsHeaders() {
  return new Headers({
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
  });
}
