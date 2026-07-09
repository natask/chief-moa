import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const backgroundSource = readFileSync("extension/background.js", "utf8");
const contentSource = readFileSync("extension/content.js", "utf8");
const overlayCssSource = readFileSync("extension/overlay.css", "utf8");
const packageJson = JSON.parse(readFileSync("package.json", "utf8"));

function sourceBetween(source, startPattern, endPattern, label) {
  const start = source.search(startPattern);
  if (start < 0) throw new Error(`missing ${label} start`);
  const rest = source.slice(start);
  const end = rest.search(endPattern);
  if (end < 0) throw new Error(`missing ${label} end`);
  return rest.slice(0, end);
}

if (!/UI_SPEC_CACHE_KEY/.test(backgroundSource) || !/ageeUiSpec/.test(backgroundSource)) {
  throw new Error("background.js must cache UI specs in chrome.storage.local");
}
if (!/async function fetchUiSpec/.test(backgroundSource) || !/\/v1\/ui\/spec/.test(backgroundSource)) {
  throw new Error("background.js must fetch GET /v1/ui/spec");
}
if (!/callGateway\(cfg,\s*"\/v1\/ui\/spec",\s*\{\s*method:\s*"GET"/.test(backgroundSource)) {
  throw new Error("UI spec fetch must use the existing callGateway helper");
}
if (!/function normalizeUiSpecPayload/.test(backgroundSource) || !/spec\.version !== 1/.test(backgroundSource)) {
  throw new Error("background.js must normalize the gateway UI spec envelope");
}
if (!/async function cachedUiSpecRecord/.test(backgroundSource) || !/stale_reason/.test(backgroundSource)) {
  throw new Error("background.js must preserve last-good UI spec cache and mark it stale on failure");
}
if (!/msg\.cmd === "uiSpec"/.test(backgroundSource)) {
  throw new Error("background.js must expose the uiSpec content-script command");
}
if (!/refreshUiSpec\("turn_complete"\)/.test(backgroundSource)) {
  throw new Error("background.js must refresh UI spec after gateway turns complete");
}
if (!/UI_SPEC_ALARM/.test(backgroundSource) || !/refreshUiSpec\("alarm"\)/.test(backgroundSource)) {
  throw new Error("background.js must periodically refresh UI specs for loaded pages");
}

for (const type of ["card", "list", "map", "stat"]) {
  if (!contentSource.includes(`"${type}"`)) {
    throw new Error(`content.js missing UI spec component type: ${type}`);
  }
  if (!overlayCssSource.includes(`agee-ui-${type}`)) {
    throw new Error(`overlay.css missing UI spec component styling: ${type}`);
  }
}
for (const action of ["voice.toggle", "command.open", "agent.run", "page.describe", "settings.open", "noop"]) {
  if (!contentSource.includes(`"${action}"`)) {
    throw new Error(`content.js missing UI spec action: ${action}`);
  }
}

if (!/function sanitizeUiSpecPayload/.test(contentSource) || !/function renderUiSpecSurface/.test(contentSource)) {
  throw new Error("content.js must sanitize and render UI specs");
}
if (!/safeRuntimeSendMessage\(\{\s*cmd:\s*"uiSpec"/.test(contentSource)) {
  throw new Error("content.js must request UI specs from background");
}
if (!/changes\[UI_SPEC_CACHE_KEY\]/.test(contentSource)) {
  throw new Error("content.js must live-refresh UI spec cache changes");
}
if (!/function renderUiMap/.test(contentSource) || !/agee-ui-map-pin/.test(contentSource)) {
  throw new Error("content.js must render the bounded map component");
}
if (!/runUiAction\(control\.action/.test(contentSource) || !/submitInstruction\(resolvedPrompt/.test(contentSource)) {
  throw new Error("UI controls must route agent.run through the existing submitInstruction path");
}

const rendererBody = sourceBetween(
  contentSource,
  /function sanitizeUiSpecPayload\(/,
  /function loadAvatarBehaviorRuntime\(/,
  "UI spec renderer",
);
if (/\beval\s*\(|new\s+Function|executeScript|script\b/i.test(rendererBody)) {
  throw new Error("UI spec rendering must remain declarative and must not execute generated JS");
}

for (const cssToken of [
  "#agee-ui-surface",
  ".agee-ui-shell",
  ".agee-ui-controls",
  ".agee-ui-map",
  ".agee-ui-map-pin",
]) {
  if (!overlayCssSource.includes(cssToken)) {
    throw new Error(`overlay.css missing UI spec selector: ${cssToken}`);
  }
}

if (packageJson.scripts?.["smoke:ui-spec"] !== "node scripts/smoke-ui-spec.mjs") {
  throw new Error("package.json must expose npm run smoke:ui-spec");
}

for (const file of [
  "extension/background.js",
  "extension/content.js",
  "scripts/smoke-ui-spec.mjs",
]) {
  execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
}

console.log("ui-spec smoke passed");
