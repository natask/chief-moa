// Pure config unit test (no LiveKit runtime), run as: node --test dist/**/*.test.js
import assert from "node:assert";
import { test } from "node:test";
import { loadConfig } from "./config.js";

function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    saved[key] = process.env[key];
    if (env[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = env[key];
    }
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  }
}

test("gateway url is required", () => {
  withEnv({ MOA_GATEWAY_URL: undefined, GATEWAY_URL: undefined }, () => {
    assert.throws(() => loadConfig(), /MOA_GATEWAY_URL/);
  });
});

test("languages are pinned and capped to two, never auto-detected", () => {
  withEnv({
    MOA_GATEWAY_URL: "https://api.example.test/",
    MOA_LIVEKIT_LANGS: "en-US, am-ET, fr-FR",
    GCP_PROJECT_ID: "proj",
  }, () => {
    const config = loadConfig();
    assert.equal(config.gateway.url, "https://api.example.test");
    assert.deepEqual(config.chirp.languageCodes, ["en-US", "am-ET"]);
    assert.equal(config.chirp.projectId, "proj");
    assert.equal(config.chirp.model, "chirp_3");
  });
});

test("default language is en-US", () => {
  withEnv({ MOA_GATEWAY_URL: "https://api.example.test", MOA_LIVEKIT_LANGS: undefined }, () => {
    const config = loadConfig();
    assert.deepEqual(config.chirp.languageCodes, ["en-US"]);
  });
});
