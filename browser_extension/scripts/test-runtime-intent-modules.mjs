import assert from "node:assert/strict";
import test from "node:test";
import {
  extractHttpUrl,
  looksLikePageContextQuestion,
  parseBrowserSearchIntent,
  parseBrowserTaskIntent,
  parseOpenTabIntent,
} from "../extension/browser-task-intent.js";
import {
  looksLikeGatewayProfileControlIntent,
  parseProfileQueryIntent,
  parseSettingsIntent,
} from "../extension/settings-intent.js";
import { isStopCommand } from "../extension/stop-intent.js";
import { parseVoiceSamplerAction } from "../extension/voice-sampler.js";

test("browser intent parsing separates direct open, task, and page-context requests", () => {
  assert.deepEqual(parseOpenTabIntent("open example.com/docs"), {
    url: "https://example.com/docs",
    instruction: "open example.com/docs",
  });
  assert.deepEqual(parseBrowserTaskIntent("open https://example.com/report and summarize it"), {
    url: "https://example.com/report",
    instruction: "open https://example.com/report and summarize it",
  });
  assert.equal(parseOpenTabIntent("open example.com and inspect it"), null);
  assert.equal(parseBrowserTaskIntent("summarize example.com"), null);
  assert.equal(extractHttpUrl("visit localhost:8787/health"), "http://localhost:8787/health");
  assert.equal(extractHttpUrl("visit javascript:alert(1)"), null);
  assert.equal(looksLikePageContextQuestion("what am I looking at?"), true);
  assert.equal(looksLikePageContextQuestion("inspect this page"), true);
  assert.equal(looksLikePageContextQuestion("unrelated statement"), false);
  assert.equal(looksLikePageContextQuestion("x".repeat(261)), false);
  assert.deepEqual(parseBrowserSearchIntent("find me an ergonomic red chair on Amazon"), {
    query: "ergonomic red chair", provider: "amazon", active: true,
  });
  assert.deepEqual(parseBrowserSearchIntent("Hey AG, open a new tab that says mechanical keyboards"), {
    query: "mechanical keyboards", provider: "google", active: true,
  });
  assert.deepEqual(parseBrowserSearchIntent("search Amazon for desk lamps"), {
    query: "desk lamps", provider: "amazon", active: true,
  });
  assert.equal(parseBrowserSearchIntent("tell me about ergonomic chairs"), null);
  assert.equal(parseBrowserSearchIntent("find this button"), null);
  assert.equal(parseBrowserSearchIntent("search this page for checkout"), null);
  assert.equal(parseBrowserSearchIntent("find me a product like this on Amazon"), null);
});

test("settings parser handles bounded profile changes and rejects examples", () => {
  assert.deepEqual(parseSettingsIntent("set temperature to 0.4"), {
    patch: { temperature: 0.4 },
    summary: "temperature set to 0.4",
  });
  assert.equal(parseSettingsIntent("set temperature to 4"), null);
  assert.equal(parseSettingsIntent("be terser", { voice_max_chars: 300 }).patch.voice_max_chars, 140);
  assert.equal(parseSettingsIntent("be more verbose", { voice_max_chars: 200 }).patch.voice_max_chars, 600);
  assert.equal(parseSettingsIntent("use the Kore voice").patch.voice, "Kore");
  assert.equal(parseSettingsIntent("only speak English and Amharic").patch.language, "en-US,am-ET");
  assert.equal(parseSettingsIntent("set the model to gpt-test on this browser").scope, "device");
  assert.equal(parseSettingsIntent("set the model to gpt-test on all devices").scope, "global");
  assert.equal(parseSettingsIntent('For example, tell it "use model demo". Then continue.'), null);
  assert.deepEqual(parseProfileQueryIntent("show my prompt history"), { kind: "prompt_history" });
  assert.equal(parseProfileQueryIntent("tell me a joke"), null);
  assert.equal(looksLikeGatewayProfileControlIntent("which voice is active?"), true);
  assert.equal(looksLikeGatewayProfileControlIntent("write a story about a voice"), false);
});

test("stop intent remains conservative", () => {
  for (const phrase of ["stop", "Stop, please!", "shut up now", "be quiet agee"]) {
    assert.equal(isStopCommand(phrase), true, phrase);
  }
  for (const phrase of ["", "stop opening tabs", "please stop sharing my location"]) {
    assert.equal(isStopCommand(phrase), false, phrase);
  }
});

test("voice sampler accepts only bounded versioned samples", () => {
  assert.deepEqual(parseVoiceSamplerAction(null), []);
  assert.deepEqual(parseVoiceSamplerAction({ type: "voice_sampler", version: "v0", voices: [] }), []);
  const samples = parseVoiceSamplerAction({
    type: "voice_sampler",
    version: "voice-sampler/v1",
    voices: [
      { id: "Kore", sample_text: " hello " },
      { id: "../bad", sample_text: "no" },
      { id: "Puck" },
    ],
  });
  assert.deepEqual(samples[0], { voice: "Kore", text: "hello" });
  assert.equal(samples[1].voice, "Puck");
  assert.match(samples[1].text, /This is Puck/);
});
