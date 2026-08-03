"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  createAudioCaptureSttProvider,
  parseLinearPcmContentType,
  readBounded,
  transcribePcmWindowed,
} = require("../lib/audio-capture-stt-provider");

function stream(...chunks) {
  return (async function* audioChunks() {
    for (const chunk of chunks) yield chunk;
  }());
}

function claim(overrides = {}) {
  return {
    provider_id: "chirp",
    language_profile: {
      version: "profile-1",
      languages: ["en-US", "am-ET"],
      primary: "am-ET",
    },
    ...overrides,
  };
}

function configuredAdapter(overrides = {}) {
  const calls = { registry: [], factory: [], transcribe: [] };
  const provider = {
    model: "chirp_3",
    async transcribePcmBuffer(...args) {
      calls.transcribe.push(args);
      return { text: "literal transcript" };
    },
    ...overrides.provider,
  };
  const env = {
    CAPTURE_TRANSCRIPTION_STT_PROVIDER: "CHIRP",
    GOOGLE_APPLICATION_CREDENTIALS_JSON: "credential-that-must-not-leak",
    ...overrides.env,
  };
  const adapter = createAudioCaptureSttProvider({
    env,
    maxAudioBytes: overrides.maxAudioBytes ?? 64,
    registryFactory(input) {
      calls.registry.push(input);
      return overrides.registry || {
        selected_providers: { stt: "other" },
        providers: { stt: [{ id: "chirp", configured: true }] },
      };
    },
    providerFactory(input) {
      calls.factory.push(input);
      return provider;
    },
  });
  return { adapter, calls, env, provider };
}

test("adapter pins the claim languages and retained PCM contract for the provider", async () => {
  const state = configuredAdapter();
  const selectedClaim = claim();
  const transcriber = await state.adapter.transcriberForClaim(selectedClaim);
  const bytes = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
  const result = await transcriber.transcribe({
    audio: {
      contentType: "audio/L16; rate=48000; channels=2",
      size: bytes.length,
      stream: stream(bytes.subarray(0, 3), bytes.subarray(3)),
    },
  });

  assert.equal(state.calls.registry.length, 1);
  assert.equal(state.calls.registry[0].env, state.env);
  assert.equal(state.calls.factory.length, 1);
  assert.equal(state.calls.factory[0].env.VOICE_PROVIDER, "chirp");
  assert.equal(state.calls.factory[0].env.VOICE_STT_PROVIDER, "chirp");
  assert.equal(state.calls.factory[0].env.VOICE_REASONING_PROVIDER, "gateway");
  assert.equal(state.calls.factory[0].env.VOICE_LLM_PROVIDER, "gateway");
  assert.equal(state.calls.factory[0].env.VOICE_TTS_PROVIDER, "none");
  assert.equal(state.calls.factory[0].reasoner, null);
  assert.equal(state.calls.factory[0].agentProfile, null);
  assert.deepEqual(state.calls.transcribe, [[
    bytes,
    48000,
    2,
    selectedClaim.language_profile.languages,
    { input_languages: "en-US,am-ET" },
  ]]);
  assert.deepEqual(result, {
    text: "literal transcript",
    provider: { id: "chirp", model: "chirp_3" },
    language_evidence: ["en-US", "am-ET"],
  });
  assert.equal(state.adapter.status().runtime_ready, true);

  await (await state.adapter.transcriberForClaim(selectedClaim)).transcribe({
    audio: { contentType: "audio/pcm", stream: stream(Buffer.from([1, 2])) },
  });
  assert.equal(state.calls.factory.length, 1, "the configured provider is reused");
});

test("language rejection clears evidence without changing literal provider text", async () => {
  const state = configuredAdapter({
    provider: {
      model: "x".repeat(200),
      async transcribePcmBuffer(...args) {
        state.calls.transcribe.push(args);
        return { text: "  exact provider text  ", languageRejected: true };
      },
    },
  });
  const result = await (await state.adapter.transcriberForClaim(claim())).transcribe({
    audio: { contentType: "audio/L16", stream: stream(Buffer.from([1, 2])) },
  });

  assert.equal(result.text, "  exact provider text  ");
  assert.deepEqual(result.language_evidence, []);
  assert.equal(result.provider.model.length, 160);
});

test("long retained PCM is split into bounded synchronous STT windows", async () => {
  const calls = [];
  const provider = {
    async transcribePcmBuffer(audio) {
      calls.push(audio.length);
      return { text: `part-${calls.length}` };
    },
  };
  const frameBytes = 2;
  const windowBytes = 55 * 8_000 * frameBytes;
  const result = await transcribePcmWindowed(
    provider,
    Buffer.alloc(windowBytes + frameBytes),
    8_000,
    1,
    ["en-US"],
    { input_languages: "en-US" },
  );
  assert.deepEqual(calls, [windowBytes, frameBytes]);
  assert.deepEqual(result, { text: "part-1 part-2", languageRejected: false, windowed: true });
});

test("PCM content types parse bounded defaults and explicit values", () => {
  assert.deepEqual(parseLinearPcmContentType("audio/L16"), { sampleRate: 16000, channels: 1 });
  assert.deepEqual(parseLinearPcmContentType(" AUDIO/PCM; channels=8; rate=192000 "), { sampleRate: 192000, channels: 8 });
  assert.equal(parseLinearPcmContentType("audio/webm"), null);
  assert.equal(parseLinearPcmContentType("audio/L16; rate=7999"), null);
  assert.equal(parseLinearPcmContentType("audio/L16; rate=192001"), null);
  assert.equal(parseLinearPcmContentType("audio/L16; channels=0"), null);
  assert.equal(parseLinearPcmContentType("audio/L16; channels=9"), null);
});

test("unsupported retained audio is rejected before its stream is consumed", async () => {
  const state = configuredAdapter();
  let consumed = false;
  const transcriber = await state.adapter.transcriberForClaim(claim());
  await assert.rejects(
    transcriber.transcribe({
      audio: {
        contentType: "audio/webm",
        stream: (async function* audioChunks() { consumed = true; yield Buffer.alloc(2); }()),
      },
    }),
    (error) => error.code === "unsupported_audio_format" && error.retryable === false,
  );
  assert.equal(consumed, false);
  assert.equal(state.calls.transcribe.length, 0);
});

test("bounded reads reject declared and streamed oversize audio", async () => {
  await assert.rejects(
    readBounded({ size: 5, stream: stream(Buffer.alloc(1)) }, 4),
    (error) => error.code === "audio_too_large" && error.retryable === false,
  );
  await assert.rejects(
    readBounded({ stream: stream(Buffer.alloc(3), Buffer.alloc(2)) }, 4),
    (error) => error.code === "audio_too_large" && error.retryable === false,
  );
});

test("empty, unavailable, and mid-frame retained PCM have explicit dispositions", async () => {
  const state = configuredAdapter();
  const transcriber = await state.adapter.transcriberForClaim(claim());

  await assert.rejects(
    transcriber.transcribe({ audio: { contentType: "audio/L16", stream: stream() } }),
    (error) => error.code === "invalid_audio" && error.retryable === false,
  );
  await assert.rejects(
    transcriber.transcribe({ audio: { contentType: "audio/L16" } }),
    (error) => error.code === "audio_unavailable" && error.retryable === true,
  );
  await assert.rejects(
    transcriber.transcribe({
      audio: { contentType: "audio/L16; channels=2", stream: stream(Buffer.alloc(6)) },
    }),
    (error) => error.code === "invalid_audio" && error.retryable === false,
  );
  assert.equal(state.calls.transcribe.length, 0);
});

test("blank provider transcripts are retryable failures", async () => {
  const state = configuredAdapter({
    provider: { async transcribePcmBuffer() { return { text: "  " }; } },
  });
  await assert.rejects(
    (await state.adapter.transcriberForClaim(claim())).transcribe({
      audio: { contentType: "audio/L16", stream: stream(Buffer.alloc(2)) },
    }),
    (error) => error.code === "empty_transcript" && error.retryable === true,
  );
});

test("unavailable providers and mismatched claims fail before provider creation", async () => {
  for (const scenario of [
    { providerId: "", registry: { selected_providers: {}, providers: { stt: [] } }, reason: /no capture STT provider/ },
    { providerId: "missing", registry: { providers: { stt: [] } }, reason: /not a registered retained-audio STT provider/ },
    { providerId: "chirp", registry: { providers: { stt: [{ id: "chirp", configured: false }] } }, reason: /not configured/ },
  ]) {
    let created = 0;
    const adapter = createAudioCaptureSttProvider({
      env: {},
      providerId: scenario.providerId,
      registryFactory: () => scenario.registry,
      providerFactory: () => { created += 1; return {}; },
    });
    assert.throws(() => adapter.requireProviderId(), (error) => (
      error.code === "provider_unavailable" && error.retryable === false && scenario.reason.test(error.message)
    ));
    await assert.rejects(adapter.transcriberForClaim(claim({ provider_id: scenario.providerId })), { code: "provider_unavailable" });
    assert.equal(created, 0);
  }

  const configured = configuredAdapter();
  await assert.rejects(configured.adapter.transcriberForClaim(claim({ provider_id: "other" })), {
    code: "provider_unavailable",
  });
  assert.equal(configured.calls.factory.length, 0);
});

test("provider without a retained-PCM adapter fails closed", async () => {
  const state = configuredAdapter({ provider: { transcribePcmBuffer: null } });
  await assert.rejects(state.adapter.transcriberForClaim(claim()), (error) => (
    error.code === "provider_unavailable" && error.retryable === false
  ));
});

test("status reports bounded capability state without exposing credentials", async () => {
  const secret = "super-secret-provider-key";
  const state = configuredAdapter({
    env: { GOOGLE_APPLICATION_CREDENTIALS_JSON: secret },
    provider: {
      async transcribePcmBuffer() {
        throw new Error(`upstream rejected credential ${secret}\nsecond line`);
      },
    },
  });

  assert.deepEqual(state.adapter.status(), {
    provider_id: "chirp",
    registry_configured: true,
    available: true,
    reason: null,
    accepted_formats: ["audio/L16; rate=<hz>; channels=<count>"],
    max_audio_bytes: 64,
    runtime_ready: null,
    last_runtime_error: null,
  });

  await assert.rejects(
    (await state.adapter.transcriberForClaim(claim())).transcribe({
      audio: { contentType: "audio/L16", stream: stream(Buffer.alloc(2)) },
    }),
    (error) => (
      error.code === "provider_request_failed"
      && error.retryable === true
      && error.message === "capture STT provider request failed"
    ),
  );
  const status = state.adapter.status();
  assert.equal(status.runtime_ready, false);
  assert.equal(status.runtime_ready, false);
  assert.equal(JSON.stringify(status).includes(secret), false);
  assert.equal(status.last_runtime_error.includes("\n"), false);
});

test("invalid audio limits fail during construction", () => {
  const registryFactory = () => ({ providers: { stt: [] } });
  assert.throws(
    () => createAudioCaptureSttProvider({ env: {}, maxAudioBytes: 0, registryFactory }),
    /max_audio_bytes must be an integer/,
  );
  assert.throws(
    () => createAudioCaptureSttProvider({ env: {}, maxAudioBytes: 1.5, registryFactory }),
    /max_audio_bytes must be an integer/,
  );
});
