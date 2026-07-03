// agee operational doctor.
//
// Local diagnostic for the user-visible failure mode where Chrome is still
// running an old unpacked extension/service worker. This never reads .env and
// never prints bearer tokens.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const extensionDir = join(root, "extension");
const configPath = join(extensionDir, "agee.config.json");
const defaultGatewayUrl = "https://api.agee.app";
const legacyMainGatewayUrl = "http://10.147.17.10:8787";
const localGatewayUrl = "http://10.147.17.6:8787";
const staleGatewayUrls = new Set([legacyMainGatewayUrl, "http://10.147.17.10:8788", localGatewayUrl]);
const staleError = "No gateway URL and no API key set";
const manifest = readJson(join(extensionDir, "manifest.json"));
const extensionLabel = manifest.name || "agee";

let failures = 0;

function pass(text) {
  console.log(`[PASS] ${text}`);
}

function fail(text) {
  failures += 1;
  console.log(`[FAIL] ${text}`);
}

function warn(text) {
  console.log(`[WARN] ${text}`);
}

function info(text) {
  console.log(`[INFO] ${text}`);
}

function normalizeUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function gatewayUrlDiagnostic(value) {
  const raw = normalizeUrl(value);
  if (!raw) return { code: "missing_config", message: "baked config has no gatewayUrl" };
  if (!/^https?:\/\//i.test(raw)) {
    return { code: "missing_scheme", message: `enter the full gateway URL, for example ${defaultGatewayUrl}` };
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { code: "invalid_url", message: `enter a valid gateway URL, for example ${defaultGatewayUrl}` };
  }
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (path !== "/" && (path === "/health" || path.startsWith("/v1/"))) {
    return { code: "endpoint_path", message: "save only the gateway origin, not an endpoint path" };
  }
  if (url.hostname === "10.147.17.10") {
    return {
      code: "stale_main_machine",
      message: "points at the old main-machine ZeroTier gateway; use the VPS URL unless intentionally testing local dev",
    };
  }
  if (url.hostname === "10.147.17.6") {
    return {
      code: "local_mac",
      message: "points at the local Mac gateway; use the VPS URL for browser/mobile onboarding",
    };
  }
  return { code: "ok", message: "" };
}

function networkFailureMessage(url, path, error) {
  const diagnostic = gatewayUrlDiagnostic(url);
  const hint = diagnostic.message ? ` ${diagnostic.message}.` : "";
  const detail = String(error?.message || error || "").trim();
  const suffix = detail && detail !== "Failed to fetch" ? ` (${detail})` : "";
  return `could not reach configured gateway ${url || "(unset)"} while calling ${path}; check DNS, TLS, and the saved URL.${hint}${suffix}`;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

async function fetchJson(url, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const resp = await fetch(url, { ...init, signal: controller.signal });
    const text = await resp.text();
    let json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`non-JSON response ${resp.status}: ${text.slice(0, 120)}`);
    }
    return { resp, json };
  } finally {
    clearTimeout(timeout);
  }
}

function checkSource() {
  const background = readFileSync(join(extensionDir, "background.js"), "utf8");
  const config = readFileSync(join(extensionDir, "config.js"), "utf8");
  if (background.includes(staleError)) {
    fail("current background.js still contains the old Anthropic-key fallback error");
  } else {
    pass("current background.js does not contain the stale Anthropic-key fallback error");
  }
  if (config.includes(defaultGatewayUrl)) {
    pass(`current config.js has the hosted gateway default ${defaultGatewayUrl}`);
  } else {
    fail(`current config.js is missing the hosted gateway default ${defaultGatewayUrl}`);
  }
  if (config.includes(legacyMainGatewayUrl) && config.includes(localGatewayUrl) && config.includes("isKnownStaleGatewayUrl")) {
    pass("current config.js treats legacy ZeroTier/local gateway URLs as stale seeded defaults");
  } else {
    fail("current config.js does not cover stale legacy/local gateway URL migration");
  }
}

function checkBakedConfig() {
  if (!existsSync(configPath)) {
    fail("extension/agee.config.json is missing; run `npm run configure`");
    return null;
  }
  let config;
  try {
    config = readJson(configPath);
  } catch (error) {
    fail(`extension/agee.config.json is not valid JSON: ${error.message}`);
    return null;
  }

  const gatewayUrl = normalizeUrl(config.gatewayUrl);
  const gatewayToken = String(config.gatewayToken || "");
  const diagnostic = gatewayUrlDiagnostic(gatewayUrl);
  if (diagnostic.code === "missing_config") {
    fail(diagnostic.message);
  } else if (diagnostic.code === "local_mac") {
    warn(`baked config gateway URL ${diagnostic.message}`);
  } else if (staleGatewayUrls.has(gatewayUrl) || diagnostic.code === "stale_main_machine") {
    fail(`baked config still points at stale gateway ${gatewayUrl}; run \`npm run configure\``);
  } else if (diagnostic.code !== "ok") {
    fail(`baked config gateway URL is invalid: ${diagnostic.message}`);
  } else {
    pass(`baked config gateway URL is ${gatewayUrl}`);
  }

  if (gatewayToken) {
    pass(`baked config gateway token is set (${gatewayToken.length} chars, not shown)`);
  } else {
    fail("baked config gateway token is empty; run `npm run configure`");
  }

  return { gatewayUrl, gatewayToken };
}

async function checkGateway(config) {
  if (!config?.gatewayUrl) return;
  try {
    const { resp, json } = await fetchJson(`${config.gatewayUrl}/health`);
    if (resp.ok && json.ok) {
      pass(`/health ok: provider=${json.provider || "unknown"}, model=${json.model || "unknown"}`);
    } else {
      fail(`/health returned HTTP ${resp.status}`);
    }
  } catch (error) {
    fail(`/health unreachable: ${networkFailureMessage(config.gatewayUrl, "/health", error)}`);
    return;
  }

  if (!config.gatewayToken) return;
  try {
    const { resp, json } = await fetchJson(`${config.gatewayUrl}/v1/voice/turns`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.gatewayToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        session_id: `agee-doctor-${Date.now()}`,
        turn_id: `turn-${Date.now()}`,
        forced_action: "agent_run",
        harness: "echo",
        transcript: "agee doctor gateway-token check",
        screen_context: {
          surface: "agee-doctor",
          text: "local extension operational doctor; use deterministic echo harness",
        },
      }),
    });
    if (resp.ok) {
      const reply = String(json.display || json.text || "").replace(/\s+/g, " ").slice(0, 80);
      pass(`/v1/voice/turns accepted the baked token and replied: ${JSON.stringify(reply)}`);
    } else if (resp.status === 401) {
      fail("/v1/voice/turns rejected the baked token (401); run `npm run configure`");
    } else {
      fail(`/v1/voice/turns returned HTTP ${resp.status}`);
    }
  } catch (error) {
    fail(`/v1/voice/turns failed: ${networkFailureMessage(config.gatewayUrl, "/v1/voice/turns", error)}`);
  }
}

function browserRoots() {
  const home = process.env.HOME;
  return [
    ["Google Chrome", join(home, "Library/Application Support/Google/Chrome")],
    ["Chrome Canary", join(home, "Library/Application Support/Google/Chrome Canary")],
    ["Chromium", join(home, "Library/Application Support/Chromium")],
    ["Brave", join(home, "Library/Application Support/BraveSoftware/Brave-Browser")],
    ["Microsoft Edge", join(home, "Library/Application Support/Microsoft Edge")],
    ["Arc", join(home, "Library/Application Support/Arc/User Data")],
  ];
}

function findInstalledAgee() {
  const matches = [];
  for (const [browser, base] of browserRoots()) {
    if (!existsSync(base)) continue;
    const profiles = execFileSync("find", [base, "-maxdepth", "2", "-name", "Preferences", "-print"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).split("\n").filter(Boolean);

    for (const prefsPath of profiles) {
      let prefs;
      try {
        prefs = readJson(prefsPath);
      } catch {
        continue;
      }
      const profile = prefsPath.slice(base.length + 1).replace(/\/Preferences$/, "");
      const settings = prefs.extensions?.settings || {};
      for (const [id, ext] of Object.entries(settings)) {
        const manifest = ext.manifest || {};
        const name = String(manifest.name || ext.name || "");
        const description = String(manifest.description || "");
        const extPath = String(ext.path || "");
        const relevant =
          /\baggie\b/i.test(`${name} ${description}`) ||
          /\bagee\b/i.test(`${name} ${description}`) ||
          /\bchief\s+ag\b/i.test(`${name} ${description}`) ||
          resolve(extPath || "/") === extensionDir ||
          /moa-assistant\/(?:software\/)?browser_extension\/extension/.test(extPath);
        if (relevant) {
          matches.push({
            browser,
            profile,
            id,
            name,
            state: ext.state,
            path: extPath,
            version: manifest.version || ext.version || "",
          });
        }
      }
    }
  }
  return matches;
}

function currentManifestVersion() {
  try {
    const manifest = readJson(join(extensionDir, "manifest.json"));
    return String(manifest.version || "");
  } catch {
    return "";
  }
}

function versionCompare(a, b) {
  const pa = String(a || "0").split(".").map(Number);
  const pb = String(b || "0").split(".").map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const va = Number.isFinite(pa[i]) ? pa[i] : 0;
    const vb = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}

function checkBrowserProfiles() {
  const repoVersion = currentManifestVersion();
  const matches = findInstalledAgee();
  if (!matches.length) {
    warn(`no ${extensionLabel} / agee extension is registered in common daily-browser profiles`);
    info(`load unpacked at: ${extensionDir}`);
    if (repoVersion) {
      info(`repo manifest version is ${repoVersion}; if a CWS install is older, bump and re-upload`);
    }
  } else {
    for (const match of matches) {
      const currentPath = resolve(match.path || "/") === extensionDir;
      const state = match.state === 1 ? "enabled" : `state=${match.state}`;
      const prefix = currentPath ? "PASS" : "WARN";
      const packed = !match.path || match.path.startsWith("chrome-extension://") || !match.path.includes("/");
      const source = packed ? "(packed/CWS)" : match.path;
      const version = match.version || "unknown";
      const older = repoVersion && version && versionCompare(version, repoVersion) < 0;
      console.log(
        `[${prefix}] ${match.browser}/${match.profile} has ${extensionLabel} id=${match.id} ${state}, version=${version}, source=${source}`
      );
      if (older) {
        warn(`installed version ${version} is older than repo version ${repoVersion}; reload or re-upload to Chrome Web Store`);
      }
      if (!currentPath && !packed) {
        warn(`that profile is not using this repo extension path: ${extensionDir}`);
      }
    }
  }

  try {
    const ps = execFileSync("ps", ["-axo", "command"], { encoding: "utf8" });
    const runningWithCurrentExtension = ps
      .split("\n")
      .some((line) => line.includes("--load-extension=") && line.includes(extensionDir));
    if (runningWithCurrentExtension) {
      info("a Chrome/Chromium process is currently running with this repo extension loaded");
    }
  } catch {
    // Best-effort only.
  }
}

console.log(`${extensionLabel} operational doctor`);
console.log("");

checkSource();
const config = checkBakedConfig();
await checkGateway(config);
checkBrowserProfiles();

console.log("");
if (failures) {
  console.log(`${extensionLabel} doctor failed: ${failures} issue(s) need action`);
  process.exit(1);
}
console.log(`${extensionLabel} doctor passed`);
