// Stored voice-turn audio proxy for the website companion dashboard.
// GET /api/voice/audio?session_id=..&turn_id=..&kind=assistant streams the
// archived PCM16@16k for a stored turn (the original spoken reply, or the
// user's own recording) from the gateway. The token stays in Pages secrets.

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
  const turnId = cleanId(inputUrl.searchParams.get("turn_id"));
  if (!sessionId || !turnId) {
    return json(400, { error: "session_id and turn_id are required." });
  }
  const kind = inputUrl.searchParams.get("kind") === "assistant" ? "assistant" : "user";

  const upstream = await fetch(
    `${base}/v1/voice/audio/${encodeURIComponent(sessionId)}/${encodeURIComponent(turnId)}?kind=${kind}`,
    {
      headers: {
        authorization: `Bearer ${token}`,
        "x-moa-surface": "website-pet-studio",
      },
    },
  );

  const headers = withCors({
    "content-type": upstream.headers.get("content-type") || "application/octet-stream",
    "cache-control": "private, no-store",
  });
  for (const name of ["x-moa-session-id", "x-moa-turn-id", "x-moa-audio-kind"]) {
    const value = upstream.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
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
  headers.set("access-control-expose-headers", "x-moa-session-id,x-moa-turn-id,x-moa-audio-kind");
  return headers;
}
