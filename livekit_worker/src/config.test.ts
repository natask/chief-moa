// Pure config unit test (no LiveKit runtime), run as: node --test dist/**/*.test.js
import assert from "node:assert";
import { test } from "node:test";
import {
  fetchSessionLanguageCodes,
  loadConfig,
  normalizeSessionLanguageCodes,
  resolveSessionChirpConfig,
} from "./config.js";

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

// --- Session-start profile language pinning ---------------------------------

function stubFetch(handler: typeof fetch, fn: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

test("session start pins profile input_languages, primary first, over MOA_LIVEKIT_LANGS", async () => {
  await withEnvAsync(
    { MOA_GATEWAY_URL: "https://api.example.test", MOA_LIVEKIT_LANGS: "en-US" },
    async () => {
      const config = loadConfig();
      assert.deepEqual(config.chirp.languageCodes, ["en-US"]); // boot fallback, unused below

      await stubFetch(
        (async (input: string | URL) => {
          assert.equal(String(input), "https://api.example.test/v1/agent/profile");
          return new Response(
            JSON.stringify({
              profile: { input_languages: "en-US,am-ET", input_language_primary: "en-US" },
            }),
            { status: 200 },
          );
        }) as typeof fetch,
        async () => {
          const chirpConfig = await resolveSessionChirpConfig(config);
          assert.deepEqual(chirpConfig.languageCodes, ["en-US", "am-ET"]);
        },
      );
    },
  );
});

test("primary reorders to the front when the profile lists it out of order", async () => {
  const codes = normalizeSessionLanguageCodes("en-US,am-ET", "am-ET");
  assert.deepEqual(codes, ["am-ET", "en-US"]);
});

test("profile fetch failure falls back to MOA_LIVEKIT_LANGS", async () => {
  await withEnvAsync(
    { MOA_GATEWAY_URL: "https://api.example.test", MOA_LIVEKIT_LANGS: "en-US" },
    async () => {
      const config = loadConfig();

      await stubFetch(
        (async () => {
          throw new Error("network unreachable");
        }) as unknown as typeof fetch,
        async () => {
          const codes = await fetchSessionLanguageCodes(config.gateway, config.chirp.languageCodes);
          assert.deepEqual(codes, ["en-US"]);
        },
      );
    },
  );
});

test("profile fetch non-2xx falls back to MOA_LIVEKIT_LANGS", async () => {
  await withEnvAsync(
    { MOA_GATEWAY_URL: "https://api.example.test", MOA_LIVEKIT_LANGS: "en-US,am-ET" },
    async () => {
      const config = loadConfig();

      await stubFetch(
        (async () => new Response("unauthorized", { status: 401 })) as typeof fetch,
        async () => {
          const codes = await fetchSessionLanguageCodes(config.gateway, config.chirp.languageCodes);
          assert.deepEqual(codes, ["en-US", "am-ET"]);
        },
      );
    },
  );
});

test("profile fetch with empty language fields falls back to MOA_LIVEKIT_LANGS", async () => {
  await withEnvAsync(
    { MOA_GATEWAY_URL: "https://api.example.test", MOA_LIVEKIT_LANGS: "en-US" },
    async () => {
      const config = loadConfig();

      await stubFetch(
        (async () => new Response(JSON.stringify({ profile: {} }), { status: 200 })) as typeof fetch,
        async () => {
          const codes = await fetchSessionLanguageCodes(config.gateway, config.chirp.languageCodes);
          assert.deepEqual(codes, ["en-US"]);
        },
      );
    },
  );
});

function withEnvAsync(env: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    saved[key] = process.env[key];
    if (env[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = env[key];
    }
  }
  return fn().finally(() => {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  });
}
