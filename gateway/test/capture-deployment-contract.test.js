"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "../..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("compose passes the complete capture worker and Switchboard transport contract", () => {
  const compose = read("docker-compose.yml");
  for (const key of [
    "CAPTURE_TRANSCRIPTION_ENABLED",
    "CAPTURE_TRANSCRIPTION_STT_PROVIDER",
    "CAPTURE_TRANSCRIPTION_LEASE_MS",
    "CAPTURE_TRANSCRIPTION_MAX_ATTEMPTS",
    "CAPTURE_TRANSCRIPTION_POLL_MS",
    "CAPTURE_TRANSCRIPTION_CONCURRENCY",
    "CAPTURE_TRANSCRIPTION_SCAN_LIMIT",
    "CAPTURE_TRANSCRIPTION_BACKOFF_MS",
    "CAPTURE_TRANSCRIPTION_SHUTDOWN_TIMEOUT_MS",
    "CAPTURE_TRANSCRIPTION_MAX_AUDIO_BYTES",
    "CAPTURE_TRANSCRIPTION_WORKER_ID",
    "AGENT_SWITCHBOARD_BASE_URL",
    "AGENT_SWITCHBOARD_TOKEN",
    "AGENT_SWITCHBOARD_TIMEOUT_MS",
  ]) assert.ok(compose.includes(`${key}: \${${key}:-`), `compose does not pass ${key}`);
});

test("production rollout defaults keep retained-audio work inert", () => {
  const compose = read("docker-compose.yml");
  assert.match(compose, /CAPTURE_TRANSCRIPTION_ENABLED: \$\{CAPTURE_TRANSCRIPTION_ENABLED:-0\}/);
  assert.match(compose, /AGENT_SWITCHBOARD_BASE_URL: \$\{AGENT_SWITCHBOARD_BASE_URL:-\}/);
  assert.match(compose, /AGENT_SWITCHBOARD_TOKEN: \$\{AGENT_SWITCHBOARD_TOKEN:-\}/);
});

test("the VPS environment template exposes every explicit operator choice", () => {
  const example = read("gateway/deploy/vps/gateway.env.example");
  for (const key of [
    "CAPTURE_TRANSCRIPTION_ENABLED",
    "CAPTURE_TRANSCRIPTION_STT_PROVIDER",
    "CAPTURE_TRANSCRIPTION_LEASE_MS",
    "CAPTURE_TRANSCRIPTION_MAX_ATTEMPTS",
    "CAPTURE_TRANSCRIPTION_POLL_MS",
    "CAPTURE_TRANSCRIPTION_CONCURRENCY",
    "CAPTURE_TRANSCRIPTION_SCAN_LIMIT",
    "CAPTURE_TRANSCRIPTION_BACKOFF_MS",
    "CAPTURE_TRANSCRIPTION_SHUTDOWN_TIMEOUT_MS",
    "CAPTURE_TRANSCRIPTION_MAX_AUDIO_BYTES",
    "CAPTURE_TRANSCRIPTION_WORKER_ID",
    "AGENT_SWITCHBOARD_BASE_URL",
    "AGENT_SWITCHBOARD_TOKEN",
    "AGENT_SWITCHBOARD_TIMEOUT_MS",
  ]) assert.ok(example.includes(`${key}=`), `missing ${key}`);
});
