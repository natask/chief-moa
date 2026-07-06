#!/usr/bin/env node
// Persona testbed UI server. Serves index.html and proxies persona/probe
// requests to the configured middle models. No dependencies. Never touches
// the live gateway.
//
// Usage:
//   node server.mjs                       # http://127.0.0.1:8899
//   node --env-file=.env server.mjs       # with OpenAI/Grok/Claude keys
//   node server.mjs --port 9000 --host 0.0.0.0
//
// On the droplet, keep the bind on 127.0.0.1 and reach it with an ssh tunnel:
//   ssh -L 8899:localhost:8899 root@<droplet>
// The server holds provider credentials; never expose it on a public port.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import {
  DEFAULT_PROBES,
  buildSystemInstruction,
  defaultPersona,
  gatewayStack,
  providerStatus,
  askProvider,
} from "./providers.mjs";

const here = path.dirname(new URL(import.meta.url).pathname);

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) args[a.slice(2)] = argv[++i];
  }
  return args;
}
const args = parseArgs(process.argv.slice(2));
const PORT = Number(args.port || process.env.PORT || 8899);
const HOST = args.host || "127.0.0.1";

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(payload);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
    if (Buffer.concat(chunks).length > 256 * 1024) throw new Error("body too large");
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      // Read per request so UI edits show on refresh without a restart.
      const html = fs.readFileSync(path.join(here, "index.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(html);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/config") {
      json(res, 200, {
        providers: providerStatus(),
        persona: defaultPersona(),
        probes: DEFAULT_PROBES,
        stack: gatewayStack(),
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/ask") {
      const body = await readJsonBody(req);
      const provider = String(body.provider || "").trim();
      const question = String(body.question || "").trim();
      if (!provider || !question) {
        json(res, 400, { error: "provider and question are required" });
        return;
      }
      const systemInstruction = buildSystemInstruction(String(body.persona || ""), {
        noStack: body.noStack === true,
      });
      const started = Date.now();
      const { model, text } = await askProvider(provider, {
        question,
        systemInstruction,
        model: String(body.model || "").trim(),
      });
      json(res, 200, { provider, model, text, ms: Date.now() - started });
      return;
    }
    json(res, 404, { error: "not found" });
  } catch (error) {
    json(res, 500, { error: String(error?.message || error) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`persona testbed UI on http://${HOST}:${PORT}`);
  console.log(`providers: ${providerStatus().map((p) => `${p.id}${p.configured ? "" : " (needs " + p.keyHint + ")"}`).join(", ")}`);
});
