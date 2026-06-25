import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const requiredFiles = [
  "extension/manifest.json",
  "extension/background.js",
  "extension/browser-task-intent.js",
  "extension/config.js",
  "extension/content.js",
  "extension/tweaks.js",
  "extension/offscreen.html",
  "extension/offscreen.js",
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
  "scripts/smoke-ambient.mjs",
  "scripts/smoke-settings.mjs",
  "scripts/smoke-live-voice-main.mjs",
];

for (const file of requiredFiles) {
  readFileSync(file, "utf8");
}

const manifest = JSON.parse(readFileSync("extension/manifest.json", "utf8"));
const backgroundSource = readFileSync("extension/background.js", "utf8");
const contentSource = readFileSync("extension/content.js", "utf8");
const overlayCssSource = readFileSync("extension/overlay.css", "utf8");
const offscreenSource = readFileSync("extension/offscreen.js", "utf8");
const optionsHtmlSource = readFileSync("extension/options.html", "utf8");
const optionsSource = readFileSync("extension/options.js", "utf8");
const requiredPermissions = ["activeTab", "tabs", "scripting", "storage", "debugger", "alarms", "offscreen"];
const requiredHostPermissions = ["http://*/*", "https://*/*"];

if (manifest.manifest_version !== 3) {
  throw new Error("manifest_version must be 3");
}

for (const permission of requiredPermissions) {
  if (!manifest.permissions?.includes(permission)) {
    throw new Error(`missing permission: ${permission}`);
  }
}

for (const permission of requiredHostPermissions) {
  if (!manifest.host_permissions?.includes(permission)) {
    throw new Error(`missing host permission for hotkey content injection: ${permission}`);
  }
}

if (!manifest.commands?.["toggle-agee"]) {
  throw new Error("missing toggle-agee command");
}

if (
  manifest.commands?.["toggle-agee"]?.suggested_key?.mac !== "Command+Comma" ||
  manifest.commands?.["toggle-agee"]?.suggested_key?.default !== "Ctrl+Comma"
) {
  throw new Error("missing toggle-agee command for Cmd/Ctrl+Comma");
}

if (
  manifest.commands?.["toggle-agee-voice"]?.suggested_key?.mac !== "Command+Period" ||
  manifest.commands?.["toggle-agee-voice"]?.suggested_key?.default !== "Ctrl+Period"
) {
  throw new Error("missing toggle-agee-voice command for Cmd/Ctrl+Period");
}

if (backgroundSource.includes('import "./dev-reload.js"')) {
  throw new Error("background.js must not import the stale always-on dev reload loop");
}

if (/new\s+WebSocket\s*\(/.test(contentSource)) {
  throw new Error("content scripts must not open gateway WebSockets; background.js owns voice transport to avoid HTTPS mixed-content blocking");
}

if (/mediaDevices\.getUserMedia/.test(contentSource)) {
  throw new Error("content scripts must not request microphone permission; offscreen.js owns extension-origin mic capture");
}

if (!/chrome\.offscreen\.createDocument/.test(backgroundSource) || !/reasons:\s*\[\s*"USER_MEDIA"\s*\]/.test(backgroundSource)) {
  throw new Error("background.js must create an offscreen USER_MEDIA document for extension-owned microphone capture");
}

if (!/cmd:\s*"offscreenVoiceCaptureStart"/.test(backgroundSource) || !/cmd === "offscreenVoiceAudio"/.test(backgroundSource)) {
  throw new Error("background.js must start offscreen voice capture and receive PCM chunks from it");
}

if (!/navigator\.mediaDevices\.getUserMedia/.test(offscreenSource) || !/offscreenVoiceAudio/.test(offscreenSource)) {
  throw new Error("offscreen.js must own microphone capture and forward PCM chunks to background.js");
}

if (!/Grant microphone/.test(optionsHtmlSource) || !/navigator\.mediaDevices\.getUserMedia/.test(optionsSource)) {
  throw new Error("options page must expose a one-time extension microphone grant path");
}

if (
  !/microphone_capture_failed/.test(backgroundSource) ||
  !/recoverable:\s*false/.test(backgroundSource) ||
  !/chrome:\/\/extensions\/\?id=\$\{chrome\.runtime\.id\}/.test(backgroundSource) ||
  !/chrome\.runtime\.openOptionsPage/.test(backgroundSource) ||
  !/msg\.recoverable === false \|\| msg\.code === "microphone_capture_failed"/.test(contentSource)
) {
  throw new Error("extension offscreen microphone failures must be explicit, non-recoverable, and guide the user to grant extension microphone permission");
}

if (!/cmd === "voiceSessionStart"/.test(backgroundSource)) {
  throw new Error("background.js must expose the voiceSessionStart proxy command");
}

if (
  !/command !== "toggle-agee" && command !== "toggle-agee-voice"/.test(backgroundSource) ||
  !/cmd:\s*command === "toggle-agee-voice" \? "toggleVoice" : "open"/.test(backgroundSource) ||
  !/case "toggleVoice":/.test(contentSource) ||
  !/function ensureContentOnOpenTabs/.test(backgroundSource) ||
  !/chrome\.runtime\.onStartup\.addListener/.test(backgroundSource)
) {
  throw new Error("Cmd/Ctrl+Period must be wired through command handling and startup/update content injection");
}

if (!/function visiblePageText/.test(contentSource) || !/pageText:\s*visiblePageText\(\)/.test(contentSource)) {
  throw new Error("content snapshot must include visible page text, not only actionable elements");
}

if (!/e\.code === "Comma"/.test(contentSource) || /toLowerCase\(\) === "k"/.test(contentSource)) {
  throw new Error("text command hotkey must be Cmd/Ctrl+Comma, not Cmd/Ctrl+K");
}

if (/case "done":[\s\S]{0,180}setInputText\(msg\.summary/.test(contentSource)) {
  throw new Error("done replies must render in the result surface, not inside the command input");
}

if (!/VOICE_AUTO_COMMIT_SILENCE_MS/.test(backgroundSource) || !/autoCommitVoiceSession/.test(backgroundSource)) {
  throw new Error("browser voice must auto-commit microphone turns after speech silence");
}

if (
  !/cmd === "voiceSessionAttach"/.test(backgroundSource) ||
  !/pendingEvents/.test(backgroundSource) ||
  !/cmd:\s*"voiceSessionAttach"/.test(contentSource)
) {
  throw new Error("voice session events must be buffered until the content script attaches the session id");
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

if (/Listening\.\.\.|listening\.\.\.|stopping…|stopping\.\.\./.test(contentSource)) {
  throw new Error("content.js must not render voice lifecycle filler text such as Listening/listening/stopping");
}

if (!/function ensureVoiceCueCard/.test(contentSource)) {
  throw new Error("browser voice must promote live transcript/assistant text into the result surface above the input");
}

function sourceBetween(source, startPattern, endPattern, label) {
  const start = source.search(startPattern);
  if (start < 0) throw new Error(`could not find ${label} start`);
  const rest = source.slice(start);
  const end = rest.search(endPattern);
  if (end < 0) throw new Error(`could not find ${label} end`);
  return rest.slice(0, end);
}

if (!/msg\.type === "transcript_partial"[\s\S]{0,520}ensureVoiceCueCard\(state, text/.test(contentSource)) {
  throw new Error("browser voice partial transcripts must render as cue cards above the input");
}

if (!/function isIdentityProfileControl/.test(contentSource) || !/your name/.test(contentSource) || !/call\|name/.test(contentSource)) {
  throw new Error("browser Live voice must route spoken assistant-name changes through the gateway profile-control path");
}

if (!/openTextSurface\(\{\s*fresh:\s*false\s*\}\);[\s\S]{0,220}conversationActive = true;/.test(contentSource)) {
  throw new Error("browser voice start must keep the input surface open while the user speaks");
}

const openTextSurfaceBody = sourceBetween(
  contentSource,
  /function openTextSurface\(/,
  /function closeTextSurface\(/,
  "openTextSurface"
);
if (/surfacePhase === "idle"[\s\S]{0,100}setInputText\(\s*""/.test(openTextSurfaceBody)) {
  throw new Error("openTextSurface({ fresh: false }) must preserve hidden typed drafts");
}

const submitInstructionBody = sourceBetween(
  contentSource,
  /function submitInstruction\(/,
  /function describePage\(/,
  "submitInstruction"
);
if (/setInputText\(\s*""/.test(submitInstructionBody)) {
  throw new Error("submitting a typed command must not clear the draft buffer");
}

const startLiveVoiceTurnBody = sourceBetween(
  contentSource,
  /async function startLiveVoiceTurn\(/,
  /function handleLiveVoiceMessage\(/,
  "startLiveVoiceTurn"
);
if (/setInputText\(\s*""/.test(startLiveVoiceTurnBody)) {
  throw new Error("starting browser voice must not clear an existing typed draft");
}

if (!/voiceButton\.addEventListener\("click"[\s\S]{0,220}openTextSurface\(\{\s*fresh:\s*false\s*\}\);[\s\S]{0,120}primeAudio\(\);[\s\S]{0,120}toggleVoice\(\);/.test(contentSource)) {
  throw new Error("voice button click must open the input surface and prime audio before starting live voice");
}

if (!/if \(liveVoice && listening\) \{[\s\S]{0,180}commitLiveVoiceTurn\(\);/.test(contentSource)) {
  throw new Error("single-clicking the launcher while voice is listening must send the current speech turn");
}

if (/#agee-root\.agee-voicing #agee-voice-state \{[\s\S]{0,80}display:\s*flex;/.test(overlayCssSource)) {
  throw new Error("browser voice must not show a separate top voice-state strip");
}

if (!/#agee-root\.agee-voicing #agee-voice-state \{[\s\S]{0,80}display:\s*none;/.test(overlayCssSource)) {
  throw new Error("top voice-state strip must stay hidden during browser voice");
}

const doneMessageCase = sourceBetween(contentSource, /case "done":/, /case "error":/, "done message case");
const errorMessageCase = sourceBetween(contentSource, /case "error":/, /case "agentRevoked":/, "error message case");
if (/setInputText\(\s*""/.test(doneMessageCase) || /setInputText\(\s*""/.test(errorMessageCase)) {
  throw new Error("browser replies and errors must render above the composer without clearing typed drafts");
}

if (!/function safeRuntimeSendMessage/.test(contentSource) || !/function safeStorageLocalGet/.test(contentSource) || !/function safeStorageLocalSet/.test(contentSource)) {
  throw new Error("content.js must guard runtime and storage calls against stale extension contexts");
}

if (
  !/looksLikeGatewayProfileControlIntent/.test(backgroundSource) ||
  !/function maybeRouteGatewayProfileControl/.test(backgroundSource) ||
  !/data\?\.classification === "profile_control"/.test(backgroundSource)
) {
  throw new Error("typed voice/language profile controls must route through /v1/voice/turns and refresh the profile cache");
}

if (!/function claimActiveAgentTab/.test(backgroundSource) || !/function revokeOtherTabVoiceSessions/.test(backgroundSource)) {
  throw new Error("background.js must claim one active page-agent tab and revoke other-tab voice sessions");
}

if (!/cmd:\s*"agentRevoked"/.test(backgroundSource) || !/case "agentRevoked"/.test(contentSource)) {
  throw new Error("background/content scripts must share an agentRevoked message for cross-tab shutdown");
}

if (!/event:\s*session\.revoked[\s\S]*type:\s*"revoked"/.test(backgroundSource)) {
  throw new Error("background.js must tag extension-closed voice sockets as revoked so old tabs do not auto-recover");
}

if (!/AMBIENT_DEFAULT_INTERVAL_MS\s*=\s*200/.test(backgroundSource)) {
  throw new Error("ambient frame loop must default to a 200 ms interval");
}

if (!/cmd === "ambientStart"/.test(backgroundSource) || !/\/v1\/voice\/frames/.test(backgroundSource)) {
  throw new Error("background.js must expose ambientStart and post ambient frames to /v1/voice/frames");
}

if (!/captureAmbientFrame\(\)\.catch\(\(\) => \{\}\);/.test(backgroundSource)) {
  throw new Error("ambientStart must trigger the first frame immediately before the 200 ms interval");
}

if (!/case "ambient":/.test(contentSource) || !/agee-ambient/.test(contentSource)) {
  throw new Error("content.js must acknowledge ambient on/off state from the background");
}

for (const file of [
  "extension/background.js",
  "extension/browser-task-intent.js",
  "extension/config.js",
  "extension/content.js",
  "extension/offscreen.js",
  "extension/tweaks.js",
  "extension/options.js",
  "extension/settings-intent.js",
  "extension/dev.js",
  "scripts/dev-extension.mjs",
  "scripts/doctor.mjs",
  "scripts/poke-dev-reload.mjs",
  "scripts/smoke-extension.mjs",
  "scripts/smoke-ambient.mjs",
  "scripts/smoke-tweaks.mjs",
  "scripts/smoke-gateway.mjs",
  "scripts/smoke-settings.mjs",
  "scripts/smoke-live-voice-main.mjs",
  "scripts/smoke-cdp.mjs",
  "scripts/smoke-integration.mjs",
  "scripts/smoke-history.mjs",
  "scripts/chrome-for-testing.mjs",
]) {
  execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
}

const { parseSettingsIntent, looksLikeGatewayProfileControlIntent } = await import("../extension/settings-intent.js");
const { parseBrowserTaskIntent, parseOpenTabIntent } = await import("../extension/browser-task-intent.js");
const devExtensionSource = readFileSync("scripts/dev-extension.mjs", "utf8");
const pokeDevReloadSource = readFileSync("scripts/poke-dev-reload.mjs", "utf8");

if (!/\/__agee-dev\/bump/.test(devExtensionSource) || !/function bumpVersion/.test(devExtensionSource)) {
  throw new Error("dev-extension.mjs must expose /__agee-dev/bump so deploy can force a reload version");
}
if (!/\/__agee-dev\/bump/.test(pokeDevReloadSource) || !/bumpExistingServer/.test(pokeDevReloadSource)) {
  throw new Error("poke-dev-reload.mjs must ask an already-running dev server to bump its reload version");
}

const setupParagraph =
  'Open chrome://extensions, find agee, click reload. If it was loaded from elsewhere, remove it and Load unpacked from software/browser_extension/extension/.\n' +
  'On any page, press Cmd+, to open it, and type a request, for example "summarize this page" or "what can you do." You get a response from the gateway. Tell it "use the Kore voice" and it changes its own voice. Ask it to open a page and report something, and it launches a browser agent.';
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
if (looksLikeGatewayProfileControlIntent(setupParagraph)) {
  throw new Error("gateway profile-control detector should ignore quoted settings examples inside setup text");
}
for (const text of [
  "use the Kore voice",
  "switch to Aoede",
  "respond only in English",
  "speak Amharic and English",
  "only process English and Amharic",
  "change your language to Amharic",
  "your name is Moa",
  "call yourself The Steward",
  "what voice is active",
  "what is your name",
  "what language settings are active",
]) {
  if (!looksLikeGatewayProfileControlIntent(text)) {
    throw new Error(`gateway profile-control detector should accept: ${text}`);
  }
}
const taskIntent = parseBrowserTaskIntent("open https://example.com/docs and report the title");
if (taskIntent?.url !== "https://example.com/docs") {
  throw new Error(`browser-task parser returned unexpected URL: ${taskIntent?.url}`);
}
const openTabIntent = parseOpenTabIntent("open https://example.com/docs in a new tab");
if (openTabIntent?.url !== "https://example.com/docs") {
  throw new Error(`open-tab parser returned unexpected URL: ${openTabIntent?.url}`);
}
if (parseOpenTabIntent("open https://example.com/docs and report the title") !== null) {
  throw new Error("open/report requests should stay on the browser task-agent path, not direct tab opening");
}
if (parseBrowserTaskIntent(setupParagraph) !== null) {
  throw new Error("browser-task parser should not treat setup text as a browser task");
}

console.log("extension verification passed");
