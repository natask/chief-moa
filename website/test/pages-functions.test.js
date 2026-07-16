import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { onRequest as pets } from "../functions/api/pets/[[path]].js";
import { onRequest as profileOptions } from "../functions/api/profile/options.js";
import { onRequest as voiceAudio } from "../functions/api/voice/audio.js";
import { onRequest as sessionTicket } from "../functions/api/voice/session-ticket.js";
import { onRequest as synthesize } from "../functions/api/voice/synthesize.js";
import { onRequest as voiceTurns } from "../functions/api/voice/turns.js";
import { onRequestGet as waitlistGet, onRequestPost as waitlistPost } from "../functions/api/waitlist.js";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

async function body(response) {
  return response.json();
}

function request(url, method = "GET", init = {}) {
  return new Request(url, { method, ...init });
}

function gatewayEnv(overrides = {}) {
  return {
    MOA_GATEWAY_URL: "https://gateway.example///",
    MOA_GATEWAY_TOKEN: "secret-token",
    ...overrides,
  };
}

function captureFetch(response = new Response("upstream", { status: 202 })) {
  const calls = [];
  globalThis.fetch = async (...args) => {
    calls.push(args);
    return response;
  };
  return calls;
}

async function expectMethodAndConfig(handler, allowedMethod) {
  const options = await handler({ request: request("https://agee.app/api", "OPTIONS"), env: {} });
  assert.equal(options.status, 204);
  assert.equal(options.headers.get("access-control-allow-origin"), "*");

  const disallowed = allowedMethod === "GET" ? "POST" : "GET";
  const denied = await handler({ request: request("https://agee.app/api", disallowed), env: {} });
  assert.equal(denied.status, 405);

  const missingBoth = await handler({ request: request("https://agee.app/api", allowedMethod), env: {} });
  assert.equal(missingBoth.status, 503);
  assert.deepEqual((await body(missingBoth)).missing, ["MOA_GATEWAY_URL", "MOA_GATEWAY_TOKEN"]);

  const missingToken = await handler({
    request: request("https://agee.app/api", allowedMethod),
    env: { AG_GATEWAY_URL: "https://gateway.example" },
  });
  assert.deepEqual((await body(missingToken)).missing, ["MOA_GATEWAY_TOKEN"]);

  const missingUrl = await handler({
    request: request("https://agee.app/api", allowedMethod),
    env: { AG_GATEWAY_TOKEN: "legacy-token" },
  });
  assert.deepEqual((await body(missingUrl)).missing, ["MOA_GATEWAY_URL"]);
}

describe("pet studio proxy", () => {
  test("handles CORS, methods, unknown routes, and missing configuration", async () => {
    const options = await pets({ request: request("https://agee.app/api/pets", "OPTIONS"), env: {}, params: {} });
    assert.equal(options.status, 204);
    assert.equal(options.headers.get("access-control-allow-methods"), "GET,POST,OPTIONS");

    const denied = await pets({ request: request("https://agee.app/api/pets", "DELETE"), env: {}, params: {} });
    assert.equal(denied.status, 405);
    assert.deepEqual(await body(denied), { error: "Use GET or POST." });

    for (const path of ["unknown/path", ["", "unknown", "path"]]) {
      const unknown = await pets({ request: request("https://agee.app/api/pets"), env: {}, params: { path } });
      assert.equal(unknown.status, 404);
    }

    const absent = await pets({ request: request("https://agee.app/api/pets"), env: {}, params: {} });
    assert.equal(absent.status, 503);
    assert.deepEqual((await body(absent)).missing, ["MOA_GATEWAY_URL", "MOA_GATEWAY_TOKEN"]);

    const noToken = await pets({
      request: request("https://agee.app/api/pets"),
      env: { AG_GATEWAY_URL: "https://legacy.example" },
      params: { path: "///preview///" },
    });
    assert.deepEqual((await body(noToken)).missing, ["MOA_GATEWAY_TOKEN"]);

    const noUrl = await pets({
      request: request("https://agee.app/api/pets"),
      env: { AG_GATEWAY_TOKEN: "legacy" },
      params: { path: "preview" },
    });
    assert.deepEqual((await body(noUrl)).missing, ["MOA_GATEWAY_URL"]);
  });

  test("maps every fixed and dynamic route", async () => {
    const cases = new Map([
      ["", "/v1/agent/pets"],
      ["preview", "/v1/agent/pets/preview"],
      ["apply", "/v1/agent/pets/apply"],
      ["generate", "/v1/agent/pets/generate"],
      ["companions", "/v1/agent/companions"],
      ["active", "/v1/agent/pets/active"],
      ["agents", "/v1/agent/pets/agents"],
      ["bookmarks", "/v1/agent/pets/bookmarks"],
      ["shared", "/v1/agent/pets/shared"],
      ["install", "/v1/agent/pets/install"],
      ["agents/a_1", "/v1/agent/pets/agents/a_1"],
      ["bookmarks/pet-2", "/v1/agent/pets/bookmarks/pet-2"],
      ["pet-3/publish", "/v1/agent/pets/pet-3/publish"],
      ["pet-3/voice-clone", "/v1/agent/pets/pet-3/voice-clone"],
    ]);
    const calls = captureFetch(new Response("proxied", {
      status: 201,
      headers: { "content-type": "text/plain" },
    }));

    for (const [path, expectedPath] of cases) {
      const response = await pets({
        request: request("https://agee.app/api/pets?view=full"),
        env: gatewayEnv(),
        params: { path: path ? path.split("/") : undefined },
      });
      assert.equal(response.status, 201);
      assert.equal(response.headers.get("content-type"), "text/plain");
      assert.equal(response.headers.get("access-control-allow-origin"), "*");
      const [url, init] = calls.at(-1);
      assert.equal(url, `https://gateway.example${expectedPath}?view=full`);
      assert.equal(init.method, "GET");
      assert.equal(init.body, undefined);
      assert.equal(init.headers.authorization, "Bearer secret-token");
    }
  });

  test("forwards POST bodies and uses legacy config and content defaults", async () => {
    const calls = captureFetch(new Response(new Uint8Array(), { status: 200 }));
    const input = request("https://agee.app/api/pets/apply", "POST", { body: new TextEncoder().encode("payload") });
    const response = await pets({
      request: input,
      env: { AG_GATEWAY_URL: "https://legacy.example/", AG_GATEWAY_TOKEN: "legacy" },
      params: { path: "/apply/" },
    });
    assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
    const [url, init] = calls[0];
    assert.equal(url, "https://legacy.example/v1/agent/pets/apply");
    assert.equal(init.method, "POST");
    assert.equal(init.headers["content-type"], "application/json");
    assert.equal(await new Response(init.body).text(), "payload");
  });
});

describe("profile options proxy", () => {
  test("guards the route and reports each missing secret", async () => {
    await expectMethodAndConfig(profileOptions, "GET");
  });

  test("forwards auth and preserves response metadata", async () => {
    const calls = captureFetch(new Response("catalog", { status: 206, headers: { "content-type": "application/custom" } }));
    const response = await profileOptions({ request: request("https://agee.app/api/profile/options"), env: gatewayEnv() });
    assert.equal(response.status, 206);
    assert.equal(await response.text(), "catalog");
    assert.equal(response.headers.get("content-type"), "application/custom");
    assert.equal(calls[0][0], "https://gateway.example/v1/agent/profile/options");
    assert.equal(calls[0][1].headers.authorization, "Bearer secret-token");

    const fallbackCalls = captureFetch(new Response(new Uint8Array()));
    const fallback = await profileOptions({
      request: request("https://agee.app/api/profile/options"),
      env: { AG_GATEWAY_URL: "https://legacy.example/", AG_GATEWAY_TOKEN: "legacy" },
    });
    assert.equal(fallback.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(fallbackCalls[0][0], "https://legacy.example/v1/agent/profile/options");
  });
});

describe("voice audio proxy", () => {
  test("guards methods and configuration", async () => {
    await expectMethodAndConfig(voiceAudio, "GET");
  });

  test("requires identifiers, sanitizes them, and defaults to user audio", async () => {
    const missing = await voiceAudio({
      request: request("https://agee.app/api/voice/audio?session_id=valid"),
      env: gatewayEnv(),
    });
    assert.equal(missing.status, 400);

    const calls = captureFetch(new Response("pcm", { status: 200 }));
    await voiceAudio({
      request: request(`https://agee.app/api/voice/audio?session_id=${"s".repeat(170)}!!&turn_id=turn%2Fone&kind=nope`),
      env: gatewayEnv(),
    });
    assert.equal(calls[0][0], `https://gateway.example/v1/voice/audio/${"s".repeat(160)}/turnone?kind=user`);
  });

  test("forwards assistant audio and exposes only present metadata", async () => {
    const calls = captureFetch(new Response("pcm", {
      status: 206,
      headers: {
        "content-type": "audio/pcm",
        "x-moa-session-id": "session",
        "x-moa-audio-kind": "assistant",
      },
    }));
    const response = await voiceAudio({
      request: request("https://agee.app/api/voice/audio?session_id=s_1&turn_id=t-2&kind=assistant"),
      env: gatewayEnv(),
    });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("x-moa-session-id"), "session");
    assert.equal(response.headers.get("x-moa-turn-id"), null);
    assert.equal(calls[0][1].headers.authorization, "Bearer secret-token");

    const fallback = captureFetch(new Response(new Uint8Array([1])));
    const defaultType = await voiceAudio({
      request: request("https://agee.app/api/voice/audio?session_id=s&turn_id=t"),
      env: gatewayEnv(),
    });
    assert.equal(defaultType.headers.get("content-type"), "application/octet-stream");
    assert.equal(fallback.length, 1);
  });
});

describe("voice session ticket proxy", () => {
  test("guards methods and configuration", async () => {
    await expectMethodAndConfig(sessionTicket, "POST");
  });

  test("forwards sanitized identifiers and tolerates malformed JSON", async () => {
    const calls = captureFetch(new Response("ticket", { status: 201, headers: { "content-type": "text/ticket" } }));
    const response = await sessionTicket({
      request: request("https://agee.app/api/voice/session-ticket", "POST", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session_id: " s/id_1 ", device_id: "d-2" }),
      }),
      env: gatewayEnv(),
    });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("content-type"), "text/ticket");
    assert.deepEqual(JSON.parse(calls[0][1].body), {
      source: "website-pet-studio",
      session_id: "sid_1",
      device_id: "d-2",
    });

    const malformedCalls = captureFetch(new Response(new Uint8Array()));
    const malformed = await sessionTicket({
      request: request("https://agee.app/api/voice/session-ticket", "POST", { body: "{" }),
      env: { AG_GATEWAY_URL: "https://legacy.example/", AG_GATEWAY_TOKEN: "legacy" },
    });
    assert.equal(malformed.headers.get("content-type"), "application/json; charset=utf-8");
    assert.deepEqual(JSON.parse(malformedCalls[0][1].body), { source: "website-pet-studio" });
  });
});

describe("voice synthesis proxy", () => {
  test("guards methods and configuration", async () => {
    await expectMethodAndConfig(synthesize, "POST");
  });

  test("rejects malformed and blank payloads", async () => {
    for (const value of ["{", JSON.stringify({ text: "   " })]) {
      const response = await synthesize({
        request: request("https://agee.app/api/voice/synthesize", "POST", { body: value }),
        env: gatewayEnv(),
      });
      assert.equal(response.status, 400);
    }
  });

  test("bounds optional fields and copies present audio headers", async () => {
    const calls = captureFetch(new Response("pcm", {
      status: 201,
      headers: {
        "content-type": "audio/pcm",
        "x-moa-audio-encoding": "pcm16",
        "x-moa-audio-sample-rate": "16000",
        "x-moa-reply-language": "am-ET",
      },
    }));
    const response = await synthesize({
      request: request("https://agee.app/api/voice/synthesize", "POST", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: `  ${"x".repeat(4010)}  `,
          voice: ` ${"v".repeat(70)} `,
          language: ` ${"l".repeat(50)} `,
          style: ` ${"s".repeat(410)} `,
          speaking_rate: "1.25",
        }),
      }),
      env: gatewayEnv(),
    });
    const payload = JSON.parse(calls[0][1].body);
    assert.equal(payload.text.length, 4000);
    assert.equal(payload.voice.length, 60);
    assert.equal(payload.language.length, 40);
    assert.equal(payload.tts_style.length, 400);
    assert.equal(payload.speaking_rate, 1.25);
    assert.equal(response.headers.get("x-moa-audio-encoding"), "pcm16");
    assert.equal(response.headers.get("x-moa-audio-channels"), null);
    assert.equal(response.headers.get("access-control-expose-headers").includes("x-moa-voice"), true);
  });

  test("omits empty or invalid options and uses style alias and response default", async () => {
    const calls = captureFetch(new Response(new Uint8Array([1])));
    const response = await synthesize({
      request: request("https://agee.app/api/voice/synthesize", "POST", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: " Hello ", voice: " ", language: "", tts_style: "", style: " warm ", speaking_rate: 0 }),
      }),
      env: gatewayEnv(),
    });
    assert.deepEqual(JSON.parse(calls[0][1].body), { text: "Hello", tts_style: "warm" });
    assert.equal(response.headers.get("content-type"), "application/octet-stream");

    const nanCalls = captureFetch(new Response("pcm"));
    await synthesize({
      request: request("https://agee.app/api/voice/synthesize", "POST", {
        body: JSON.stringify({ text: "Hello", speaking_rate: "not-a-number" }),
      }),
      env: gatewayEnv(),
    });
    assert.deepEqual(JSON.parse(nanCalls[0][1].body), { text: "Hello" });
  });
});

describe("voice turns proxy", () => {
  test("guards methods and configuration", async () => {
    await expectMethodAndConfig(voiceTurns, "GET");
  });

  test("requires a session and forwards sanitized optional query values", async () => {
    const missing = await voiceTurns({ request: request("https://agee.app/api/voice/turns"), env: gatewayEnv() });
    assert.equal(missing.status, 400);

    const calls = captureFetch(new Response("turns", { status: 200, headers: { "content-type": "application/turns" } }));
    const response = await voiceTurns({
      request: request("https://agee.app/api/voice/turns?session_id=s%2F1&branch_id=b%3F2&limit=999"),
      env: gatewayEnv(),
    });
    assert.equal(calls[0][0].toString(), "https://gateway.example/v1/voice/turns?session_id=s1&branch_id=b2&limit=200");
    assert.equal(response.headers.get("content-type"), "application/turns");
  });

  test("omits empty branch and non-positive or non-finite limits", async () => {
    for (const limit of ["0", "-2", "wat"]) {
      const calls = captureFetch(new Response(new Uint8Array()));
      const response = await voiceTurns({
        request: request(`https://agee.app/api/voice/turns?session_id=${"s".repeat(170)}&branch_id=!!&limit=${limit}`),
        env: gatewayEnv(),
      });
      assert.equal(calls[0][0].searchParams.get("session_id").length, 160);
      assert.equal(calls[0][0].searchParams.has("branch_id"), false);
      assert.equal(calls[0][0].searchParams.has("limit"), false);
      assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
    }
  });
});

describe("waitlist handler", () => {
  test("GET explains the allowed method and POST validates JSON and email", async () => {
    const get = await waitlistGet();
    assert.equal(get.status, 405);

    const malformed = await waitlistPost({ request: request("https://agee.app/api/waitlist", "POST", { body: "{" }), env: {} });
    assert.equal(malformed.status, 400);
    assert.deepEqual(await body(malformed), { error: "Invalid request body." });

    for (const email of [undefined, "bad", `a@${"x".repeat(250)}.com`]) {
      const response = await waitlistPost({
        request: request("https://agee.app/api/waitlist", "POST", {
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email }),
        }),
        env: {},
      });
      assert.equal(response.status, 400);
    }
  });

  test("allows storage-free local development for all loopback names", async () => {
    for (const hostname of ["localhost", "127.0.0.1"]) {
      const response = await waitlistPost({
        request: request(`http://${hostname}/api/waitlist`, "POST", {
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: " Person@Example.com " }),
        }),
        env: {},
      });
      assert.equal(response.status, 200);
      assert.equal((await body(response)).stored, false);
    }
    const ipv6 = await waitlistPost({
      request: request("http://[::1]/api/waitlist", "POST", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "person@example.com" }),
      }),
      env: {},
    });
    assert.equal(ipv6.status, 500);
    const production = await waitlistPost({
      request: request("https://agee.app/api/waitlist", "POST", {
        headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "a@example.com" }),
      }),
      env: {},
    });
    assert.equal(production.status, 500);

    const invalidUrl = await waitlistPost({
      request: { url: "not a url", headers: new Headers(), json: async () => ({ email: "a@example.com" }) },
      env: {},
    });
    assert.equal(invalidUrl.status, 500);
  });

  test("stores normalized signups and derives IP from either header", async () => {
    for (const [headers, expectedIp] of [
      [{ "cf-connecting-ip": "1.2.3.4", "x-forwarded-for": "ignored" }, "1.2.3.4"],
      [{ "x-forwarded-for": "5.6.7.8" }, "5.6.7.8"],
      [{}, ""],
    ]) {
      const bound = [];
      const db = {
        prepare(sql) {
          assert.match(sql, /INSERT INTO waitlist/);
          return {
            bind(...values) {
              bound.push(values);
              return { run: async () => ({ success: true }) };
            },
          };
        },
      };
      const response = await waitlistPost({
        request: request("https://agee.app/api/waitlist", "POST", {
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify({ email: " Person@Example.COM " }),
        }),
        env: { DB: db },
      });
      assert.equal(response.status, 200);
      assert.equal((await body(response)).emailed, false);
      assert.equal(bound[0][0], "person@example.com");
      assert.equal(bound[0][2], "website");
      assert.equal(bound[0][3], expectedIp);
      assert.equal(Number.isNaN(Date.parse(bound[0][1])), false);
    }
  });

  test("reports D1 errors without attempting email", async () => {
    let fetched = false;
    globalThis.fetch = async () => { fetched = true; return new Response(); };
    const response = await waitlistPost({
      request: request("https://agee.app/api/waitlist", "POST", {
        headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "a@example.com" }),
      }),
      env: { DB: { prepare() { throw new Error("D1 unavailable"); } }, RESEND_API_KEY: "key", RESEND_FROM: "from" },
    });
    assert.equal(response.status, 500);
    assert.equal(fetched, false);
  });

  test("sends confirmations with optional reply-to and reports provider result", async () => {
    for (const [replyTo, providerStatus, expected] of [["reply@example.com", 202, true], [undefined, 500, false]]) {
      const calls = captureFetch(new Response("", { status: providerStatus }));
      const db = { prepare: () => ({ bind: () => ({ run: async () => ({}) }) }) };
      const response = await waitlistPost({
        request: request("https://agee.app/api/waitlist", "POST", {
          headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "a@example.com" }),
        }),
        env: {
          DB: db,
          RESEND_API_KEY: "resend-key",
          RESEND_FROM: "A.G. <hello@example.com>",
          RESEND_REPLY_TO: replyTo,
        },
      });
      const result = await body(response);
      assert.equal(result.emailed, expected);
      assert.match(result.message, expected ? /Check your inbox/ : /keep in touch/);
      assert.equal(calls[0][0], "https://api.resend.com/emails");
      const sent = JSON.parse(calls[0][1].body);
      assert.equal(sent.to, "a@example.com");
      assert.equal(sent.reply_to, replyTo);
      assert.match(sent.text, /interactive voice agent/);
      assert.match(sent.html, /<!DOCTYPE html>/);
    }
  });

  test("keeps the signup successful when confirmation fetch rejects", async () => {
    globalThis.fetch = async () => { throw new Error("network"); };
    const db = { prepare: () => ({ bind: () => ({ run: async () => ({}) }) }) };
    const response = await waitlistPost({
      request: request("https://agee.app/api/waitlist", "POST", {
        headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "a@example.com" }),
      }),
      env: { DB: db, RESEND_API_KEY: "key", RESEND_FROM: "from" },
    });
    assert.equal(response.status, 200);
    assert.equal((await body(response)).emailed, false);
  });
});
