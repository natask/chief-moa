#!/usr/bin/env node
"use strict";

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const VERSION = "moa-release-evidence/v1";
const SHA256 = /^[a-f0-9]{64}$/;
const GIT_SHA = /^[a-f0-9]{40}$/;
const ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

const SURFACES = Object.freeze({
  android: {
    publication: ["built", "verified", "platform_signed", "packaged", "device_qa"],
    production: ["published", "offered", "installed", "smoked"],
  },
  browser_extension: {
    publication: ["built", "verified", "packaged", "browser_qa"],
    production: ["published", "installed", "smoked"],
  },
  web: {
    publication: ["built", "verified", "previewed"],
    production: ["published", "smoked"],
  },
  gateway: {
    publication: ["built", "verified", "previewed", "backup_restored"],
    production: ["published", "smoked"],
  },
  macos: {
    publication: ["built", "verified", "platform_signed", "notarized", "packaged", "device_qa"],
    production: ["published", "installed", "smoked"],
  },
  windows: {
    publication: ["built", "verified", "platform_signed", "packaged", "device_qa"],
    production: ["published", "installed", "smoked"],
  },
});

const COMMON_PUBLICATION = ["rollback_ready", "state_compatible", "no_interruption"];
const KNOWN_STATES = new Set([
  ...COMMON_PUBLICATION,
  ...Object.values(SURFACES).flatMap((surface) => [...surface.publication, ...surface.production]),
]);

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, allowed, path, errors) {
  if (!plainObject(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push(`${path}.${key} is not allowed`);
  }
}

function boundedString(value, pattern, path, errors, max = 512) {
  if (typeof value !== "string" || value.length === 0 || value.length > max || !pattern.test(value)) {
    errors.push(`${path} is invalid`);
  }
}

function validateDocument(document) {
  const errors = [];
  exactKeys(document, ["version", "surface", "release_id", "channel", "artifact", "evidence"], "$", errors);
  if (!plainObject(document)) return errors;
  if (document.version !== VERSION) errors.push(`$.version must be ${VERSION}`);
  if (!Object.hasOwn(SURFACES, document.surface)) errors.push("$.surface is unsupported");
  boundedString(document.release_id, ID, "$.release_id", errors, 128);
  boundedString(document.channel, ID, "$.channel", errors, 128);

  exactKeys(document.artifact, ["artifact_id", "sha256", "git_sha"], "$.artifact", errors);
  if (plainObject(document.artifact)) {
    boundedString(document.artifact.artifact_id, ID, "$.artifact.artifact_id", errors, 128);
    boundedString(document.artifact.sha256, SHA256, "$.artifact.sha256", errors, 64);
    boundedString(document.artifact.git_sha, GIT_SHA, "$.artifact.git_sha", errors, 40);
  }

  if (!Array.isArray(document.evidence) || document.evidence.length === 0 || document.evidence.length > 64) {
    errors.push("$.evidence must contain 1-64 items");
    return errors;
  }

  const seen = new Set();
  document.evidence.forEach((item, index) => {
    const path = `$.evidence[${index}]`;
    exactKeys(item, ["state", "release_id", "artifact_sha256", "verifier", "evidence_ref", "occurred_at"], path, errors);
    if (!plainObject(item)) return;
    if (!KNOWN_STATES.has(item.state)) errors.push(`${path}.state is unsupported`);
    if (seen.has(item.state)) errors.push(`${path}.state is duplicated`);
    seen.add(item.state);
    boundedString(item.release_id, ID, `${path}.release_id`, errors, 128);
    if (item.release_id !== document.release_id) {
      errors.push(`${path}.release_id does not match the candidate release`);
    }
    boundedString(item.artifact_sha256, SHA256, `${path}.artifact_sha256`, errors, 64);
    if (plainObject(document.artifact) && item.artifact_sha256 !== document.artifact.sha256) {
      errors.push(`${path}.artifact_sha256 does not match the candidate artifact`);
    }
    boundedString(item.verifier, /^[A-Za-z0-9][A-Za-z0-9 ._:/@-]*$/, `${path}.verifier`, errors, 160);
    boundedString(item.evidence_ref, /^[A-Za-z0-9][A-Za-z0-9 ._:/@#?=&%-]*$/, `${path}.evidence_ref`, errors, 512);
    boundedString(item.occurred_at, RFC3339, `${path}.occurred_at`, errors, 40);
  });
  return errors;
}

export function evaluateReleaseEvidence(document) {
  const errors = validateDocument(document);
  if (errors.length > 0) return { ok: false, errors };

  const contract = SURFACES[document.surface];
  const states = new Set(document.evidence.map((item) => item.state));
  const publicationRequired = [...contract.publication, ...COMMON_PUBLICATION];
  const productionRequired = [...publicationRequired, ...contract.production];
  const missingForPublication = publicationRequired.filter((state) => !states.has(state));
  const missingForProduction = productionRequired.filter((state) => !states.has(state));
  const ordered = [...publicationRequired, ...contract.production];
  let highestProvenState = "none";
  for (const state of ordered) {
    if (!states.has(state)) break;
    highestProvenState = state;
  }

  return {
    ok: true,
    version: VERSION,
    surface: document.surface,
    release_id: document.release_id,
    artifact_sha256: document.artifact.sha256,
    channel: document.channel,
    highest_proven_state: highestProvenState,
    publication_ready: missingForPublication.length === 0,
    channel_advance_allowed: missingForPublication.length === 0,
    production_ready: missingForProduction.length === 0,
    missing_for_publication: missingForPublication,
    missing_for_production: missingForProduction,
  };
}

function main(argv) {
  const [command, file] = argv;
  if (command !== "plan" || !file) {
    console.error("usage: release-evidence.mjs plan <evidence.json>");
    return 2;
  }
  let document;
  try {
    document = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    console.error(`release evidence could not be read: ${error.message}`);
    return 2;
  }
  const result = evaluateReleaseEvidence(document);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
