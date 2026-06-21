import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const requiredFiles = [
  "extension/manifest.json",
  "extension/background.js",
  "extension/browser-task-intent.js",
  "extension/config.js",
  "extension/content.js",
  "extension/tweaks.js",
  "extension/options.html",
  "extension/options.js",
  "extension/settings-intent.js",
  "extension/overlay.css",
  "extension/dev.html",
  "extension/dev.js",
  "docs/research.md",
  "docs/architecture.md",
  "docs/task-split.md",
  "docs/validation.md",
  "fixtures/demo.html",
  "LICENSE",
  "scripts/smoke-extension.mjs",
  "scripts/dev-extension.mjs",
  "scripts/doctor.mjs",
  "scripts/chrome-for-testing.mjs",
  "scripts/poke-dev-reload.mjs",
  "scripts/smoke-gateway.mjs",
  "scripts/smoke-settings.mjs",
];

for (const file of requiredFiles) {
  readFileSync(file, "utf8");
}

const manifest = JSON.parse(readFileSync("extension/manifest.json", "utf8"));
const backgroundSource = readFileSync("extension/background.js", "utf8");
const contentSource = readFileSync("extension/content.js", "utf8");
const requiredPermissions = ["activeTab", "tabs", "scripting", "storage", "debugger", "alarms"];

if (manifest.manifest_version !== 3) {
  throw new Error("manifest_version must be 3");
}

for (const permission of requiredPermissions) {
  if (!manifest.permissions?.includes(permission)) {
    throw new Error(`missing permission: ${permission}`);
  }
}

if (!manifest.commands?.["toggle-agee"]) {
  throw new Error("missing toggle-agee command");
}

if (backgroundSource.includes('import "./dev-reload.js"')) {
  throw new Error("background.js must not import the stale always-on dev reload loop");
}

if (/new\s+WebSocket\s*\(/.test(contentSource)) {
  throw new Error("content scripts must not open gateway WebSockets; background.js owns voice transport to avoid HTTPS mixed-content blocking");
}

if (!/cmd === "voiceSessionStart"/.test(backgroundSource)) {
  throw new Error("background.js must expose the voiceSessionStart proxy command");
}

if (!/recoverLiveVoiceTurn\(state, msg\.message/.test(contentSource)) {
  throw new Error("a mid-generation live voice error must recover silently (respawn the session), not surface a failure and stop");
}

if (!/assistantSpeechOverlap\s*=\s*false/.test(contentSource)) {
  throw new Error("content.js must keep a session-scoped assistant speech overlap policy");
}

if (!/if \(!preserveAssistantPlayback\)\s*\{\s*stopSpeaking\(\);/.test(contentSource)) {
  throw new Error("starting a live voice turn must preserve assistant playback when overlap mode is enabled");
}

if (!/liveVoiceBySessionId\.get\(msg\.voiceSessionId\)/.test(contentSource)) {
  throw new Error("content.js must route live voice events by voiceSessionId so older speaking turns are not discarded");
}

if (!/assistantOverlap:\s*assistantSpeechOverlap === true/.test(contentSource)) {
  throw new Error("content.js must pass assistant overlap policy when opening a voice session");
}

if (!/playback_policy:\s*\{\s*assistant_overlap:\s*assistantOverlap === true/.test(backgroundSource)) {
  throw new Error("background.js must forward assistant overlap policy into the gateway voice session_start event");
}

for (const file of [
  "extension/background.js",
  "extension/browser-task-intent.js",
  "extension/config.js",
  "extension/content.js",
  "extension/tweaks.js",
  "extension/options.js",
  "extension/settings-intent.js",
  "extension/dev.js",
  "scripts/dev-extension.mjs",
  "scripts/doctor.mjs",
  "scripts/poke-dev-reload.mjs",
  "scripts/smoke-extension.mjs",
  "scripts/smoke-tweaks.mjs",
  "scripts/smoke-gateway.mjs",
  "scripts/smoke-settings.mjs",
  "scripts/smoke-cdp.mjs",
  "scripts/smoke-integration.mjs",
  "scripts/smoke-history.mjs",
  "scripts/chrome-for-testing.mjs",
]) {
  execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
}

const { parseSettingsIntent } = await import("../extension/settings-intent.js");
const { parseBrowserTaskIntent } = await import("../extension/browser-task-intent.js");

const setupParagraph =
  'Open chrome://extensions, find agee, click reload. If it was loaded from elsewhere, remove it and Load unpacked from software/browser_extension/extension/.\n' +
  'On any page, press Cmd+K to open it, and type a request, for example "summarize this page" or "what can you do." You get a response from the gateway. Tell it "use the Kore voice" and it changes its own voice. Ask it to open a page and report something, and it launches a browser agent.';
const voiceIntent = parseSettingsIntent("use the Kore voice", null);
if (voiceIntent?.patch?.voice !== "Kore") {
  throw new Error("settings parser should accept a direct Kore voice request");
}
const languageIntent = parseSettingsIntent("only speak English and Amharic, don't switch up", null);
if (
  languageIntent?.patch?.language !== "en-US,am-ET" ||
  languageIntent?.patch?.language_primary !== "en-US" ||
  languageIntent?.patch?.language_auto_switch !== false
) {
  throw new Error(`settings parser should lock the language profile, got: ${JSON.stringify(languageIntent)}`);
}
if (parseSettingsIntent(setupParagraph, null) !== null) {
  throw new Error("settings parser should ignore quoted settings examples inside setup text");
}
const taskIntent = parseBrowserTaskIntent("open https://example.com/docs and report the title");
if (taskIntent?.url !== "https://example.com/docs") {
  throw new Error(`browser-task parser returned unexpected URL: ${taskIntent?.url}`);
}
if (parseBrowserTaskIntent(setupParagraph) !== null) {
  throw new Error("browser-task parser should not treat setup text as a browser task");
}

console.log("extension verification passed");
