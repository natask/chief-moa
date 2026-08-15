const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const browserErrors = require("../public/ag-browser-errors.js");

const publicDir = path.resolve(__dirname, "../public");

function source(name) {
  return fs.readFileSync(path.join(publicDir, name), "utf8");
}

function ids(html) {
  return [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
}

function inlineScript(html) {
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(match, "surface must retain an inline controller");
  return match[1];
}

function luminance(hex) {
  const channels = hex.match(/[0-9a-f]{2}/gi).map((value) => Number.parseInt(value, 16) / 255);
  const linear = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return (0.2126 * linear[0]) + (0.7152 * linear[1]) + (0.0722 * linear[2]);
}

function contrast(foreground, background) {
  const light = Math.max(luminance(foreground), luminance(background));
  const dark = Math.min(luminance(foreground), luminance(background));
  return (light + 0.05) / (dark + 0.05);
}

test("gateway operator preserves its complete interaction contract", () => {
  const html = source("gateway-ui.html");
  const required = [
    "originLabel", "healthDot", "healthLabel", "tokenDot", "tokenLabel", "refreshAll",
    "token", "saveToken", "clearToken", "connectionStatus", "healthBody", "refreshHistory",
    "historyList", "profileDot", "profileState", "systemPrompt", "model", "voice",
    "temperature", "voiceMaxChars", "language", "profileCommand", "applyCommand",
    "saveProfile", "reloadProfile", "resetProfile", "profileStatus", "refreshSessions",
    "sessionsList", "refreshRuns", "runsList",
  ];
  const found = ids(html);
  for (const id of required) assert.equal(found.filter((value) => value === id).length, 1, `${id} must remain unique`);
  assert.match(html, />Talk</);
  assert.match(html, />Work</);
  assert.match(html, />Settings</);
  assert.match(html, /src="\/ag-browser-errors\.js"/);
  assert.match(html, /AgBrowserErrors\.message\(resp, data, text\)/);
  assert.doesNotThrow(() => new vm.Script(inlineScript(html)));
});

test("gateway operator never renders proxy HTML as an error message", () => {
  const proxyPage = "<!doctype html><html><head><title>Bad gateway</title></head><body><h1>Proxy error</h1></body></html>";
  for (const status of [404, 502]) {
    const message = browserErrors.message({ status }, { error: proxyPage }, proxyPage);
    assert.ok(message.length <= 180);
    assert.doesNotMatch(message, /[<>]|doctype|<\/h1>/i);
  }
  assert.equal(
    browserErrors.message({ status: 404 }, { error: proxyPage }, proxyPage),
    "That gateway service is not available.",
  );
  assert.equal(
    browserErrors.message({ status: 502 }, { error: proxyPage }, proxyPage),
    "The gateway is temporarily unavailable. Try again shortly.",
  );
});

test("credential operator preserves controls and narrow-screen containment", () => {
  const html = source("credential-panel.html");
  const required = [
    "connDot", "connLabel", "scale", "token", "save", "clear", "reload", "health",
    "err", "summary", "connections", "notifications", "providersBox", "providers",
  ];
  const found = ids(html);
  for (const id of required) assert.equal(found.filter((value) => value === id).length, 1, `${id} must remain unique`);
  assert.match(html, /@media \(max-width: 540px\)/);
  assert.match(html, /grid-template-columns:1fr 1fr/);
  assert.match(html, /#notifications, #providers \{ max-width:100%; overflow-x:auto; \}/);
  assert.doesNotThrow(() => new vm.Script(inlineScript(html)));
});

test("operator surfaces share the Obsidian Atelier design language", () => {
  for (const name of ["gateway-ui.html", "credential-panel.html"]) {
    const html = source(name);
    assert.match(html, /#09090a/);
    assert.match(html, /#e8c979/);
    assert.match(html, /Iowan Old Style/);
    assert.match(html, /radial-gradient/);
    assert.match(html, /color-scheme: dark/);
    const quiet = html.match(/--quiet:\s*(#[0-9a-f]{6})/i);
    const canvas = html.match(/(?:--canvas|--bg):\s*(#[0-9a-f]{6})/i);
    assert.ok(quiet && canvas, `${name} must expose readable quiet and canvas tokens`);
    assert.ok(contrast(quiet[1], canvas[1]) >= 4.5, `${name} quiet text must meet WCAG AA contrast`);
  }
});
