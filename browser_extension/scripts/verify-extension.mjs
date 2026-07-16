import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const requiredFiles = [
  "package.json",
  "extension/manifest.json",
  "extension/background.js",
  "extension/browser-agent-loop-policy.js",
  "extension/browser-agent-role-runtime.js",
  "extension/browser-context-adapter.js",
  "extension/browser-settings-registry.js",
  "extension/browser-task-intent.js",
  "extension/browser-turn-protocol.js",
  "extension/browser-context-adapter.js",
  "extension/config.js",
  "extension/content-companion-policy-runtime.js",
  "extension/content-context-control-runtime.js",
  "extension/content-extension-api-runtime.js",
  "extension/content-note-controller-runtime.js",
  "extension/content-ui-controller-runtime.js",
  "extension/content-voice-policy-runtime.js",
  "extension/content.js",
  "extension/page-observation-runtime.js",
  "extension/tweaks.js",
  "extension/offscreen.html",
  "extension/offscreen.js",
  "extension/offscreen-voice-bridge.js",
  "extension/offscreen-audio-worklet.js",
  "extension/livekit-voice.js",
  "extension/voice-sampler.js",
  "extension/voice-sampler-runtime.js",
  "extension/offscreen-livekit.html",
  "extension/offscreen-livekit.js",
  "extension/vendor/livekit-client.esm.js",
  "extension/options.html",
  "extension/options.js",
  "extension/options-recovery.js",
  "extension/settings-intent.js",
  "extension/overlay.css",
  "extension/sidepanel.html",
  "extension/sidepanel.js",
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
  "scripts/smoke-ui-spec.mjs",
  "scripts/smoke-unified-browser-agent.mjs",
  "scripts/test-voice-sampler-lifecycle.mjs",
  "scripts/test-cue-dismiss.mjs",
  "scripts/test-browser-context-adapter.mjs",
  "scripts/test-browser-agent-role-runtime.mjs",
  "scripts/test-browser-agent-loop-policy.mjs",
  "scripts/test-browser-turn-protocol.mjs",
  "scripts/test-extension-production-sources.mjs",
  "scripts/test-runtime-intent-modules.mjs",
  "scripts/extension-production-sources.mjs",
  "scripts/coverage-extension.mjs",
  "scripts/coverage-ratchet.json",
];

for (const file of requiredFiles) {
  readFileSync(file, "utf8");
}

const manifest = JSON.parse(readFileSync("extension/manifest.json", "utf8"));
const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const backgroundSource = readFileSync("extension/background.js", "utf8");
const browserSettingsRegistrySource = readFileSync("extension/browser-settings-registry.js", "utf8");
const browserAgentLoopPolicySource = readFileSync("extension/browser-agent-loop-policy.js", "utf8");
const browserTurnProtocolSource = readFileSync("extension/browser-turn-protocol.js", "utf8");
const voiceSamplerSource = readFileSync("extension/voice-sampler.js", "utf8");
const voiceSamplerRuntimeSource = readFileSync("extension/voice-sampler-runtime.js", "utf8");
const configSource = readFileSync("extension/config.js", "utf8");
const contentCompanionPolicySource = readFileSync("extension/content-companion-policy-runtime.js", "utf8");
const contentContextControlSource = readFileSync("extension/content-context-control-runtime.js", "utf8");
const contentExtensionApiSource = readFileSync("extension/content-extension-api-runtime.js", "utf8");
const contentNoteControllerSource = readFileSync("extension/content-note-controller-runtime.js", "utf8");
const contentUiControllerSource = readFileSync("extension/content-ui-controller-runtime.js", "utf8");
const contentVoicePolicySource = readFileSync("extension/content-voice-policy-runtime.js", "utf8");
const contentSource = readFileSync("extension/content.js", "utf8");
const pageObservationRuntimeSource = readFileSync("extension/page-observation-runtime.js", "utf8");
const overlayCssSource = readFileSync("extension/overlay.css", "utf8");
const offscreenSource = readFileSync("extension/offscreen.js", "utf8");
const offscreenHtmlSource = readFileSync("extension/offscreen.html", "utf8");
const offscreenVoiceBridgeSource = readFileSync("extension/offscreen-voice-bridge.js", "utf8");
const offscreenWorkletSource = readFileSync("extension/offscreen-audio-worklet.js", "utf8");
const optionsHtmlSource = readFileSync("extension/options.html", "utf8");
const optionsSource = readFileSync("extension/options.js", "utf8");
const optionsRecoverySource = readFileSync("extension/options-recovery.js", "utf8");
const sidepanelHtmlSource = readFileSync("extension/sidepanel.html", "utf8");
const sidepanelSource = readFileSync("extension/sidepanel.js", "utf8");
const coverageSource = readFileSync("scripts/coverage-extension.mjs", "utf8");
const extensionSmokeSource = readFileSync("scripts/smoke-extension.mjs", "utf8");
const requiredPermissions = ["activeTab", "tabs", "scripting", "storage", "debugger", "alarms", "offscreen", "sidePanel"];
const requiredHostPermissions = ["http://*/*", "https://*/*", "wss://api.agee.app/*"];

if (!/MAX_SAMPLES = 16/.test(voiceSamplerSource) || !/voice-sampler\/v1/.test(voiceSamplerSource)) {
  throw new Error("voice sampler actions must be version-gated and capped");
}
if (!/capture: "none"/.test(backgroundSource) || !/profile_override: profileOverride/.test(backgroundSource)) {
  throw new Error("voice sampler must use text-only sessions with a session-only profile override");
}
if (!/function handleSessionTerminal/.test(voiceSamplerRuntimeSource) || !/sampler\.index \+= 1/.test(voiceSamplerRuntimeSource)) {
  throw new Error("voice sampler must advance sequentially only after a terminal turn event");
}
if (
  !/handleSessionTerminal\(session\.id,\s*\{[\s\S]{0,220}closeReason:\s*failed \? "sample failed" : "sample complete"/.test(backgroundSource) ||
  !/Live voice connection failed\./.test(backgroundSource) ||
  !/Live voice connection closed\./.test(backgroundSource)
) {
  throw new Error("voice sampler must treat socket error and close as terminal sampler events");
}

if (manifest.manifest_version !== 3) {
  throw new Error("manifest_version must be 3");
}
if (
  !/browser\.gateway_url/.test(browserSettingsRegistrySource) ||
  !/browser\.gateway_token/.test(browserSettingsRegistrySource) ||
  !/browser\.livekit_voice/.test(browserSettingsRegistrySource) ||
  !/browser\.background_automation/.test(browserSettingsRegistrySource) ||
  !/browser\.microphone_permission/.test(browserSettingsRegistrySource) ||
  !/configured \(value redacted\)/.test(browserSettingsRegistrySource) ||
  !/msg\.cmd === "settingsQuery"/.test(backgroundSource) ||
  !/id="settingsSearch"/.test(sidepanelHtmlSource) ||
  !/<script type="module" src="sidepanel\.js"><\/script>/.test(sidepanelHtmlSource) ||
  !/setting-deep-link/.test(sidepanelSource)
) {
  throw new Error("browser settings discovery must remain catalog-grounded, redacted, searchable, and permission-deep-linked");
}

// No hardcoded version pin here: the release workflow already refuses
// packaged-source changes without a manifest bump, and a duplicate exact-value
// check only adds a second trip-wire that must be hand-moved every release.
// Pick the next version with scripts/release/next-extension-version.sh.

const mainContentScript = manifest.content_scripts?.find((entry) => entry.js?.includes("content.js"));
if (
  !mainContentScript ||
  mainContentScript.js.indexOf("page-observation-runtime.js") < 0 ||
  mainContentScript.js.indexOf("page-observation-runtime.js") > mainContentScript.js.indexOf("content.js") ||
  mainContentScript.js.indexOf("content-voice-policy-runtime.js") < 0 ||
  mainContentScript.js.indexOf("content-voice-policy-runtime.js") > mainContentScript.js.indexOf("content.js") ||
  mainContentScript.js.indexOf("content-companion-policy-runtime.js") < 0 ||
  mainContentScript.js.indexOf("content-companion-policy-runtime.js") > mainContentScript.js.indexOf("content.js") ||
  mainContentScript.js.indexOf("content-extension-api-runtime.js") < 0 ||
  mainContentScript.js.indexOf("content-extension-api-runtime.js") > mainContentScript.js.indexOf("content.js") ||
  mainContentScript.js.indexOf("content-context-control-runtime.js") < 0 ||
  mainContentScript.js.indexOf("content-context-control-runtime.js") > mainContentScript.js.indexOf("content.js") ||
  mainContentScript.js.indexOf("content-note-controller-runtime.js") < 0 ||
  mainContentScript.js.indexOf("content-note-controller-runtime.js") > mainContentScript.js.indexOf("content.js") ||
  mainContentScript.js.indexOf("content-ui-controller-runtime.js") < 0 ||
  mainContentScript.js.indexOf("content-ui-controller-runtime.js") > mainContentScript.js.indexOf("content.js") ||
  mainContentScript.js.indexOf("voice-capture-gesture.js") < 0 ||
  mainContentScript.js.indexOf("voice-capture-gesture.js") > mainContentScript.js.indexOf("content.js") ||
  !/files: \["ui-spec-runtime\.js", "page-observation-runtime\.js", "content-voice-policy-runtime\.js", "content-companion-policy-runtime\.js", "content-extension-api-runtime\.js", "content-context-control-runtime\.js", "content-note-controller-runtime\.js", "content-ui-controller-runtime\.js", "voice-capture-gesture\.js", "content\.js"\]/.test(backgroundSource)
) {
  throw new Error("content support runtimes must load before content.js in declared and dynamic injection paths");
}
if (
  !/AgeeContentCompanionPolicyRuntime/.test(contentCompanionPolicySource) ||
  !/function sanitizeActiveCompanionPet/.test(contentCompanionPolicySource) ||
  !/function formatLanguageChipText/.test(contentCompanionPolicySource) ||
  !/function sanitizeAvatarBehaviorRuntime/.test(contentCompanionPolicySource) ||
  /function (?:compactText|safePetImageSource|shortLangTag|parseLanguageCodes)\(/.test(contentSource) ||
  !/companionPolicy\.sanitizeActiveCompanionPet\(payload, chrome\.runtime\.id\)/.test(contentSource) ||
  !/companionPolicy\.formatLanguageChipText\(profile, replyOverride\)/.test(contentSource) ||
  !/companionPolicy\.sanitizeAvatarBehaviorRuntime\(runtime\)/.test(contentSource)
) {
  throw new Error("companion, language, and avatar input policy must stay extracted and delegated from content.js");
}
if (
  !/function createContentExtensionApiRuntime/.test(contentExtensionApiSource) ||
  !/function markExtensionContextInvalidated/.test(contentExtensionApiSource) ||
  !/function isExtensionContextInvalidated/.test(contentExtensionApiSource) ||
  !/function safeRuntimeSendMessage/.test(contentExtensionApiSource) ||
  !/function safeStorageLocalGet/.test(contentExtensionApiSource) ||
  !/function safeStorageLocalSet/.test(contentExtensionApiSource) ||
  /function (?:markExtensionContextInvalidated|isExtensionContextInvalidated|canCallExtensionApi|safeRuntimeSendMessage|safeStorageLocalGet|safeStorageLocalSet|base64ToBuffer)\(/.test(contentSource) ||
  /\bextensionContextInvalidated\b/.test(contentSource) ||
  !/AgeeContentExtensionApiRuntime\.createContentExtensionApiRuntime\(\{[\s\S]{0,240}getChrome:[\s\S]{0,160}decodeBase64:[\s\S]{0,120}ByteArray: Uint8Array/.test(contentSource)
) {
  throw new Error("content extension API calls must stay behind the extracted stale-context safety runtime");
}
if (
  !/function createContentContextControlRuntime/.test(contentContextControlSource) ||
  !/function maybeHandleContextSlashCommand/.test(contentContextControlSource) ||
  !/function consumeContextControls/.test(contentContextControlSource) ||
  /function (?:maybeHandleContextSlashCommand|consumeContextControls)\(/.test(contentSource) ||
  !/AgeeContentContextControlRuntime\.createContentContextControlRuntime\(\{[\s\S]{0,120}onModeCue: showContextModeCue/.test(contentSource)
) {
  throw new Error("content thread and incognito controls must stay behind the extracted context-control runtime");
}
if (
  !/function createContentNoteControllerRuntime/.test(contentNoteControllerSource) ||
  !/function toggleRecordMode/.test(contentNoteControllerSource) ||
  !/function toggleVideoNoteMode/.test(contentNoteControllerSource) ||
  !/recordSessionStart/.test(contentNoteControllerSource) ||
  !/videoSessionStop/.test(contentNoteControllerSource) ||
  /function (?:toggleRecordMode|startRecordMode|stopRecordMode|toggleVideoNoteMode|startVideoNoteMode|stopVideoNoteMode)\(/.test(contentSource) ||
  !/AgeeContentNoteControllerRuntime\.createContentNoteControllerRuntime\(\{[\s\S]{0,800}now: \(\) => Date\.now\(\)/.test(contentSource)
) {
  throw new Error("audio and video note capture orchestration must stay behind the extracted content controller");
}
if (
  !/function createContentUiControllerRuntime/.test(contentUiControllerSource) ||
  !/function renderUiSpecSurface/.test(contentUiControllerSource) ||
  !/function runUiAction/.test(contentUiControllerSource) ||
  /function (?:loadUiSpec|applyUiSpec|renderUiSpecSurface|renderUiComponent|renderUiMap|renderUiControl|runUiAction)\(/.test(contentSource) ||
  !/AgeeContentUiControllerRuntime\.createContentUiControllerRuntime\(\{[\s\S]{0,800}anchorPanel: positionPanel[\s\S]{0,500}cacheKey: UI_SPEC_CACHE_KEY/.test(contentSource)
) {
  throw new Error("declarative UI presentation and action dispatch must stay behind the extracted content controller");
}
if (
  packageJson.scripts?.["test:unit"] !== "node --test scripts/test-*.mjs" ||
  packageJson.scripts?.["test:coverage"] !== "node scripts/coverage-extension.mjs" ||
  packageJson.scripts?.verify !== "npm run test:unit && node scripts/verify-extension.mjs"
) {
  throw new Error("verification must run every focused unit script and expose the production coverage ratchet");
}
if (
  !/AGEE_EXTENSION_PATH/.test(extensionSmokeSource) ||
  !/AGEE_COVERAGE_OUTPUT/.test(extensionSmokeSource) ||
  !/Chromium coverage smoke failed/.test(coverageSource) ||
  !/coverageGlobalScope: "globalThis"/.test(coverageSource) ||
  !/coverageGlobalScopeFunc: false/.test(coverageSource) ||
  !/browserCoverageMap\.addFileCoverage/.test(coverageSource)
) {
  throw new Error("production coverage must merge real Chromium content-script and service-worker execution");
}

if (
  /function (?:clampAgentLoopMaxSteps|agentLoopScreenshotObservation|validateAgentLoopAction)\(/.test(backgroundSource) ||
  !/validateAgentLoopAction\(response\?\.action, allowedBrowserTaskUrl\)/.test(backgroundSource) ||
  !/function buildAgentLoopObservationPayload\(/.test(browserAgentLoopPolicySource) ||
  !/function validateAgentLoopAction\(/.test(browserAgentLoopPolicySource) ||
  !/AGENT_LOOP_MAX_TYPE_TEXT = 2000/.test(browserAgentLoopPolicySource)
) {
  throw new Error("browser agent-loop observation and action policy must stay extracted, bounded, and URL-policy injected");
}

if (
  /seedGatewayConfig\s*\(/.test(backgroundSource) ||
  !/BACKGROUND_AUTOMATION_CONSENT_VERSION = 1/.test(backgroundSource) ||
  !/return false;\s*\n\s*}\s*\n}\s*\n\s*async function pollBrowserTasks/.test(backgroundSource) ||
  !/if \(!\(await isBackgroundAutomationEnabled\(\)\)\) return;[\s\S]{0,180}\/v1\/tool\/requests\/claim/.test(backgroundSource)
) {
  throw new Error("background privacy migration or automation gate is missing");
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

if (!/DEFAULT_GATEWAY_URL\s*=\s*"https:\/\/api\.agee\.app"/.test(configSource)) {
  throw new Error("extension config must default hosted onboarding to https://api.agee.app");
}

if (
  !configSource.includes('"http://10.147.17.10:8787"') ||
  !configSource.includes('"http://10.147.17.6:8787"') ||
  !/function isKnownStaleGatewayUrl/.test(configSource) ||
  !/!userOwnsUrl && isKnownStaleGatewayUrl/.test(configSource)
) {
  throw new Error("extension config must migrate known stale ZeroTier/local URLs unless the user owns the saved URL");
}

if (
  !/function gatewayUrlDiagnostic/.test(configSource) ||
  !/Enter the full gateway URL/.test(configSource) ||
  !/Save only the gateway origin/.test(configSource) ||
  !/old main-machine ZeroTier gateway/.test(configSource) ||
  !/local Mac gateway/.test(configSource)
) {
  throw new Error("extension config must classify missing schemes, endpoint paths, and stale/local gateway URLs");
}

if (
  !/function formatGatewayNetworkError/.test(backgroundSource) ||
  !/Could not reach the configured gateway/.test(backgroundSource) ||
  !/Check DNS, TLS, and the saved gateway URL/.test(backgroundSource) ||
  !/cfg\.gatewayUrl/.test(backgroundSource)
) {
  throw new Error("background.js must turn fetch failures into configured-gateway diagnostics");
}

if (
  !/function formatVoiceSocketNetworkError/.test(backgroundSource) ||
  !/Voice socket could not connect for configured gateway/.test(backgroundSource) ||
  !/Check Cloudflare WebSocket proxying, TLS, and the gateway voice route/.test(backgroundSource) ||
  /WebSocket: \$\{ticket\.ws_url\}/.test(backgroundSource)
) {
  throw new Error("background.js must make pre-open voice socket failures actionable without printing ticket URLs");
}

if (
  !/gatewayUrlDiagnostic/.test(optionsSource) ||
  !/Could not reach the configured gateway/.test(optionsSource) ||
  !/token may belong to a different gateway/.test(optionsSource)
) {
  throw new Error("options.js must preflight gateway URLs and show clear network/token diagnostics");
}

if (/new\s+WebSocket\s*\(/.test(contentSource)) {
  throw new Error("content scripts must not open gateway WebSockets; background.js owns voice transport to avoid HTTPS mixed-content blocking");
}

if (/mediaDevices\.getUserMedia/.test(contentSource)) {
  throw new Error("content scripts must not request microphone permission; offscreen.js owns extension-origin mic capture");
}

if (!/chrome\.offscreen\.createDocument/.test(backgroundSource) || !/reasons:\s*\[\s*"USER_MEDIA"[\s,\]"A-Z_]*\]/.test(backgroundSource)) {
  throw new Error("background.js must create an offscreen USER_MEDIA document for extension-owned microphone capture");
}

if (!/cmd:\s*"offscreenVoiceCaptureStart"/.test(backgroundSource) || !/cmd === "offscreenVoiceAudio"/.test(backgroundSource)) {
  throw new Error("background.js must start offscreen voice capture and receive PCM chunks from it");
}

if (!/navigator\.mediaDevices\.getUserMedia/.test(offscreenSource) || !/offscreenVoiceAudio/.test(offscreenSource)) {
  throw new Error("offscreen.js must own microphone capture and forward PCM chunks to background.js");
}

if (!/<script\s+type="module"\s+src="offscreen\.js"><\/script>/.test(offscreenHtmlSource)) {
  throw new Error("offscreen.html must load module-syntax offscreen.js as an ES module");
}

if (
  !/offscreenVoiceReady/.test(offscreenSource) ||
  !/waitForOffscreenReceiver/.test(offscreenVoiceBridgeSource) ||
  !/sendToOffscreenReceiver/.test(backgroundSource) ||
  /handleOffscreenVoiceError[\s\S]{0,500}chrome\.runtime\.openOptionsPage/.test(backgroundSource)
) {
  throw new Error("offscreen voice startup must wait for a receiver and must not auto-open Options on failure");
}

if (
  !/audioWorklet\.addModule/.test(offscreenSource) ||
  !/new\s+AudioWorkletNode/.test(offscreenSource) ||
  !/offscreen-audio-worklet\.js/.test(offscreenSource) ||
  /createScriptProcessor|ScriptProcessorNode/.test(offscreenSource) ||
  !/registerProcessor\("aggie-voice-capture"/.test(offscreenWorkletSource) ||
  !/postMessage\(\{\s*samples\s*\}/.test(offscreenWorkletSource)
) {
  throw new Error("offscreen microphone capture must use AudioWorklet, not deprecated ScriptProcessorNode capture");
}

if (
  !/function voiceSessionSocketOpen/.test(backgroundSource) ||
  !/function sendVoiceSessionJson/.test(backgroundSource) ||
  !/function sendVoiceSessionBinary/.test(backgroundSource)
) {
  throw new Error("background.js must guard voice WebSocket sends behind OPEN/current-session checks");
}

const voiceTransportBody = sourceBetween(
  backgroundSource,
  /async function startVoiceSessionProxy\(/,
  /function deliverVoiceSessionEvent\(/,
  "voice session transport"
);
const safeJsonSendBody = sourceBetween(
  backgroundSource,
  /function sendVoiceSessionJson\(/,
  /function sendVoiceSessionBinary\(/,
  "safe JSON voice send"
);
const safeBinarySendBody = sourceBetween(
  backgroundSource,
  /function sendVoiceSessionBinary\(/,
  /function deliverVoiceSessionEvent\(/,
  "safe binary voice send"
);
const unsafeVoiceTransportBody = voiceTransportBody
  .replace(safeJsonSendBody, "")
  .replace(safeBinarySendBody, "");
if (/session\.ws\.send/.test(unsafeVoiceTransportBody)) {
  throw new Error("voice WebSocket sends must go through safe send helpers");
}

const voiceProxySetupBody = sourceBetween(
  backgroundSource,
  /async function startVoiceSessionProxyLocked\(/,
  /return new Promise\(/,
  "voice proxy setup"
);
const voiceStartBody = sourceBetween(
  backgroundSource,
  /async function startVoiceSessionProxy\(/,
  /\/\/ Set the active thread/,
  "voice proxy mutex wrapper"
);
if (voiceProxySetupBody.indexOf("startOffscreenVoiceCapture(id)") < 0) {
  throw new Error("browser voice must start offscreen microphone capture during voice proxy setup");
}
if (voiceProxySetupBody.indexOf("createVoiceSessionTicket(cfg)") < voiceProxySetupBody.indexOf("startOffscreenVoiceCapture(id)")) {
  throw new Error("browser voice must start offscreen capture before creating the gateway voice ticket");
}

if (
  !/MAX_QUEUED_VOICE_AUDIO_BYTES/.test(backgroundSource) ||
  !/function queueVoiceSessionAudio/.test(backgroundSource) ||
  !/function flushQueuedVoiceSessionAudio/.test(backgroundSource) ||
  !/function sendOrQueueVoiceSessionCommit/.test(backgroundSource) ||
  !/pendingCommitMessage/.test(backgroundSource)
) {
  throw new Error("background.js must queue mic audio and commit control before voice session_ready");
}

if (
  !/voiceSessions\.set\(id, session\);[\s\S]{0,320}startOffscreenVoiceCapture\(id\)/.test(backgroundSource) ||
  !/parsed\?\.type === "session_ready"[\s\S]{0,520}flushQueuedVoiceSessionMedia\(session\)/.test(backgroundSource) ||
  !/message\?\.type === "commit_turn"[\s\S]{0,220}sendOrQueueVoiceSessionCommit/.test(backgroundSource)
) {
  throw new Error("extension-owned voice capture must start immediately, flush queued audio on session_ready, and send commit after the flush");
}

if (
  !/const AGGIE_ROOT_ID\s*=\s*"agee-root"/.test(contentSource) ||
  !/window\.top !== window/.test(contentSource) ||
  !/function pruneDuplicateAggies|const pruneDuplicateAggies/.test(contentSource) ||
  !/querySelector\("#agee-launcher"\)/.test(contentSource) ||
  !/node !== keep/.test(contentSource) ||
  !/existingAggies\(\)\.forEach/.test(contentSource)
) {
  throw new Error("content.js must keep one Aggie root per top-level page after reinjection");
}

if (!/Grant microphone/.test(optionsHtmlSource) || !/navigator\.mediaDevices\.getUserMedia/.test(optionsSource)) {
  throw new Error("options page must expose a one-time extension microphone grant path");
}

if (
  !/id="companionList"/.test(optionsHtmlSource) ||
  !/id="companionPrompt"/.test(optionsHtmlSource) ||
  !/\/v1\/agent\/companions/.test(optionsSource) ||
  !/\/v1\/agent\/companions\/preview/.test(optionsSource) ||
  !/\/v1\/agent\/companions\/apply/.test(optionsSource)
) {
  throw new Error("options page must expose companion catalog create/preview/apply controls backed by gateway endpoints");
}

if (
  !/microphone_capture_failed/.test(backgroundSource) ||
  !/recoverable:\s*false/.test(backgroundSource) ||
  !/chrome:\/\/extensions\/\?id=\$\{chrome\.runtime\.id\}/.test(backgroundSource) ||
  !/microphone_permission_denied/.test(backgroundSource) ||
  !/chrome\.runtime\.openOptionsPage/.test(backgroundSource) ||
  !/msg\.recoverable === false \|\| msg\.code === "microphone_capture_failed"/.test(contentSource)
) {
  throw new Error("extension offscreen microphone failures must be explicit, non-recoverable, and keep an explicit Options permission path");
}
const offscreenVoiceErrorBody = sourceBetween(
  backgroundSource,
  /function handleOffscreenVoiceError\(/,
  /function claimActiveAgentTab\(/,
  "offscreen voice error handler"
);
if (/openOptionsPage/.test(offscreenVoiceErrorBody)) {
  throw new Error("microphone failure must stay in the current surface instead of opening Options");
}

const micFailureHandler = backgroundSource.match(/function handleOffscreenVoiceError[\s\S]*?\n}/)?.[0] || "";
if (
  /openOptionsPage/.test(micFailureHandler) ||
  !/code === "microphone_permission_denied"/.test(micFailureHandler) ||
  !/Take me to microphone setup/.test(backgroundSource) ||
  !/target:\s*MICROPHONE_RECOVERY_TARGET/.test(backgroundSource) ||
  !/micRecoveryBanner/.test(optionsHtmlSource) ||
  !/normalizeOptionsRecovery/.test(optionsSource) ||
  !/MICROPHONE_RECOVERY_TARGET/.test(optionsRecoverySource)
) {
  throw new Error("microphone recovery must render first and open guided Options only after an explicit user action");
}

if (!/cmd === "voiceSessionStart"/.test(backgroundSource)) {
  throw new Error("background.js must expose the voiceSessionStart proxy command");
}

if (
  !/command !== "toggle-agee" && command !== "toggle-agee-voice"/.test(backgroundSource) ||
  !/const cmd = command === "toggle-agee-voice" \? "toggleVoice" : "open"/.test(backgroundSource) ||
  !/source:\s*"command"/.test(backgroundSource) ||
  !/case "toggleVoice":/.test(contentSource) ||
  !/function ensureContentOnOpenTabs/.test(backgroundSource) ||
  !/chrome\.runtime\.onStartup\.addListener/.test(backgroundSource)
) {
  throw new Error("Cmd/Ctrl+Period must be wired through command handling and startup/update content injection");
}

if (
  !/function summonOverlay\(/.test(backgroundSource) ||
  !/if \(!isInjectableOverlayUrl\(tab\.url\)\)/.test(backgroundSource) ||
  !/summonOverlay\(tab, cmd\)/.test(backgroundSource) ||
  !/summonOverlay\(tab, "open"\)/.test(backgroundSource)
) {
  throw new Error("per-tab shortcuts must fall back to summonOverlay on restricted pages (chrome://, Web Store, PDF viewer) instead of failing silently");
}

// The side panel is the extension-owned agent surface: it renders on every
// page, including chrome:// pages where content scripts are forbidden.
if (manifest.side_panel?.default_path !== "sidepanel.html") {
  throw new Error("manifest must declare side_panel.default_path = sidepanel.html");
}
if (!manifest.commands?.["open-agee-panel"]) {
  throw new Error("manifest must declare the open-agee-panel command");
}
if (
  !/const PANEL_TAB_ID = -2/.test(backgroundSource) ||
  !/port\.name !== "agee-panel"/.test(backgroundSource) ||
  !/function openAgentPanel\(/.test(backgroundSource) ||
  !/chrome\.sidePanel\.open\(target\)/.test(backgroundSource) ||
  !/tabId === PANEL_TAB_ID/.test(backgroundSource)
) {
  throw new Error("background.js must bridge the side panel: PANEL_TAB_ID routing in send(), the agee-panel port, and a synchronous sidePanel.open from the action click and open-agee-panel command");
}
const browserAgentRoleRuntimeSource = readFileSync("extension/browser-agent-role-runtime.js", "utf8");
if (
  !/chrome\.runtime\.connect\(\{ name: "agee-panel" \}\)/.test(sidepanelSource) ||
  !/"extension-offscreen"/.test(sidepanelSource) ||
  !/cmd: "browserRoleTurn"/.test(sidepanelSource) ||
  !/data-agent-mode-option/.test(sidepanelSource) ||
  !/commit_turn/.test(sidepanelSource) ||
  !/documentPictureInPicture/.test(sidepanelSource)
) {
  throw new Error("sidepanel.js must connect the agee-panel port, use offscreen voice capture for commit_turn, route typed turns through browserRoleTurn, expose role selection, and offer the document PiP float");
}

if (
  !/id="agee-mode-select"/.test(contentSource) ||
  !/agentRole: role/.test(contentSource) ||
  !/delegationConfirmed/.test(contentSource) ||
  !/agentRole: msg\.agentRole/.test(backgroundSource) ||
  !/role: explicitRole/.test(backgroundSource) ||
  !/msg\.cmd === "browserRoleTurn"/.test(backgroundSource) ||
  !/delegation_envelope: delegationEnvelope/.test(backgroundSource) ||
  !/moa\.browser-delegation\.v1/.test(browserAgentRoleRuntimeSource)
) {
  throw new Error("browser agent role controls must route explicit overlay and side-panel text turns through the typed role and confirmed delegation-envelope contract");
}

if (
  !/function visiblePageText/.test(pageObservationRuntimeSource) ||
  !/pageText:\s*visiblePageText\(\)/.test(pageObservationRuntimeSource) ||
  !/AgeePageObservationRuntime\.createPageObservationRuntime/.test(contentSource)
) {
  throw new Error("content snapshot must include visible page text, not only actionable elements");
}

if (!/e\.code === "Comma"/.test(contentSource) || /toLowerCase\(\) === "k"/.test(contentSource)) {
  throw new Error("text command hotkey must be Cmd/Ctrl+Comma, not Cmd/Ctrl+K");
}

const textHotkeyBody = sourceBetween(
  contentSource,
  /if \(isTextHotkey\(e\)\)/,
  /\/\/ ---- Perception/,
  "text hotkey handler"
);
if (!/openTextSurface\(\{\s*fresh:\s*false\s*\}\)/.test(textHotkeyBody) || /toggleVoice|toggleTextSurface\(\)/.test(textHotkeyBody)) {
  throw new Error("Cmd/Ctrl+Comma must match launcher single-click: open text only, preserving drafts and never starting voice");
}

if (
  !/function beginVoiceHotkey\(/.test(contentSource) ||
  !/function beginVoiceCommandHotkey\(/.test(contentSource) ||
  !/function finishVoiceHotkey\(/.test(contentSource) ||
  !/window\.addEventListener\(\s*"keyup"[\s\S]{0,260}finishVoiceHotkey\(\)/.test(contentSource) ||
  !/if \(e\.repeat \|\| voiceHotkeyState\) return;/.test(contentSource) ||
  !/case "toggleVoice":[\s\S]{0,220}beginVoiceCommandHotkey\(\)/.test(contentSource) ||
  !/function beginManualVoiceGesture\(/.test(contentSource) ||
  !/function finishManualPushToTalk\(/.test(contentSource) ||
  !/autoCommit:\s*false/.test(contentSource)
) {
  throw new Error("Cmd/Ctrl+Period must support repeat-safe tap toggle and held push-to-talk through the manual voice gesture path");
}

if (/case "done":[\s\S]{0,180}setInputText\(msg\.summary/.test(contentSource)) {
  throw new Error("done replies must render in the result surface, not inside the command input");
}

if (!/VOICE_AUTO_COMMIT_SILENCE_MS/.test(backgroundSource) || !/autoCommitVoiceSession/.test(backgroundSource)) {
  throw new Error("browser voice must auto-commit microphone turns after speech silence");
}

if (
  !/MAX_QUEUED_VOICE_AUDIO_BYTES/.test(backgroundSource) ||
  !/queuedAudio:\s*\[\]/.test(backgroundSource) ||
  !/function queueVoiceSessionAudio/.test(backgroundSource) ||
  !/function flushQueuedVoiceSessionAudio/.test(backgroundSource) ||
  !/function sendOrQueueVoiceSessionCommit/.test(backgroundSource) ||
  !/!voiceSessionSocketOpen\(session\) \|\| !session\.gatewayReady/.test(backgroundSource) ||
  !/parsed\?\.type === "session_ready"[\s\S]{0,180}session\.gatewayReady = true;[\s\S]{0,180}flushQueuedVoiceSessionMedia\(session\)/.test(backgroundSource)
) {
  throw new Error("browser voice must buffer early offscreen PCM and flush it after session_ready before commit");
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

if (
  !/function normalizeAssistantAudioSegment\(/.test(contentSource) ||
  !/msg\.type === "assistant_audio_segment"/.test(contentSource) ||
  !/pendingAssistantAudioSegments/.test(contentSource) ||
  !/function computePlaybackProgress\(/.test(contentSource) ||
  !/type:\s*"playback_progress"/.test(contentVoicePolicySource) ||
  !/AgeeContentVoicePolicyRuntime/.test(contentSource)
) {
  throw new Error("content.js must correlate assistant_audio_segment metadata with the following PCM frame and derive playback_progress from local playback");
}

if (
  !/function routeLiveTranscriptThroughGateway\([\s\S]{0,800}sendFinalPlaybackProgress\(state\);[\s\S]{0,800}closeLiveVoiceSession\(state/.test(contentSource) ||
  !/function stopLiveVoiceState\([\s\S]{0,500}sendFinalPlaybackProgress\(state\);[\s\S]{0,500}liveCancelTurnMessage\(state/.test(contentSource) ||
  !/function applySpeechOverlapPolicyFromTranscript\([\s\S]{0,500}sendFinalPlaybackProgress\(state\);[\s\S]{0,500}liveCancelTurnMessage\(state/.test(contentSource)
) {
  throw new Error("content.js must send final playback_progress before cancel or close paths tear the live voice session down");
}

if (
  !/ACTIVE_BROWSER_AGENT_OWNER_KEY\s*=\s*"ageeActiveBrowserAgentOwner"/.test(backgroundSource) ||
  !/function setActiveBrowserAgentOwner/.test(backgroundSource) ||
  !/function notifyBrowserAgentOwner/.test(backgroundSource) ||
  !/cmd:\s*"browserAgentOwnerChanged"/.test(backgroundSource) ||
  !/case "browserAgentOwnerChanged":/.test(contentSource) ||
  !/root\.dataset\.ageeOwner/.test(contentSource)
) {
  throw new Error("browser agent ownership must be shared across tabs through storage and owner-change messages");
}

if (!/const owner = await getActiveBrowserAgentOwner\(\);[\s\S]{0,420}chrome\.tabs\.get\(ownerTabId\)/.test(backgroundSource)) {
  throw new Error("gateway-queued browser tasks must prefer the active owner tab before falling back to the foreground tab");
}

if (
  !/\/v1\/device-clients\/heartbeat/.test(backgroundSource) ||
  !/function browserLocalToolManifest/.test(backgroundSource) ||
  !/browser\.tab\.open/.test(backgroundSource) ||
  !/browser\.tab\.list/.test(backgroundSource) ||
  !/browser\.tab\.close/.test(backgroundSource) ||
  !/browser\.tab\.activate/.test(backgroundSource) ||
  !/browser\.tab\.reload/.test(backgroundSource) ||
  !/browser\.cdp\.execute/.test(backgroundSource) ||
  !/function executeCdpActionsOnTab/.test(backgroundSource) ||
  !/\/v1\/tool\/requests\/claim/.test(backgroundSource) ||
  !/function maybeRequestAndroidSpeak/.test(backgroundSource) ||
  !/tool:\s*"audio\.speak"/.test(backgroundSource)
) {
  throw new Error("extension must heartbeat as a browser device client and expose browser tab/CDP tool requests");
}

if (
  !/function currentBrowserSessionAdvertisement/.test(backgroundSource) ||
  !/context_descriptor:\s*sessionAdvertisement\.context_descriptor/.test(backgroundSource) ||
  !/execution_adapters:\s*sessionAdvertisement\.execution_adapters/.test(backgroundSource) ||
  !packageJson.scripts?.["test:browser-context"]
) {
  throw new Error("device heartbeat must advertise bounded current-page context and browser-session execution adapters");
}

if (
  !/function runBrowserAgentTurn/.test(backgroundSource) ||
  !/\/v1\/browser\/evidence/.test(backgroundSource) ||
  !/\/v1\/browser\/turns/.test(backgroundSource) ||
  !/browserTurnStatusPath/.test(backgroundSource) ||
  !/\/v1\/browser\/turns\/\$\{encodeURIComponent\(id\)\}\/status/.test(browserTurnProtocolSource)
) {
  throw new Error("background.js must expose one runBrowserAgentTurn orchestrator using browser evidence, turn, and status routes");
}

const browserAgentTurnBody = sourceBetween(
  backgroundSource,
  /async function runBrowserAgentTurn\(/,
  /async function waitForBrowserTurnAnswer\(/,
  "runBrowserAgentTurn"
);
if (/executeAction\(|cmd:\s*"act"|Input\.dispatch|Page\.navigate/.test(browserAgentTurnBody)) {
  throw new Error("runBrowserAgentTurn must not execute browser actions, hidden clicks, draws, or navigation in this slice");
}

if (!/Gateway proposed \$\{actions\.length\} browser action/.test(browserTurnProtocolSource) || !/not executed in this slice/.test(browserTurnProtocolSource)) {
  throw new Error("browser-agent action proposals must render as inert proposal status, not execute");
}

if (/function describePageViaGateway/.test(backgroundSource) || /callGateway\(cfg,\s*"\/v1\/chat"/.test(backgroundSource)) {
  throw new Error("describe page must use runBrowserAgentTurn and /v1/browser/turns, not the old /v1/chat path");
}

if (
  !/looksLikePageContextQuestion/.test(backgroundSource) ||
  !/looksLikePageContextQuestion\(instruction\)[\s\S]{0,140}runBrowserAgentTurn/.test(backgroundSource) ||
  !/function isPageContextTranscript/.test(contentVoicePolicySource) ||
  !/isProfileControlTranscript\(text\) \|\| isPageContextTranscript\(text\)/.test(contentVoicePolicySource)
) {
  throw new Error("typed and final spoken page/current-page questions must route to the shared browser-agent orchestrator");
}

if (
  !/BROWSER_AGENT_PROGRESS_TEXT/.test(backgroundSource) ||
  !/collecting page context/.test(backgroundSource) ||
  !/capturing screenshot/.test(backgroundSource) ||
  !/sending to gateway/.test(backgroundSource) ||
  !/waiting for answer/.test(backgroundSource) ||
  !/case "browserAgentProgress":/.test(contentSource)
) {
  throw new Error("browser-agent turns must render named progress states through the existing result surface");
}

if (
  !/MAX_BROWSER_EVIDENCE_SCREENSHOT_BASE64_CHARS/.test(backgroundSource) ||
  !/function browserScreenshotEvidence/.test(backgroundSource) ||
  !/encoding:\s*"omitted"/.test(backgroundSource) ||
  !/screenshot:\s*screenshotEvidence/.test(backgroundSource)
) {
  throw new Error("browser-agent screenshot evidence must be capped or omitted before posting to the gateway");
}

if (
  !/snapshotId/.test(pageObservationRuntimeSource) ||
  !/viewport:\s*\{/.test(pageObservationRuntimeSource) ||
  !/capturedAt,/.test(pageObservationRuntimeSource) ||
  !/elementSummaries:\s*elements\.map/.test(pageObservationRuntimeSource) ||
  !/pageObservation\.snapshot\(\)/.test(contentSource)
) {
  throw new Error("content snapshot must include snapshotId, viewport, capturedAt, and element summaries without removing the existing shape");
}

if (!packageJson.scripts?.["smoke:unified-browser-agent"]) {
  throw new Error("package.json must expose smoke:unified-browser-agent");
}

if (/Listening\.\.\.|listening\.\.\.|stopping…|stopping\.\.\./.test(contentSource)) {
  throw new Error("content.js must not render voice lifecycle filler text such as Listening/listening/stopping");
}

if (!/function ensureVoiceCueCard/.test(contentSource)) {
  throw new Error("browser voice must promote live transcript/assistant text into the result surface above the input");
}

// ---- Record mode: raw audio notes ----------------------------------------
// Record mode is an audio_note capture, not a voice turn. The background must
// buffer offscreen PCM under a record-scoped id and post the raw bytes to
// /v1/audio-notes; the record path must never open /v1/voice/sessions and must
// never send a session_start event.
if (
  !/cmd === "recordSessionStart"/.test(backgroundSource) ||
  !/cmd === "recordSessionStop"/.test(backgroundSource) ||
  !/RECORD_MAX_AUDIO_BYTES/.test(backgroundSource) ||
  !/function appendRecordSessionAudio/.test(backgroundSource) ||
  !/isRecordSessionId\(msg\.voiceSessionId\)/.test(backgroundSource) ||
  !/\/v1\/audio-notes/.test(backgroundSource)
) {
  throw new Error("background.js must expose recordSessionStart/Stop handlers that buffer capped PCM and post to /v1/audio-notes");
}
const recordModeBody = sourceBetween(
  backgroundSource,
  /\/\/ ---- Record mode: raw audio notes/,
  /\/\/ ---- End record mode/,
  "background record mode block"
);
if (/\/v1\/voice\/sessions|session_start|startVoiceSessionProxy|createVoiceSessionTicket|new\s+WebSocket/.test(recordModeBody)) {
  throw new Error("record mode must not open voice sessions, voice sockets, or send session_start");
}
if (
  !/audio\/L16; rate=16000; channels=1/.test(recordModeBody) ||
  !/x-moa-surface/.test(recordModeBody) ||
  !/x-moa-session-id/.test(recordModeBody) ||
  !/x-moa-duration-ms/.test(recordModeBody) ||
  !/getStableSessionId\(\)/.test(recordModeBody)
) {
  throw new Error("audio-note upload must carry L16 content type plus surface/session/duration metadata headers");
}
if (
  !/voiceSessions\.size > 0/.test(recordModeBody) ||
  !/if \(activeRecordSession\(\)\) \{[\s\S]{0,320}Stop recording before starting voice/.test(backgroundSource)
) {
  throw new Error("record and voice sessions must be mutually exclusive: record start refuses while voice is live, and voice start refuses while recording");
}
// Capture mutex: the async voice-start window must be closed on both sides.
// voiceStartPending is held across the awaits, record start refuses while it is
// set, and the voice start re-checks record state after its awaits before
// attaching a gateway socket. Voice-owned offscreen prebuffering may already be
// running in this window; record mode is blocked from racing that single capture
// slot.
if (
  !/let voiceStartPending = 0;/.test(backgroundSource) ||
  !/voiceStartPending \+= 1;/.test(backgroundSource) ||
  !/voiceStartPending = Math\.max\(0, voiceStartPending - 1\);/.test(backgroundSource) ||
  voiceStartBody.indexOf("if (activeRecordSession())") < 0 ||
  voiceStartBody.indexOf("voiceStartPending += 1") < 0 ||
  voiceStartBody.indexOf("if (activeRecordSession())") > voiceStartBody.indexOf("voiceStartPending += 1") ||
  !/voiceStartPending > 0 \|\| voiceSessions\.size > 0/.test(recordModeBody) ||
  !/createVoiceSessionTicket\(cfg\);[\s\S]{0,900}if \(activeRecordSession\(\)\)/.test(backgroundSource)
) {
  throw new Error("voice-start capture mutex missing: record start must refuse during a pending voice start and the voice start must re-check record state after its awaits");
}
// The ~5 minute record cap must be exact: append only the room left in the
// buffer, never a whole overshooting chunk.
if (
  !/RECORD_MAX_AUDIO_BYTES - session\.totalBytes/.test(recordModeBody) ||
  !/subarray\(0, room\)/.test(recordModeBody)
) {
  throw new Error("record cap must be exact: append only the remaining room before stopping capture");
}
if (!/function toggleRecordMode\(\)[\s\S]{0,500}isVoiceActive\(\)/.test(contentNoteControllerSource)) {
  throw new Error("content record toggle must refuse while a voice turn is live or starting in this tab");
}
if (
  !/querySelector\("#agee-record"\)/.test(contentSource) ||
  !/cmd:\s*"recordSessionStart"/.test(contentNoteControllerSource) ||
  !/cmd:\s*"recordSessionStop"/.test(contentNoteControllerSource) ||
  !/agee-recording/.test(contentSource) ||
  !/note stored \(/.test(contentNoteControllerSource)
) {
  throw new Error("content note controller must back #agee-record with background handlers and a stored/failed receipt");
}
if (
  !/#agee-record\.recording/.test(overlayCssSource) ||
  !/#agee-root\.agee-recording #agee-launcher/.test(overlayCssSource)
) {
  throw new Error("overlay.css must carry distinct recording visuals for the record control and the mark");
}
if (/getUserMedia|new\s+WebSocket|fetch\(|\/v1\/voice\/sessions|session_start/.test(contentNoteControllerSource)) {
  throw new Error("content record mode must only send runtime messages; no mic, sockets, or gateway fetches in the page");
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

if (
  !/#agee-root\.agee-state-thinking #agee-launcher \.agee-bird/.test(overlayCssSource) ||
  !/#agee-root\.agee-state-speaking #agee-launcher \.agee-bird/.test(overlayCssSource) ||
  !/@keyframes agee-state-thinking-pulse/.test(overlayCssSource)
) {
  throw new Error("overlay.css must carry visible thinking (pulse) and speaking (steady tint) mark states for the already-toggled agee-state-* classes");
}

if (!/if \(isCurrentTurn\) setAgentState\("speaking"\);/.test(contentSource)) {
  throw new Error("content.js must flip the mark to speaking when assistant text starts rendering, not only on assistant_audio_start");
}

if (
  !/function armVoiceWatchdog/.test(contentSource) ||
  !/function resetVoiceWatchdog/.test(contentSource) ||
  !/function clearVoiceWatchdog/.test(contentSource) ||
  !/armVoiceWatchdog\(state\)/.test(contentSource) ||
  !/resetVoiceWatchdog\(state\)/.test(contentSource) ||
  !/clearVoiceWatchdog\(state\)/.test(contentSource) ||
  !/Voice turn timed out/.test(contentSource)
) {
  throw new Error("content.js must arm a post-commit voice response watchdog, reset it on every voice-session event, clear it on turn teardown, and surface a visible timeout");
}

if (!/msg\.type === "turn_progress"/.test(contentSource)) {
  throw new Error("content.js must tolerate and route the gateway turn_progress keepalive");
}

// ---- LiveKit voice prototype (flag-gated, OFF by default) -----------------
// The experimental LiveKit transport must stay OFF by default so verify/smoke
// exercise the WS path. Pin the default-OFF flag and the fallback-to-WS wiring.
const livekitVoiceSource = readFileSync("extension/livekit-voice.js", "utf8");
if (!/LIVEKIT_VOICE_FLAG_KEY\s*=\s*"ageeLivekitVoiceEnabled"/.test(livekitVoiceSource)) {
  throw new Error("livekit-voice.js must define the ageeLivekitVoiceEnabled flag key");
}
if (
  !/chrome\.storage\.local\.get\(\{\s*\[LIVEKIT_VOICE_FLAG_KEY\]:\s*false\s*\}\)/.test(livekitVoiceSource) ||
  !/\[LIVEKIT_VOICE_FLAG_KEY\]\s*===\s*true/.test(livekitVoiceSource)
) {
  throw new Error("livekit-voice.js must read the experimental flag defaulting to false");
}
if (
  !/isLivekitVoiceEnabled\(\)/.test(backgroundSource) ||
  !/startLivekitVoiceSession\(/.test(backgroundSource) ||
  !/if \(tabId !== PANEL_TAB_ID && await isLivekitVoiceEnabled\(\)\)/.test(backgroundSource) ||
  !/return startVoiceSessionProxy\(tabId, opts\);/.test(backgroundSource)
) {
  throw new Error("background.js must gate LiveKit voice behind the flag and fall back to the WS startVoiceSessionProxy path");
}
if (!/id="livekitVoice"\s+type="checkbox"/.test(optionsHtmlSource)) {
  throw new Error("options page must expose the LiveKit voice (experimental) checkbox");
}
if (
  !/chrome\.storage\.local\.get\(\{\s*\[LIVEKIT_VOICE_FLAG_KEY\]:\s*false\s*\}\)/.test(optionsSource)
) {
  throw new Error("options.js must default the LiveKit voice flag to OFF");
}
const offscreenLivekitSource = readFileSync("extension/offscreen-livekit.js", "utf8");
if (
  !/from "\.\/vendor\/livekit-client\.esm\.js"/.test(offscreenLivekitSource) ||
  !/preConnectBuffer:\s*true/.test(offscreenLivekitSource) ||
  !/lk\.agent\.state/.test(offscreenLivekitSource)
) {
  throw new Error("offscreen-livekit.js must use the vendored livekit-client, publish with the pre-connect buffer, and read lk.agent.state");
}

if (!/parsed\?\.type === "turn_progress"/.test(backgroundSource)) {
  throw new Error("background.js must route the turn_progress keepalive to the content script like other voice-session events");
}

if (!/function mergeLiveVoiceTranscript/.test(contentVoicePolicySource) || !/mergeLiveVoiceTranscript\(state\.transcript, incomingText\)/.test(contentSource)) {
  throw new Error("browser voice transcript fragments must be accumulated instead of replacing early speech");
}

if (!/function isIdentityProfileControl/.test(contentVoicePolicySource) || !/your name/.test(contentVoicePolicySource) || !/call\|name/.test(contentVoicePolicySource)) {
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

const voiceFirstTapBody = sourceBetween(
  contentSource,
  /function handleVoiceFirstTap\(/,
  /function armVoiceFirstChainReset\(/,
  "canonical mark tap chain"
);
if (
  !/resolveVoiceFirstTapChain/.test(voiceFirstTapBody) ||
  !/AgeeVoiceCaptureGesture\.resolveVoiceFirstTransition/.test(contentSource) ||
  !/function toggleVoiceFirstCapture\(/.test(contentSource) ||
  !/function toggleFreshThreadVoiceCapture\(/.test(contentSource) ||
  !/startVoiceFirstCapture\("double", \{ freshThread: true \}\)/.test(contentSource) ||
  !/open_chat_preserve_capture[\s\S]{0,220}openTextSurface/.test(contentSource)
) {
  throw new Error("mark gestures must defer collision-safe single/double/triple actions and support either stop gesture");
}
const mainContentScripts = manifest.content_scripts?.find((entry) => entry.js?.includes("content.js"))?.js || [];
if (
  mainContentScripts.indexOf("voice-capture-gesture.js") < 0 ||
  mainContentScripts.indexOf("voice-capture-gesture.js") > mainContentScripts.indexOf("content.js") ||
  /ageeVoiceFirstGesturesEnabled|VOICE_FIRST_GESTURES_KEY/.test(contentSource) ||
  /voiceFirstGestures|Voice-first orb gestures/.test(optionsHtmlSource + optionsSource) ||
  /agee-draft-control/.test(contentSource + overlayCssSource)
) {
  throw new Error("canonical mark gestures must load before content.js and expose no optional setting or draft controls");
}

const launcherClickBody = sourceBetween(
  contentSource,
  /launcher\.addEventListener\("click"/,
  /launcher\.addEventListener\("pointerdown"/,
  "launcher click handler"
);
if (/commitLiveVoiceTurn\(\)|toggleVoice\(\)|startLiveVoiceTurn\(/.test(launcherClickBody)) {
  throw new Error("single-clicking the launcher must only open the chat menu, not commit or start voice");
}

const startLauncherDragBody = sourceBetween(
  contentSource,
  /function startLauncherDrag\(/,
  /function moveLauncherDrag\(/,
  "launcher pointerdown handler"
);
if (!/beginVoiceFirstPress\(e\)/.test(startLauncherDragBody)) {
  throw new Error("launcher pointerdown must always enter the canonical voice gesture machine");
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

if (
  !/extension context invalidated\|context invalidated/i.test(contentExtensionApiSource) ||
  !/function safeRuntimeSendMessage/.test(contentExtensionApiSource) ||
  !/function safeStorageLocalGet/.test(contentExtensionApiSource) ||
  !/function safeStorageLocalSet/.test(contentExtensionApiSource) ||
  !/safeRuntimeSendMessage,[\s\S]{0,160}safeStorageLocalGet,[\s\S]{0,160}safeStorageLocalSet,[\s\S]{0,180}AgeeContentExtensionApiRuntime\.createContentExtensionApiRuntime\(\{/.test(contentSource)
) {
  throw new Error("content.js must delegate runtime and storage calls to the stale-context safety runtime");
}

if (
  !/looksLikeGatewayProfileControlIntent/.test(backgroundSource) ||
  !/function maybeRouteGatewayProfileControl/.test(backgroundSource) ||
  !/data\?\.classification === "profile_control"/.test(backgroundSource)
) {
  throw new Error("typed voice/language profile controls must route through /v1/voice/turns and refresh the profile cache");
}

if (
  !/\/v1\/agent\/profile\/options/.test(optionsSource) ||
  !/function renderProfileOptions/.test(optionsSource) ||
  !/function renderLanguagePicker/.test(optionsSource) ||
  !/<select id="voiceName">/.test(optionsHtmlSource) ||
  !/<datalist id="modelOptions">/.test(optionsHtmlSource) ||
  !/<div class="catalog-picker" id="replyLanguagePicker">/.test(optionsHtmlSource) ||
  !/<datalist id="languageOptions">/.test(optionsHtmlSource)
) {
  throw new Error("options page must load model/voice/language choices from the gateway profile-options catalog");
}

if (/patch\.language_primary/.test(optionsSource) || /patch\.input_language_primary/.test(optionsSource)) {
  throw new Error("options form must not expose or send primary language fields; the gateway derives them from the first code");
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
  "extension/browser-agent-loop-policy.js",
  "extension/browser-task-intent.js",
  "extension/config.js",
  "extension/content-companion-policy-runtime.js",
  "extension/content-context-control-runtime.js",
  "extension/content-extension-api-runtime.js",
  "extension/content-note-controller-runtime.js",
  "extension/content-ui-controller-runtime.js",
  "extension/content-voice-policy-runtime.js",
  "extension/content.js",
  "extension/page-observation-runtime.js",
  "extension/offscreen.js",
  "extension/offscreen-audio-worklet.js",
  "extension/livekit-voice.js",
  "extension/voice-sampler-runtime.js",
  "extension/offscreen-livekit.js",
  "extension/tweaks.js",
  "extension/options.js",
  "extension/settings-intent.js",
  "extension/stop-intent.js",
  "extension/browser-turn-protocol.js",
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
  "scripts/smoke-ui-spec.mjs",
  "scripts/smoke-unified-browser-agent.mjs",
  "scripts/smoke-cdp.mjs",
  "scripts/smoke-integration.mjs",
  "scripts/smoke-history.mjs",
  "scripts/test-voice-sampler-lifecycle.mjs",
  "scripts/test-cue-dismiss.mjs",
  "scripts/test-extension-production-sources.mjs",
  "scripts/test-runtime-intent-modules.mjs",
  "scripts/test-browser-turn-protocol.mjs",
  "scripts/test-browser-agent-loop-policy.mjs",
  "scripts/extension-production-sources.mjs",
  "scripts/coverage-extension.mjs",
  "scripts/chrome-for-testing.mjs",
]) {
  execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
}

execFileSync(process.execPath, ["--test", "scripts/test-voice-sampler-lifecycle.mjs"], { stdio: "inherit" });
// Pure-function tests for the persistent cue-card cascade dismiss and the
// extracted companion/language policy runtime.
execFileSync(process.execPath, ["scripts/test-cue-dismiss.mjs"], { stdio: "inherit" });
execFileSync(process.execPath, ["scripts/test-browser-context-adapter.mjs"], { stdio: "inherit" });

const { parseSettingsIntent, looksLikeGatewayProfileControlIntent } = await import("../extension/settings-intent.js");
const { parseBrowserTaskIntent, parseOpenTabIntent, looksLikePageContextQuestion } = await import("../extension/browser-task-intent.js");
const {
  DEFAULT_GATEWAY_URL,
  effectiveGatewayUrl,
  gatewayUrlDiagnostic,
  normalizeDefaultGatewayUrl,
} = await import("../extension/config.js");

if (DEFAULT_GATEWAY_URL !== "https://api.agee.app") {
  throw new Error(`unexpected hosted default gateway URL: ${DEFAULT_GATEWAY_URL}`);
}
if (normalizeDefaultGatewayUrl("") !== "" || effectiveGatewayUrl("", "", false) !== "") {
  throw new Error("fresh installs must leave the gateway unset until explicit configuration or disclosed acceptance");
}
if (normalizeDefaultGatewayUrl("http://10.147.17.10:8787") !== DEFAULT_GATEWAY_URL) {
  throw new Error("legacy main-machine gateway must normalize to the hosted default");
}
if (normalizeDefaultGatewayUrl("http://10.147.17.6:8787") !== DEFAULT_GATEWAY_URL) {
  throw new Error("legacy local Mac gateway must normalize to the hosted default unless user-owned in storage");
}
if (effectiveGatewayUrl("http://10.147.17.10:8787", DEFAULT_GATEWAY_URL, false) !== DEFAULT_GATEWAY_URL) {
  throw new Error("non-user-owned legacy main-machine URL must migrate to baked/stable config");
}
if (effectiveGatewayUrl("http://10.147.17.10:8787", DEFAULT_GATEWAY_URL, true) !== "http://10.147.17.10:8787") {
  throw new Error("user-owned legacy main-machine URL must not be overwritten by seeding");
}
if (effectiveGatewayUrl("http://10.147.17.6:8787", DEFAULT_GATEWAY_URL, false) !== DEFAULT_GATEWAY_URL) {
  throw new Error("non-user-owned local Mac URL must migrate to baked/stable config");
}
if (effectiveGatewayUrl("http://10.147.17.6:8787", DEFAULT_GATEWAY_URL, true) !== "http://10.147.17.6:8787") {
  throw new Error("user-owned local Mac URL must stay available for intentional local dev");
}
if (gatewayUrlDiagnostic("api.agee.app").code !== "missing_scheme") {
  throw new Error("gateway diagnostics must flag missing schemes");
}
if (gatewayUrlDiagnostic("https://api.agee.app/v1/voice/turns").code !== "endpoint_path") {
  throw new Error("gateway diagnostics must flag endpoint paths saved as origins");
}
if (gatewayUrlDiagnostic("http://10.147.17.10:8787").code !== "stale_or_local_url") {
  throw new Error("gateway diagnostics must flag the old main-machine ZeroTier URL");
}
if (gatewayUrlDiagnostic("http://10.147.17.6:8787").code !== "stale_or_local_url") {
  throw new Error("gateway diagnostics must flag the local Mac URL");
}

// Fast local stop path. The matcher must halt whole-utterance stop commands and
// must NOT swallow a real instruction that merely starts with "stop".
const settingsIntentSource = readFileSync("extension/settings-intent.js", "utf8");
const stopIntentSource = readFileSync("extension/stop-intent.js", "utf8");
const { isStopCommand: verifyIsStopCommand } = await import("../extension/stop-intent.js");
for (const phrase of ["stop", "shut up", "be quiet", "quiet", "silence", "stop please", "shut up now", "stop talking"]) {
  if (!verifyIsStopCommand(phrase)) {
    throw new Error(`stop-intent must halt on: ${phrase}`);
  }
}
for (const phrase of [
  "stop opening tabs",
  "stop sharing my location",
  "be quiet about the weather later",
  "quiet the notifications",
  "tell me how to stop the process",
  "",
]) {
  if (verifyIsStopCommand(phrase)) {
    throw new Error(`stop-intent must NOT swallow: ${phrase}`);
  }
}

// The content-script mirror of the stop matcher must stay aligned with the
// module. Both must carry the same STOP_PHRASES so a spoken stop and a typed
// stop halt identically.
for (const source of [stopIntentSource, contentSource]) {
  for (const phrase of ["\"shut up\"", "\"be quiet\"", "\"stop talking\"", "\"silence\""]) {
    if (!source.includes(phrase)) {
      throw new Error(`stop matcher copy missing phrase ${phrase}`);
    }
  }
}
if (!/const STOP_PHRASES = \[/.test(contentSource) || !/function isStopCommand\(/.test(contentSource)) {
  throw new Error("content.js must mirror the stop-intent matcher inline (STOP_PHRASES + isStopCommand)");
}

// Live voice path: a final transcript that is a stop command must halt before
// the overlap and gateway-route checks, and must not be sent on as a turn.
if (!/if \(msg\.type === "transcript_final" && isStopCommand\(text\)\) \{\s*\n\s*haltForStopCommand\(state\);/.test(contentSource)) {
  throw new Error("content.js live voice path must short-circuit a stop transcript to haltForStopCommand before routing");
}
if (!/function haltForStopCommand\(/.test(contentSource) || !/stopAllLiveVoiceTurns\("cancel"\);\s*\n\s*stopSpeaking\(\);/.test(contentSource)) {
  throw new Error("haltForStopCommand must stop all live turns and assistant playback");
}

// Typed path: submitInstruction must halt a stop locally and never send it on.
if (!/if \(isStopCommand\(instruction\)\) \{/.test(contentSource)) {
  throw new Error("content.js submitInstruction must halt a typed stop command locally, before sending a run");
}

// Background defense in depth: a stop that reaches runAgent must halt without a
// model turn or spoken/written reply.
if (!/import \{ isStopCommand \} from "\.\/stop-intent\.js"/.test(backgroundSource)) {
  throw new Error("background.js must import the shared stop-intent matcher");
}
if (!/if \(isStopCommand\(instruction\)\) \{\s*\n\s*send\(tabId, \{ cmd: "stop", cueId \}\);/.test(backgroundSource)) {
  throw new Error("background.js runAgent must halt a stop command via a silent stop message, not a model turn");
}
if (!/case "stop":/.test(contentSource) || !/haltForStopCommand\(null\)/.test(contentSource)) {
  throw new Error("content.js must handle the background stop message by halting silently");
}
void settingsIntentSource;
const devExtensionSource = readFileSync("scripts/dev-extension.mjs", "utf8");
const pokeDevReloadSource = readFileSync("scripts/poke-dev-reload.mjs", "utf8");

if (!/\/__agee-dev\/bump/.test(devExtensionSource) || !/function bumpVersion/.test(devExtensionSource)) {
  throw new Error("dev-extension.mjs must expose /__agee-dev/bump so deploy can force a reload version");
}
if (!/\/__agee-dev\/bump/.test(pokeDevReloadSource) || !/bumpExistingServer/.test(pokeDevReloadSource)) {
  throw new Error("poke-dev-reload.mjs must ask an already-running dev server to bump its reload version");
}

const setupParagraph =
  'Open chrome://extensions, find agee, click reload. If it was loaded from elsewhere, remove it and Load unpacked from browser_extension/extension/.\n' +
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
const unsupportedLanguageIntent = parseSettingsIntent("respond in Arabic", null);
if (unsupportedLanguageIntent !== null) {
  throw new Error(`settings parser should reject unsupported languages for now, got: ${JSON.stringify(unsupportedLanguageIntent)}`);
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
  "what voices can you use",
  "what is your name",
  "what language settings are active",
  "what are the different languages I can make you speak",
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
for (const text of [
  "summarize this page",
  "read the current page",
  "describe this form",
  "what am I looking at",
  "what does this button do?",
  "check this page for errors",
]) {
  if (!looksLikePageContextQuestion(text)) {
    throw new Error(`page-context detector should accept: ${text}`);
  }
}
for (const text of [
  "say hello",
  "open https://example.com/docs in a new tab",
  "open https://example.com/docs and report the title",
  "change your voice to Kore",
  setupParagraph,
]) {
  if (looksLikePageContextQuestion(text)) {
    throw new Error(`page-context detector should ignore: ${text.slice(0, 80)}`);
  }
}

console.log("extension verification passed");
