import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AudioFrame } from "@livekit/rtc-node";
import { initializeLogger, llm, stt } from "@livekit/agents";
import workerAgent, { describe, initializeJob, parseParticipantMetadata, recordTurn, roomSessionId, workerDefinition } from "./agent.js";
import { isMain, runWorkerCli } from "./main.js";
import type { ChirpConfig, GatewayConfig } from "./config.js";
import {
  authorizedUserToken,
  base64Url,
  ChirpSTT,
  concatPcm16,
  extractTranscript,
  parseTokenResponse,
  recognizeEndpoint,
  serviceAccountToken,
} from "./plugins/chirp-stt.js";
import { GatewayLLM, lastUserText, LiveKitTurnState, requestReason } from "./plugins/gateway-llm.js";
import { framePcm, GatewayTTS, sameCore, synthesizeViaGateway } from "./plugins/gateway-tts.js";

const gateway: GatewayConfig = { url: "https://gateway.test", token: "secret" };
initializeLogger({ pretty: false, level: "fatal" });
const chirp = (overrides: Partial<ChirpConfig> = {}): ChirpConfig => ({
  projectId: "project one",
  location: "us",
  model: "chirp_3",
  languageCodes: ["en-US", "am-ET"],
  accessToken: "access",
  credentialsFile: "",
  ...overrides,
});

async function withFetch<T>(handler: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

test("agent helpers preserve gateway turn identity", async () => {
  assert.ok(workerAgent);
  assert.deepEqual(parseParticipantMetadata(undefined), {});
  assert.deepEqual(parseParticipantMetadata("bad"), {});
  assert.deepEqual(parseParticipantMetadata('{"session_id":"s","surface":"web"}'), { session_id: "s", surface: "web" });
  assert.equal(roomSessionId("moa-session-name-default"), "session-name");
  assert.equal(roomSessionId("plain"), "plain");
  assert.equal(roomSessionId(undefined), "default");
  assert.equal(describe(new Error("boom")), "boom");
  assert.equal(describe(42), "42");

  const state = new LiveKitTurnState();
  Object.assign(state, { sessionId: "s", branchId: "b", turnId: "t", deviceId: "d", lastUserTranscript: "hello" });
  state.lastReply = { speak: "reply", ttsText: "reply", ttsStyle: "", language: "am-ET", classification: "chat" };
  await withFetch(async (input, init) => {
    assert.equal(String(input), "https://gateway.test/v1/internal/voice/turn-record");
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer secret");
    const body = JSON.parse(String(init?.body));
    assert.deepEqual({ session_id: body.session_id, reply_language: body.reply_language, tts_spoke: body.tts_spoke }, { session_id: "s", reply_language: "am-ET", tts_spoke: true });
    return new Response(null, { status: 204 });
  }, () => recordTurn(gateway, state, "reply"));
  await withFetch(async (_input, init) => {
    assert.equal("Authorization" in (init?.headers as Record<string, string>), false);
    const body = JSON.parse(String(init?.body));
    assert.equal(body.reply_language, "");
    assert.equal(body.tts_spoke, false);
    return new Response(null, { status: 204 });
  }, () => recordTurn({ ...gateway, token: "" }, new LiveKitTurnState(), ""));
});

test("agent job wires participant metadata, plugins, recording, and start", async () => {
  let listener: ((event: { item: unknown }) => void) | undefined;
  let started = false;
  let logged = "";
  const session = {
    on: (_type: unknown, callback: typeof listener) => { listener = callback; },
    start: async ({ room }: { room: unknown }) => { assert.deepEqual(room, { name: "moa-fallback-default" }); started = true; },
  };
  const ctx = {
    proc: { userData: { vad: {} } }, room: { name: "moa-fallback-default" },
    connect: async () => undefined,
    waitForParticipant: async () => ({ metadata: '{"session_id":"session","branch_id":"branch","device_id":"device"}', identity: "identity" }),
  };
  const records: string[] = [];
  await initializeJob(ctx as never, {
    loadConfig: () => ({ gateway, chirp: chirp() }),
    resolveSessionChirpConfig: async (config) => config.chirp,
    createSession: (options) => { assert.ok(options && options.stt && options.llm && options.tts && options.vad); return session as never; },
    createAgent: (instructions) => { assert.match(instructions, /voice assistant/); return {} as never; },
    recordTurn: async (_gateway, state, text) => { records.push(`${state.sessionId}:${text}`); if (text === "fail") throw new Error("store"); },
    logError: (message) => { logged = message; },
  });
  assert.equal(started, true);
  listener?.({ item: { role: "user", textContent: "ignored" } });
  listener?.({ item: { role: "assistant", textContent: "reply" } });
  listener?.({ item: { role: "assistant", textContent: "fail" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(records, ["session:reply", "session:fail"]);
  assert.match(logged, /turn-record failed: store/);
  assert.equal(typeof workerDefinition.entry, "function");
});

test("CLI seam is import-safe and injectable", () => {
  assert.equal(isMain("file:///a.js", undefined), false);
  assert.equal(isMain("file:///a.js", "/b.js"), false);
  let called = false;
  runWorkerCli((options) => {
    called = true;
    assert.ok(options);
  }, new URL("./agent.js", import.meta.url).href);
  assert.equal(called, true);
});

test("Chirp pure transforms build exact request data", () => {
  assert.equal(recognizeEndpoint("p x", "global"), "https://speech.googleapis.com/v2/projects/p%20x/locations/global/recognizers/_:recognize");
  assert.equal(recognizeEndpoint("p", "eu"), "https://eu-speech.googleapis.com/v2/projects/p/locations/eu/recognizers/_:recognize");
  assert.deepEqual(extractTranscript({ results: [{ alternatives: [{ transcript: " hi " }] }, { alternatives: [{ transcript: "there" }], languageCode: "am-ET" }] }, "en-US"), { text: "hi  there", language: "am-ET" });
  assert.deepEqual(extractTranscript({}, "en-US"), { text: "", language: "en-US" });
  const a = new AudioFrame(new Int16Array([1, -2]), 16000, 1, 2);
  const b = new AudioFrame(new Int16Array([3]), 16000, 1, 1);
  assert.deepEqual([...concatPcm16([a, b])], [1, 0, 254, 255, 3, 0]);
  assert.equal(base64Url(Buffer.from([251, 255])), "-_8");
});

test("Chirp recognizes empty, success, and provider failure", async () => {
  const plugin = new ChirpSTT(chirp());
  assert.equal(plugin.label, "moa.ChirpSTT");
  assert.equal(plugin.model, "chirp_3");
  assert.equal(plugin.provider, "google-chirp");
  assert.deepEqual(plugin.config.languageCodes, ["en-US", "am-ET"]);
  const empty = await plugin.recognizeFrames([]);
  assert.equal(empty.alternatives?.[0].text, "");
  const frame = new AudioFrame(new Int16Array([1, 2]), 8000, 1, 2);
  await withFetch(async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.config.explicitDecodingConfig.sampleRateHertz, 8000);
    assert.equal((init?.headers as Record<string, string>)["x-goog-user-project"], "project one");
    return Response.json({ results: [{ alternatives: [{ transcript: "hello" }], languageCode: "en-US" }] });
  }, async () => {
    const result = await plugin.recognize(frame);
    assert.equal(result.type, stt.SpeechEventType.FINAL_TRANSCRIPT);
    assert.equal(result.alternatives?.[0].text, "hello");
  });
  await withFetch(async () => new Response("denied", { status: 403 }), async () => {
    await assert.rejects(() => new ChirpSTT(chirp({ projectId: "" })).recognizeFrames([frame]), /chirp STT failed \(403\)/);
  });
  await withFetch(async () => Response.json({ results: [{ alternatives: [{ transcript: "streamed" }] }] }), async () => {
    const stream = plugin.stream();
    stream.pushFrame(frame);
    stream.flush();
    stream.flush();
    stream.endInput();
    const events = [];
    for await (const event of stream) events.push(event.type);
    assert.deepEqual(events, [stt.SpeechEventType.START_OF_SPEECH, stt.SpeechEventType.FINAL_TRANSCRIPT, stt.SpeechEventType.END_OF_SPEECH]);
  });
});

test("Google token helpers cover validation and both credential exchanges", async () => {
  await assert.rejects(() => serviceAccountToken({}), /client_email/);
  await assert.rejects(() => authorizedUserToken({}), /client_id/);
  await assert.rejects(() => parseTokenResponse(new Response("no", { status: 400 })), /token exchange failed/);
  await assert.rejects(() => parseTokenResponse(Response.json({})), /no access_token/);
  const token = await parseTokenResponse(Response.json({ access_token: "x", expires_in: 2 }));
  assert.equal(token.value, "x");
  const fallbackExpiry = await parseTokenResponse(Response.json({ access_token: "y" }));
  assert.ok(fallbackExpiry.expiresAt > Date.now());

  await withFetch(async (_input, init) => {
    assert.match(String(init?.body), /grant_type=refresh_token/);
    return Response.json({ access_token: "user", expires_in: 10 });
  }, async () => assert.equal((await authorizedUserToken({ client_id: "id", client_secret: "sec", refresh_token: "ref" })).value, "user"));

  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  await withFetch(async (input, init) => {
    assert.equal(String(input), "https://token.test");
    assert.match(String(init?.body), /assertion=/);
    return Response.json({ access_token: "service", expires_in: 10 });
  }, async () => assert.equal((await serviceAccountToken({ client_email: "a@example.test", private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), token_uri: "https://token.test" })).value, "service"));
});

test("Chirp reads ADC shapes and caches tokens", async () => {
  const dir = mkdtempSync(join(tmpdir(), "moa-livekit-"));
  try {
    const file = join(dir, "credentials.json");
    writeFileSync(file, JSON.stringify({ type: "authorized_user", client_id: "id", client_secret: "sec", refresh_token: "ref" }));
    let tokenCalls = 0;
    await withFetch(async (input) => {
      if (String(input).includes("oauth2")) {
        tokenCalls += 1;
        return Response.json({ access_token: "adc", expires_in: 3600 });
      }
      return Response.json({ results: [] });
    }, async () => {
      const plugin = new ChirpSTT(chirp({ accessToken: "", credentialsFile: file }));
      const frame = new AudioFrame(new Int16Array([1]), 16000, 1, 1);
      await plugin.recognizeFrames([frame]);
      await plugin.recognizeFrames([frame]);
      assert.equal(tokenCalls, 1);
    });
    await assert.rejects(() => new ChirpSTT(chirp({ accessToken: "", credentialsFile: "" })).recognizeFrames([new AudioFrame(new Int16Array([1]), 16000, 1, 1)]), /needs CHIRP_ACCESS_TOKEN/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gateway LLM extracts user text and streams reason reply", async () => {
  const empty = new llm.ChatContext([]);
  assert.equal(lastUserText(empty), "");
  const ctx = new llm.ChatContext([
    { role: "assistant", textContent: "ignore" } as never,
    { role: "user", textContent: "  hello  " } as never,
  ]);
  assert.equal(lastUserText(ctx), "hello");
  const state = new LiveKitTurnState();
  Object.assign(state, { sessionId: "s", branchId: "b", deviceId: "d" });
  const model = new GatewayLLM(gateway, state);
  assert.equal(model.label(), "moa.GatewayLLM");
  assert.equal(model.provider, "moa-gateway");
  await withFetch(async (_input, init) => {
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer secret");
    return Response.json({ speak: " reply ", tts_text: "spoken", tts_style: "warm", language: "am-ET", classification: "answer" });
  }, async () => {
    const chunks = [];
    for await (const chunk of model.chat({ chatCtx: ctx })) chunks.push(chunk);
    assert.equal(chunks[0]?.delta?.content, "reply");
    assert.equal(state.lastReply?.ttsText, "spoken");
    assert.match(state.turnId, /^turn_/);
  });
  await withFetch(async () => new Response("bad", { status: 502 }), async () => {
    await assert.rejects(() => requestReason({ ...gateway, token: "" }, new LiveKitTurnState(), ""), /gateway reason failed/);
  });
  await withFetch(async () => Response.json({}), async () => {
    assert.deepEqual(await requestReason({ ...gateway, token: "" }, new LiveKitTurnState(), "x"), { speak: "", ttsText: "", ttsStyle: "", language: "", classification: "chat" });
  });
});

test("gateway TTS builds expressive payload and frames PCM", async () => {
  const state = new LiveKitTurnState();
  state.lastReply = { speak: "hello", ttsText: "spoken", ttsStyle: "warm", language: "am-ET", classification: "chat" };
  assert.equal(sameCore(" hi ", "hi"), true);
  assert.equal(sameCore("a", "b"), false);
  await withFetch(async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body, { text: "hello", tts_text: "spoken", tts_style: "warm", language: "am-ET" });
    return new Response(Buffer.from([1, 0, 254, 255]));
  }, async () => assert.deepEqual([...await synthesizeViaGateway(gateway, state, "hello")], [1, 0, 254, 255]));
  await withFetch(async () => new Response("bad", { status: 500 }), async () => {
    await assert.rejects(() => synthesizeViaGateway({ ...gateway, token: "" }, new LiveKitTurnState(), "other"), /gateway synthesize failed/);
  });
  const pcm = Buffer.alloc(3202 * 2);
  pcm.writeInt16LE(-12, 0);
  const frames = [...framePcm(pcm)];
  assert.deepEqual(frames.map((frame) => frame.samplesPerChannel), [1600, 1600, 2]);
  assert.equal(frames[0]?.data[0], -12);
  const synth = new GatewayTTS(gateway, state);
  assert.equal(synth.label, "moa.GatewayTTS");
  assert.equal(synth.provider, "moa-gateway");
  assert.equal(synth.config, gateway);
  assert.equal(synth.session, state);
  await withFetch(async () => new Response(Buffer.from([1, 0, 2, 0])), async () => {
    const chunked = synth.synthesize("hello");
    const chunks = [];
    for await (const chunk of chunked) chunks.push(chunk);
    assert.equal(chunks.length, 1);
  });
  await withFetch(async () => new Response(Buffer.from([1, 0])), async () => {
    const stream = synth.stream();
    stream.pushText(" hello ");
    stream.flush();
    stream.flush();
    stream.endInput();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    assert.ok(chunks.length >= 2);
  });
});
