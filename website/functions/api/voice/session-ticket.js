// Voice session ticket mint for the website pet studio.
// Keeps MOA_GATEWAY_TOKEN in Cloudflare Pages secrets instead of browser JS:
// the browser gets only a short-lived ticket plus the wss:// URL and connects
// the voice websocket directly to the gateway with ticket auth.

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: withCors({ "content-type": "application/json; charset=utf-8" }),
  });

export async function onRequest({ request, env }) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: withCors({}) });
  }
  if (request.method !== "POST") {
    return json(405, { error: "Use POST." });
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

  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const upstream = await fetch(`${base}/v1/voice/session-ticket`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-moa-surface": "website-pet-studio",
    },
    body: JSON.stringify({
      source: "website-pet-studio",
      session_id: cleanId(body.session_id),
      device_id: cleanId(body.device_id),
    }),
  });

  const headers = withCors({
    "content-type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
  });
  return new Response(upstream.body, { status: upstream.status, headers });
}

function cleanId(value) {
  return String(value || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 160) || undefined;
}

function stripTrailingSlash(value) {
  return String(value || "").replace(/\/+$/g, "");
}

function withCors(entries) {
  const headers = new Headers(entries);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "POST,OPTIONS");
  headers.set("access-control-allow-headers", "content-type");
  return headers;
}
