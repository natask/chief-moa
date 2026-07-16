import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const RUNTIME_SOURCE_FILES = Object.freeze([
  "extension/aggie-protocol-adapter.js",
  "extension/background.js",
  "extension/browser-agent-loop-policy.js",
  "extension/browser-agent-role-runtime.js",
  "extension/browser-context-adapter.js",
  "extension/browser-task-intent.js",
  "extension/browser-turn-protocol.js",
  "extension/config.js",
  "extension/content.js",
  "extension/livekit-voice.js",
  "extension/offscreen-audio-worklet.js",
  "extension/offscreen-livekit.js",
  "extension/offscreen.js",
  "extension/options.js",
  "extension/proactive-confirm.js",
  "extension/proactive-helper.js",
  "extension/settings-intent.js",
  "extension/selective-browser-memory.js",
  "extension/sidepanel.js",
  "extension/stop-intent.js",
  "extension/tweaks.js",
  "extension/ui-spec-runtime.js",
  "extension/voice-capture-gesture.js",
  "extension/voice-draft-protocol.js",
  "extension/voice-sampler-runtime.js",
  "extension/voice-sampler.js",
]);

const EXCLUDED_SOURCE_FILES = Object.freeze({
  "extension/dev.js": "operational_tooling",
  "extension/vendor/livekit-client.esm.js": "generated_vendor",
});

function listJavaScriptFiles(directory, root = directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...listJavaScriptFiles(path, root));
    else if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push(`extension/${path.slice(resolve(root).length + 1).replaceAll("\\", "/")}`);
    }
  }
  return files.sort();
}

function validateProductionSourceClassification(root) {
  const classified = [...RUNTIME_SOURCE_FILES, ...Object.keys(EXCLUDED_SOURCE_FILES)];
  const duplicate = classified.find((file, index) => classified.indexOf(file) !== index);
  if (duplicate) throw new Error(`duplicate extension JavaScript classification: ${duplicate}`);

  const actual = listJavaScriptFiles(resolve(root, "extension"));
  const missing = classified.filter((file) => !existsSync(resolve(root, file)));
  const unclassified = actual.filter((file) => !classified.includes(file));
  const stale = classified.filter((file) => !actual.includes(file));
  if (missing.length || unclassified.length || stale.length) {
    throw new Error([
      missing.length ? `missing classified files: ${missing.join(", ")}` : "",
      unclassified.length ? `unclassified extension JavaScript: ${unclassified.join(", ")}` : "",
      stale.length ? `stale classifications: ${stale.join(", ")}` : "",
    ].filter(Boolean).join("; "));
  }
  return { runtime: [...RUNTIME_SOURCE_FILES], excluded: { ...EXCLUDED_SOURCE_FILES } };
}

export { EXCLUDED_SOURCE_FILES, RUNTIME_SOURCE_FILES, validateProductionSourceClassification };
