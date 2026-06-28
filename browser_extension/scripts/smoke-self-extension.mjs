import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const backgroundSource = readFileSync("extension/background.js", "utf8");
const contentSource = readFileSync("extension/content.js", "utf8");
const overlayCssSource = readFileSync("extension/overlay.css", "utf8");
const packageJson = JSON.parse(readFileSync("package.json", "utf8"));

const knownMotions = ["still", "pulse", "hop", "orbit", "float", "shake", "glow"];
const knownTriggers = ["always", "idle", "busy", "listening", "thinking", "speaking"];

function sourceBetween(source, startPattern, endPattern, label) {
  const start = source.search(startPattern);
  if (start < 0) throw new Error(`missing ${label} start`);
  const rest = source.slice(start);
  const end = rest.search(endPattern);
  if (end < 0) throw new Error(`missing ${label} end`);
  return rest.slice(0, end);
}

if (!/SELF_EXTENSION_RUNTIME_FALLBACK/.test(backgroundSource)) {
  throw new Error("background.js must define a safe self-extension runtime fallback");
}
if (!/function loadSelfExtensionRuntime/.test(backgroundSource)) {
  throw new Error("background.js must expose a self-extension runtime loader");
}
if (!/\/v1\/self-extension\/runtime/.test(backgroundSource) || !/method:\s*"GET"/.test(backgroundSource)) {
  throw new Error("background.js must fetch GET /v1/self-extension/runtime");
}
if (!/callGateway\(cfg,\s*"\/v1\/self-extension\/runtime"/.test(backgroundSource)) {
  throw new Error("self-extension runtime fetch must use the existing callGateway helper");
}
if (!/msg\.cmd === "selfExtensionRuntime"/.test(backgroundSource)) {
  throw new Error("background.js must expose the selfExtensionRuntime message command");
}

const runtimeLoaderBody = sourceBetween(
  backgroundSource,
  /async function loadSelfExtensionRuntime\(/,
  /\/\/ ---- Gateway-queued browser tasks/,
  "self-extension runtime loader",
);
if (!/if \(!cfg\.gatewayUrl\) return SELF_EXTENSION_RUNTIME_FALLBACK/.test(runtimeLoaderBody)) {
  throw new Error("self-extension runtime loader must fall back when no gateway is configured");
}
if (!/catch\s*\{[\s\S]{0,120}return SELF_EXTENSION_RUNTIME_FALLBACK/.test(runtimeLoaderBody)) {
  throw new Error("self-extension runtime loader must fall back when the endpoint is unavailable");
}

for (const motion of knownMotions) {
  if (!contentSource.includes(`"${motion}"`)) {
    throw new Error(`content.js missing known avatar behavior motion: ${motion}`);
  }
  if (!contentSource.includes(`agee-avatar-motion-${motion}`)) {
    throw new Error(`content.js missing avatar behavior motion class mapping: ${motion}`);
  }
  if (!overlayCssSource.includes(`agee-avatar-motion-${motion}`)) {
    throw new Error(`overlay.css missing avatar behavior motion class: ${motion}`);
  }
}

for (const trigger of knownTriggers) {
  if (!contentSource.includes(`"${trigger}"`)) {
    throw new Error(`content.js missing known avatar behavior trigger: ${trigger}`);
  }
  if (!contentSource.includes(`agee-avatar-trigger-${trigger}`)) {
    throw new Error(`content.js missing avatar behavior trigger class mapping: ${trigger}`);
  }
}

if (
  !/function sanitizeAvatarBehaviorRuntime/.test(contentSource) ||
  !/behavior\?\.type !== "avatar_behavior"/.test(contentSource) ||
  !/AVATAR_BEHAVIOR_MOTIONS\.has\(motion\)/.test(contentSource) ||
  !/AVATAR_BEHAVIOR_TRIGGERS\.has\(trigger\)/.test(contentSource)
) {
  throw new Error("content.js must sanitize gateway avatar_behavior specs before applying them");
}

if (
  !/root\.dataset\.ageeAvatarMotion = motion/.test(contentSource) ||
  !/root\.dataset\.ageeAvatarTrigger = trigger/.test(contentSource) ||
  !/root\.classList\.toggle\("agee-avatar-runtime-active", active\)/.test(contentSource) ||
  !/function syncAvatarBehaviorTrigger/.test(contentSource)
) {
  throw new Error("content.js must map sanitized avatar behavior to root data attributes and active classes");
}

const avatarRuntimeBody = sourceBetween(
  contentSource,
  /function sanitizeAvatarBehaviorRuntime\(/,
  /\/\/ ---- Cue cards/,
  "content avatar behavior runtime mapping",
);
if (/\beval\s*\(|new\s+Function|executeScript|script\b/i.test(avatarRuntimeBody)) {
  throw new Error("avatar behavior runtime mapping must remain declarative and must not execute generated JS");
}

for (const keyframe of [
  "agee-avatar-pulse",
  "agee-avatar-hop",
  "agee-avatar-orbit",
  "agee-avatar-float",
  "agee-avatar-shake",
  "agee-avatar-glow",
]) {
  if (!overlayCssSource.includes(`@keyframes ${keyframe}`)) {
    throw new Error(`overlay.css missing avatar behavior keyframes: ${keyframe}`);
  }
}
if (!/agee-avatar-runtime-active/.test(overlayCssSource) || !/data-agee-avatar-intensity/.test(overlayCssSource)) {
  throw new Error("overlay.css must gate avatar behavior motion on active runtime state and intensity data");
}

if (packageJson.scripts?.["smoke:self-extension"] !== "node scripts/smoke-self-extension.mjs") {
  throw new Error("package.json must expose npm run smoke:self-extension");
}

for (const file of [
  "extension/background.js",
  "extension/content.js",
  "scripts/smoke-self-extension.mjs",
]) {
  execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
}

console.log("self-extension smoke passed");
