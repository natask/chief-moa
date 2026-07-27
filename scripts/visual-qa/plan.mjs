#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const REQUIRED_STATES = [
  "idle", "user_stream_short", "user_stream_tail", "assistant_stream_tail",
  "expanded_transcript", "engaged", "light_background", "dark_background", "large_text",
];

export function validateManifest(value, root = process.cwd()) {
  const errors = [];
  if (value?.schema_version !== 1) errors.push("schema_version must be 1");
  if (!/^[0-9a-f]{40}$/.test(value?.candidate_commit || "")) errors.push("candidate_commit must be a 40-character lowercase git SHA");
  for (const surface of ["android", "browser"]) {
    if (!/^sha256:[0-9a-f]{64}$/.test(value?.artifact_digests?.[surface] || "")) errors.push(`artifact_digests.${surface} must be sha256:<64 lowercase hex>`);
  }
  if (value?.rounds !== 2) errors.push("rounds must equal 2");
  if (value?.critique?.command !== "claude") errors.push("critique.command must be claude");
  if (value?.critique?.requested_model !== "opus") errors.push("critique.requested_model must be opus");
  const states = Array.isArray(value?.states) ? value.states : [];
  for (const state of REQUIRED_STATES) if (!states.includes(state)) errors.push(`missing required state: ${state}`);
  if (new Set(states).size !== states.length) errors.push("states must not contain duplicates");
  const references = (Array.isArray(value?.references) ? value.references : []).map((item) => ({
    path: item?.path || "",
    required: item?.required === true,
    provenance: item?.provenance || "",
    status: item?.path && existsSync(resolve(root, item.path)) ? "present" : "missing_reference",
  }));
  for (const item of references) {
    if (!item.path || !item.provenance) errors.push("each reference requires path and provenance");
    if (item.required && item.status !== "present") errors.push(`required reference is missing: ${item.path}`);
  }
  return { ok: errors.length === 0, errors, references, states: REQUIRED_STATES };
}

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--manifest") {
    console.error("usage: node scripts/visual-qa/plan.mjs --manifest <json>");
    process.exit(2);
  }
  const manifestPath = resolve(args[1]);
  const result = validateManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
  console.log(JSON.stringify({ mode: "dry_run", manifest: manifestPath, ...result }, null, 2));
  if (!result.ok) process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) main();
