#!/usr/bin/env node
import fs from "node:fs/promises";
import process from "node:process";
import { IntentLauncherClient, IntentLauncherError } from "./index.js";

const COMMANDS = new Map([
  ["message:create", ["createMessage"]],
  ["intent:create", ["createIntent"]],
  ["intent:search", ["searchIntents"]],
  ["intent:get", ["getIntent", "id"]],
  ["intent:update", ["updateIntent", "id"]],
  ["intent:fork", ["forkIntent", "id"]],
  ["intent:relate", ["relateIntents", "id"]],
  ["intent:claim", ["claimWork", "id"]],
  ["intent:release", ["releaseWork", "id"]],
  ["intent:progress", ["reportProgress", "id"]],
  ["intent:propose-completion", ["proposeCompletion", "id"]],
  ["agent:search", ["searchAgents"]],
  ["agent:get", ["getAgent", "id"]],
  ["run:search", ["searchRuns"]],
  ["run:get", ["getRun", "id"]],
  ["product:attach", ["attachProduct", "id"]],
  ["product:search", ["searchProducts"]],
  ["product:get", ["getProduct", "product"]],
  ["attention:create", ["createAttentionItem", "id"]],
  ["attention:search", ["searchAttentionItems"]],
  ["attention:get", ["getAttentionItem", "id"]],
  ["status:read", ["readStatus"]],
]);

function usage() {
  return `Usage: intent-launcher <resource> <operation> [id] [--input <file|->]

Credentials are read only from MOA_INTENT_PLANE_TOKEN. The default input is
JSON on stdin. Search/status input is a JSON filter object. Product get expects
the Product id as [id] and {"revision":"..."} in its input.

Examples:
  intent-launcher intent search --input filters.json
  printf '%s' '{"statement":"..."}' | intent-launcher intent create
  intent-launcher product get widget --input revision.json`;
}

async function readInput(argv) {
  const index = argv.indexOf("--input");
  const source = index >= 0 ? argv[index + 1] : "-";
  if (index >= 0 && !source) throw new TypeError("--input requires a file path or -");
  const raw = source === "-" ? await new Promise((resolve, reject) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { text += chunk; });
    process.stdin.on("end", () => resolve(text));
    process.stdin.on("error", reject);
  }) : await fs.readFile(source, "utf8");
  return raw.trim() ? JSON.parse(raw) : {};
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.length < 2) {
    process.stdout.write(`${usage()}\n`);
    return argv.includes("--help") ? 0 : 2;
  }
  const key = `${argv[0]}:${argv[1]}`;
  const spec = COMMANDS.get(key);
  if (!spec) throw new TypeError(`unknown command: ${argv[0]} ${argv[1]}`);
  const input = await readInput(argv);
  const token = process.env.MOA_INTENT_PLANE_TOKEN;
  if (!token) throw new IntentLauncherError("MOA_INTENT_PLANE_TOKEN is required", { code: "MISSING_CREDENTIAL" });
  const client = new IntentLauncherClient({
    baseUrl: process.env.MOA_INTENT_PLANE_URL || "https://api.agee.app",
    token,
    timeoutMs: process.env.MOA_INTENT_PLANE_TIMEOUT_MS,
  });
  const [method, shape] = spec;
  let result;
  if (shape === "id") {
    const id = argv[2] && argv[2] !== "--input" ? argv[2] : "";
    result = await client[method](id, input);
  } else if (shape === "product") {
    const id = argv[2] && argv[2] !== "--input" ? argv[2] : "";
    result = await client[method](id, input.revision, input.filters || {});
  } else {
    result = await client[method](input);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, data: result })}\n`);
  return 0;
}

main().then((code) => { process.exitCode = code; }).catch((error) => {
  const normalized = error instanceof IntentLauncherError
    ? error.toJSON()
    : { error: { code: "INVALID_INPUT", message: error?.message || String(error) } };
  process.stderr.write(`${JSON.stringify({ ok: false, ...normalized })}\n`);
  process.exitCode = 1;
});
