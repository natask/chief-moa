const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

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
  assert.doesNotThrow(() => new vm.Script(inlineScript(html)));
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
  }
});
