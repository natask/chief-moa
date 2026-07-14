// Agent profile options proxy for the website companion dashboard.
// GET /api/profile/options returns the gateway's canonical voice, language,
// and persona catalogs so the site never hardcodes the voice list. Read-only;
// the gateway token stays in Cloudflare Pages secrets.

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: withCors({ "content-type": "application/json; charset=utf-8" }),
  });

export async function onRequest({ request, env }) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: withCors({}) });
  }
  if (request.method !== "GET") {
    return json(405, { error: "Use GET." });
  }

  const base = stripTrailingSlash(env.MOA_GATEWAY_URL || env.AG_GATEWAY_URL || "");
  const token = env.MOA_GATEWAY_TOKEN || env.AG_GATEWAY_TOKEN || "";
  if (!base || !token) {
    const missing = [];
    if (!base) missing.push("MOA_GATEWAY_URL");
    if (!token) missing.push("MOA_GATEWAY_TOKEN");
    return json(503, {
      error: "Profile options gateway is not configured.",
      missing,
      requirement: "Set MOA_GATEWAY_URL and MOA_GATEWAY_TOKEN as Pages secrets.",
    });
  }

  const upstream = await fetch(`${base}/v1/agent/profile/options`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      "x-moa-surface": "website-pet-studio",
    },
  });

  const headers = withCors({
    "content-type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
  });
  return new Response(upstream.body, { status: upstream.status, headers });
}

function stripTrailingSlash(value) {
  return String(value || "").replace(/\/+$/g, "");
}

function withCors(entries) {
  const headers = new Headers(entries);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET,OPTIONS");
  headers.set("access-control-allow-headers", "content-type");
  return headers;
}
