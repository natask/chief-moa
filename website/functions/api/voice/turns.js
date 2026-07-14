// Voice-turn history proxy for the website companion dashboard.
// Keeps MOA_GATEWAY_TOKEN in Cloudflare Pages secrets instead of browser JS:
// the browser asks for a session's stored turns (transcript + reply text +
// audio availability) and the token rides only on the server-side hop.

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
      error: "Voice gateway is not configured.",
      missing,
      requirement: "Set MOA_GATEWAY_URL and MOA_GATEWAY_TOKEN as Pages secrets.",
    });
  }

  const inputUrl = new URL(request.url);
  const sessionId = cleanId(inputUrl.searchParams.get("session_id"));
  if (!sessionId) {
    return json(400, { error: "session_id is required." });
  }
  const upstreamUrl = new URL(`${base}/v1/voice/turns`);
  upstreamUrl.searchParams.set("session_id", sessionId);
  const branchId = cleanId(inputUrl.searchParams.get("branch_id"));
  if (branchId) upstreamUrl.searchParams.set("branch_id", branchId);
  const limit = Number(inputUrl.searchParams.get("limit") || 0);
  if (Number.isFinite(limit) && limit > 0) {
    upstreamUrl.searchParams.set("limit", String(Math.min(limit, 200)));
  }

  const upstream = await fetch(upstreamUrl, {
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

function cleanId(value) {
  return String(value || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 160);
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
