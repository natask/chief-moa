// Send a short-lived reload signal to an unpacked Chief AG extension.
//
// The extension's dev-reload path polls /__agee-dev/version when enabled from
// extension/dev.html. This script serves a fresh version briefly, long enough
// for the loaded extension to observe it and call chrome.runtime.reload().

import { createServer } from "node:http";

const host = process.env.AGEE_DEV_RELOAD_HOST || "localhost";
const port = Number(process.env.AGEE_DEV_RELOAD_PORT || 7777);
const holdMs = Number(process.env.AGEE_DEV_RELOAD_HOLD_MS || 12000);
const version = Date.now();
const changedAt = new Date().toISOString();
const endpoint = `http://${host}:${port}/__agee-dev/version`;

function sendJson(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  });
  res.end(`${JSON.stringify(body)}\n`);
}

async function checkExistingServer() {
  try {
    const resp = await fetch(`${endpoint}?ts=${Date.now()}`, { cache: "no-store" });
    if (!resp.ok) return false;
    const info = await resp.json();
    console.log(`[agee-deploy] dev reload endpoint already served version ${info.version || "unknown"}.`);
    console.log("[agee-deploy] If the unpacked extension has auto-reload enabled, it should already observe source edits.");
    return true;
  } catch {
    return false;
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${host}:${port}`);
  if (url.pathname === "/__agee-dev/version") {
    sendJson(res, 200, { version, changedAt, source: "chief-moa-deploy" });
    return;
  }
  sendJson(res, 404, { error: "not found" });
});

server.on("error", async (error) => {
  if (error?.code === "EADDRINUSE" && await checkExistingServer()) {
    process.exit(0);
  }
  console.error(`[agee-deploy] could not serve ${endpoint}: ${error.message}`);
  process.exit(1);
});

server.listen(port, host, () => {
  console.log(`[agee-deploy] serving reload version ${version} at ${endpoint}`);
  console.log(`[agee-deploy] holding for ${Math.round(holdMs / 1000)}s so a loaded unpacked extension can reload.`);
  setTimeout(() => {
    server.close(() => {
      console.log("[agee-deploy] reload signal complete.");
    });
  }, holdMs);
});
