"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const publicDir = path.join(__dirname, "../public");
const consoleHtml = fs.readFileSync(path.join(publicDir, "console.html"), "utf8");
const developmentHtml = fs.readFileSync(path.join(publicDir, "development.html"), "utf8");
const css = fs.readFileSync(path.join(publicDir, "ag-console.css"), "utf8");
const browserErrors = require("../public/ag-browser-errors.js");

function countId(html, id) {
  return (html.match(new RegExp(`id=["']${id}["']`, "g")) || []).length;
}

test("browser surfaces share the premium product shell and four-part mental model", () => {
  for (const html of [consoleHtml, developmentHtml]) {
    assert.match(html, /href="\/ag-console\.css"/);
    assert.match(html, /class="app-shell"/);
    assert.match(html, />Talk</);
    assert.match(html, />Work</);
    assert.match(html, />Releases</);
    assert.match(html, />Settings</);
    assert.match(html, /class="brand-mark"/);
  }
  assert.match(consoleHtml, /class="nav-link active" href="\/console"/);
  assert.match(developmentHtml, /class="nav-link active" href="\/development"/);
});

test("all interactive API hooks remain singular after the visual restructure", () => {
  const consoleIds = ["healthDot", "healthLabel", "projectLabel", "token", "saveToken", "projects", "pName", "pDir", "pHarness", "createProject", "previewGrid", "refreshPreviews", "brief", "saveBrief", "problem", "outcome", "currentState", "nextStep", "briefStatus", "thread", "empty", "input", "send", "hint"];
  const developmentIds = ["token", "saveToken", "riff", "criteria", "record", "stop", "recordingState", "evidence", "capture", "captureStatus", "intentPanel", "intentTitle", "intentMeta", "intentState", "objective", "tasks", "intentId", "load", "dispatch", "refresh", "loadStatus", "candidatePanel", "candidateSummary", "candidateRef", "verification", "decisionNote", "accept", "reject", "noCandidate"];
  for (const id of consoleIds) assert.equal(countId(consoleHtml, id), 1, `console #${id}`);
  for (const id of developmentIds) assert.equal(countId(developmentHtml, id), 1, `development #${id}`);
});

test("raw connection and harness controls are disclosed as Advanced settings", () => {
  const advanced = consoleHtml.slice(consoleHtml.indexOf('<details class="advanced"'), consoleHtml.indexOf("</details>"));
  assert.match(advanced, /Gateway token/);
  assert.match(advanced, /id="pDir"/);
  assert.match(advanced, /id="pHarness"/);
  assert.match(developmentHtml, /<details class="token-settings" id="connection">/);
});

test("shared CSS provides a narrow no-overflow shell and accessible interaction states", () => {
  assert.match(css, /@media \(max-width: 390px\)/);
  assert.match(css, /grid-template-columns: repeat\(4, minmax\(0,1fr\)\)/);
  assert.match(css, /overflow-wrap: anywhere/);
  assert.match(css, /focus-visible/);
  assert.match(css, /prefers-reduced-motion/);
  assert.doesNotMatch(css, /min-width:\s*(?:4\d\d|[5-9]\d\d)px/);
});

test("HTML proxy failures become bounded status-aware messages before reaching the UI", () => {
  const proxyPage = '<!DOCTYPE HTML><html><head><title>Error response</title></head><body><h1>Error response</h1><p>File not found.</p></body></html>';
  assert.equal(
    browserErrors.message({ status: 404 }, { error: proxyPage }, proxyPage),
    "That gateway service is not available.",
  );
  assert.equal(
    browserErrors.message({ status: 502 }, { error: proxyPage }, proxyPage),
    "The gateway is temporarily unavailable. Try again shortly.",
  );
  assert.equal(browserErrors.message({ status: 401 }, {}, ""), "Connection needs attention. Check the gateway token in Settings.");
  assert.equal(browserErrors.message({ status: 400 }, { error: "Project name is required." }, ""), "Project name is required.");
  const longMessage = browserErrors.message({ status: 400 }, { error: "x".repeat(400) }, "");
  assert.ok(longMessage.length <= 180);
  assert.doesNotMatch(longMessage, /[<>]/);
  for (const html of [consoleHtml, developmentHtml]) {
    assert.match(html, /src="\/ag-browser-errors\.js"/);
    assert.match(html, /AgBrowserErrors\.message/);
  }
});
