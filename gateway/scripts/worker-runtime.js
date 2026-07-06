#!/usr/bin/env node
"use strict";

// CLI for the execution-machine worker pull loop. Runs on the machine that
// owns harness credentials and repos; connects outbound to the gateway URL.
// No inbound listener is opened. Configuration comes from flags or
// MOA_WORKER_* env vars; the worker token is never printed.
//
// First registration (echo only — deterministic, no model key):
//   node scripts/worker-runtime.js \
//     --gateway-url https://api.example.com \
//     --registration-id wreg_... --setup-code MOA-WORKER-XXXX-XXXX \
//     --state-file ~/.moa/worker-state.json --project proj_chief_moa:chief-moa
//
// With real harnesses (only those whose command resolves on this PATH run):
//   node scripts/worker-runtime.js \
//     --gateway-url https://api.example.com \
//     --state-file ~/.moa/worker-state.json \
//     --harness codex,claude,gemini \
//     --project proj_chief_moa:chief-moa:/Users/me/projs/chief-moa
//   (omit --harness to auto-detect every available harness; --harness-workdir
//    sets the default run directory when a project has no path)
//
// Later runs reuse the state file (or MOA_WORKER_TOKEN + MOA_WORKER_ID).

const { createWorkerRuntime } = require("../lib/worker-runtime");

main().catch((error) => {
  console.error(`[worker] fatal ${error.code || ""} ${error.message || String(error)}`.trim());
  process.exitCode = 1;
});

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = process.env;
  const runtime = createWorkerRuntime({
    gatewayUrl: args["gateway-url"] || env.MOA_WORKER_GATEWAY_URL || "",
    token: args.token || env.MOA_WORKER_TOKEN || "",
    workerId: args["worker-id"] || env.MOA_WORKER_ID || "",
    registrationId: args["registration-id"] || env.MOA_WORKER_REGISTRATION_ID || "",
    setupCode: args["setup-code"] || env.MOA_WORKER_SETUP_CODE || "",
    stateFile: args["state-file"] || env.MOA_WORKER_STATE_FILE || "",
    name: args.name || env.MOA_WORKER_NAME || "Moa worker",
    machineLabel: args["machine-label"] || env.MOA_WORKER_MACHINE_LABEL || "",
    projects: parseProjects(args.project || env.MOA_WORKER_PROJECTS || ""),
    projectAliases: args["project-alias"] || env.MOA_WORKER_PROJECT_ALIASES || "",
    // Real harnesses to offer beyond the built-in echo. Empty = auto-detect
    // every harness whose command resolves on this machine's PATH.
    harnesses: args.harness || env.MOA_WORKER_HARNESSES || "",
    // Where real harnesses run. Default is the current directory; a per-project
    // path can be given as the 3rd ":" segment of --project.
    harnessWorkdir: args["harness-workdir"] || env.MOA_WORKER_HARNESS_WORKDIR || "",
    once: args.once === true || env.MOA_WORKER_ONCE === "1",
    maxIdleMs: args["max-idle-ms"] || env.MOA_WORKER_MAX_IDLE_MS || 0,
    idleDelayMs: args["idle-delay-ms"] || env.MOA_WORKER_IDLE_DELAY_MS,
    claimWaitMs: args["claim-wait-ms"] || env.MOA_WORKER_CLAIM_WAIT_MS,
    requestTimeoutMs: args["request-timeout-ms"] || env.MOA_WORKER_REQUEST_TIMEOUT_MS,
  });
  const summary = await runtime.runLoop();
  console.log(JSON.stringify({ ok: summary.ok, idle: summary.idle, processed: summary.processed }));
  if (!summary.ok) process.exitCode = 1;
}

function parseProjects(value) {
  // Each entry is "id", "id:alias", or "id:alias:/abs/local/path". The path is
  // worker-local and is never sent to the gateway.
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [id, alias, ...rest] = item.split(":");
      return { id, local_alias: alias || id, path: rest.join(":") || "" };
    });
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith("--")) continue;
    const key = raw.slice(2);
    const next = argv[i + 1];
    if (key === "once") {
      args.once = true;
    } else if (next != null && !next.startsWith("--")) {
      const accumulate = (key === "project-alias" || key === "harness" || key === "project") && args[key];
      args[key] = accumulate ? `${args[key]},${next}` : next;
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}
