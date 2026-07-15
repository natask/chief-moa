// Send a short-lived reload signal to an unpacked Aggie extension.
//
// The extension's dev-reload path polls /__agee-dev/version when enabled from
// extension/dev.html. This script serves a fresh version briefly, long enough
// for the loaded extension to observe it and call chrome.runtime.reload().

import { createServer } from "node:http";

const host = process.env.AGEE_DEV_RELOAD_HOST || "localhost";
const port = Number(process.env.AGEE_DEV_RELOAD_PORT || 7777);
// 30s alarm cadence for a sleeping service worker + margin.
const holdMs = Number(process.env.AGEE_DEV_RELOAD_HOLD_MS || 40000);
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
    const bumped = await bumpExistingServer();
    if (bumped) return true;
    console.log("[agee-deploy] existing dev server does not expose /__agee-dev/bump; could not force a reload version.");
    console.log("[agee-deploy] If the unpacked extension has auto-reload enabled, it may still observe source edits from the running dev server.");
    return true;
  } catch {
    return false;
  }
}

async function bumpExistingServer() {
  try {
    const bumpEndpoint = `http://${host}:${port}/__agee-dev/bump?source=deploy&ts=${Date.now()}`;
    const resp = await fetch(bumpEndpoint, { method: "POST", cache: "no-store" });
    if (!resp.ok) return false;
    const info = await resp.json();
    console.log(`[agee-deploy] asked existing dev server to bump reload version to ${info.version || "unknown"}.`);
    console.log("[agee-deploy] If the unpacked extension has auto-reload enabled, it should reload from this checkout.");
    return true;
  } catch {
    return false;
  }
}

// Observed polls are the reload evidence: the loaded extension fetches
// /__agee-dev/version every 1.5s while its worker is awake and every 30s via
// alarm while asleep. Zero polls over the hold window means the bridge is not
// running in the loaded build (or Chrome is closed) — report that plainly
// instead of pretending the poke worked.
let observedPolls = 0;

const server = createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${host}:${port}`);
  if (url.pathname === "/__agee-dev/version") {
    observedPolls += 1;
    if (observedPolls === 1) {
      console.log("[agee-deploy] a loaded extension polled the reload endpoint.");
    }
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
  console.log(`[agee-deploy] holding up to ${Math.round(holdMs / 1000)}s so a loaded unpacked extension can reload.`);
  const startedAt = Date.now();
  const finish = () => {
    server.close(() => {
      if (observedPolls >= 2) {
        console.log(`[agee-deploy] reload CONFIRMED: extension polled ${observedPolls} times (bump observed and re-polled after reload/record).`);
      } else if (observedPolls === 1) {
        console.log("[agee-deploy] reload LIKELY: one poll observed. First-ever poll only records a baseline; the next deploy reloads automatically.");
      } else {
        console.log("[agee-deploy] reload UNVERIFIED: no client polled during the hold window.");
        console.log("[agee-deploy] The loaded build predates the auto-enabled bridge (or Chrome is closed). Reload once at chrome://extensions; every later deploy reloads automatically.");
      }
    });
  };
  const ticker = setInterval(() => {
    // End early once the post-reload (or post-record) second poll arrives, but
    // give a sleeping service worker its 30s alarm plus margin otherwise.
    if (observedPolls >= 2 || Date.now() - startedAt >= holdMs) {
      clearInterval(ticker);
      finish();
    }
  }, 500);
});
