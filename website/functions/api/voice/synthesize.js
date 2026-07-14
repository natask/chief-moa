// Reply re-voicing proxy for the website companion dashboard.
// POSTs bounded reply text (plus an optional catalog voice + speaking rate) to
// the gateway's hosted TTS hook and streams the raw PCM16@16k response back,
// preserving the x-moa-audio-* headers the browser player reads. The gateway
// token stays in Cloudflare Pages secrets.

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: withCors({ "content-type": "application/json; charset=utf-8" }),
  });

const AUDIO_HEADERS = [
  "x-moa-audio-encoding",
  "x-moa-audio-sample-rate",
  "x-moa-audio-channels",
  "x-moa-reply-language",
  "x-moa-voice",
];

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
  const text = String(body.text || "").trim().slice(0, 4000);
  if (!text) {
    return json(400, { error: "text is required." });
  }
  const payload = { text };
  const voice = String(body.voice || "").trim().slice(0, 60);
  if (voice) payload.voice = voice;
  const language = String(body.language || "").trim().slice(0, 40);
  if (language) payload.language = language;
  const style = String(body.tts_style || body.style || "").trim().slice(0, 400);
  if (style) payload.tts_style = style;
  const rate = Number(body.speaking_rate);
  if (Number.isFinite(rate) && rate > 0) payload.speaking_rate = rate;

  const upstream = await fetch(`${base}/v1/internal/voice/synthesize`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-moa-surface": "website-pet-studio",
    },
    body: JSON.stringify(payload),
  });

  const headers = withCors({
    "content-type": upstream.headers.get("content-type") || "application/octet-stream",
    "cache-control": "private, no-store",
  });
  for (const name of AUDIO_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}

function stripTrailingSlash(value) {
  return String(value || "").replace(/\/+$/g, "");
}

function withCors(entries) {
  const headers = new Headers(entries);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "POST,OPTIONS");
  headers.set("access-control-allow-headers", "content-type");
  headers.set("access-control-expose-headers", AUDIO_HEADERS.join(","));
  return headers;
}
