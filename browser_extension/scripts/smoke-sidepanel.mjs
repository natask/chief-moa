// Headless smoke for the A.G. side panel agent surface.
//
// Loads the REAL extension in Chrome for Testing, opens sidepanel.html as an
// extension page, and proves the panel bridge end to end: the page boots, the
// agee-panel port connects, and a request round-trips through the background's
// handlePanelRequest with reqId correlation. It seeds the canonical mixed-
// surface history endpoint and proves first-open hydration, stable-id
// deduplication, panel reopen recovery, and full extension/background restart
// recovery. Also asserts the open-agee-panel command registered and
// chrome.sidePanel.open exists in the service worker.
//
// The panel is an extension page, so this exercises exactly what runs when the
// panel is open over a chrome:// tab — no content script involved.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { resolveChromeForTesting, quietChromeArgs } from "./chrome-for-testing.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const extensionPath = join(root, "extension");
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const runDir = join(root, ".gstack", "background-qa", `sidepanel-${runId}`);
const profilePath = join(runDir, "chrome-profile");
const GATEWAY_TOKEN = "sidepanel-history-smoke-token";
const SESSION_ID = "shared-sidepanel-history-smoke";
const LONG_ANDROID_TEXT = `Android product direction ${"kept complete across surfaces ".repeat(40)}`.trim();
const AUDIO_RECORD_ID = "aud_0123456789abcdef01234567";

const SEEDED_MESSAGES = [
  {
    message_id: "msg_android_user",
    session_id: SESSION_ID,
    turn_id: "turn_android",
    source_surface: "android",
    source_kind: "voice",
    speaker: "user",
    text: LONG_ANDROID_TEXT,
    completion_state: "completed",
  },
  {
    message_id: "msg_android_assistant",
    session_id: SESSION_ID,
    turn_id: "turn_android",
    source_surface: "android",
    source_kind: "voice",
    speaker: "assistant",
    text: "I preserved that Android direction in the shared session.",
    completion_state: "completed",
  },
  {
    message_id: "msg_browser_user",
    session_id: SESSION_ID,
    turn_id: "turn_browser",
    source_surface: "browser",
    source_kind: "text",
    speaker: "user",
    text: "Show this browser turn after restart.",
    completion_state: "completed",
  },
  {
    message_id: "msg_browser_assistant",
    session_id: SESSION_ID,
    turn_id: "turn_browser",
    source_surface: "browser",
    source_kind: "text",
    speaker: "assistant",
    text: "This response is durable.",
    completion_state: "completed",
  },
  // Exact canonical duplicate: the panel must render the identity only once.
  {
    message_id: "msg_browser_assistant",
    session_id: SESSION_ID,
    turn_id: "turn_browser",
    source_surface: "browser",
    source_kind: "text",
    speaker: "assistant",
    text: "This response is durable.",
    completion_state: "completed",
  },
];

function startGateway() {
  let messageReads = 0;
  let audioHistoryReads = 0;
  let legacyReads = 0;
  let canonicalAvailable = true;
  let historyFailure = false;
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (req.headers.authorization !== `Bearer ${GATEWAY_TOKEN}`) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (url.pathname === "/v1/sessions/default") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ session_id: SESSION_ID }));
      return;
    }
    if (url.pathname === `/v1/sessions/${SESSION_ID}/messages`) {
      messageReads += 1;
      if (historyFailure) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "temporary history outage" }));
        return;
      }
      if (!canonicalAvailable) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "messages route not deployed" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ messages: SEEDED_MESSAGES, has_more: false }));
      return;
    }
    if (url.pathname === `/v1/sessions/${SESSION_ID}/turns`) {
      legacyReads += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ turns: [
        {
          turn_id: "turn_android",
          source: "android",
          input_mode: "voice",
          transcript: LONG_ANDROID_TEXT,
          reply: "I preserved that Android direction in the shared session.",
          status: "completed",
        },
        {
          turn_id: "turn_browser",
          source: "browser",
          input_mode: "text",
          transcript: "Show this browser turn after restart.",
          reply: "This response is durable.",
          status: "completed",
        },
      ] }));
      return;
    }
    if (url.pathname === "/v1/audio-history") {
      audioHistoryReads += 1;
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "private, no-store",
      });
      res.end(JSON.stringify({
        contract: "audio_record.v1",
        records: [{
          contract: "audio_record.v1",
          audio_record_id: AUDIO_RECORD_ID,
          source_kind: "voice_turn",
          source_id: "turn_audio",
          session_id: SESSION_ID,
          captured_at: "2026-07-25T00:00:00.000Z",
          duration_ms: 1000,
          media_status: "missing",
          lifecycle: { status: "missing", reason: "fixture", deleted_at: "unknown" },
          audio: {
            content_type: "audio/L16; rate=16000; channels=1",
            encoding: "pcm16",
            bytes: 0,
            playback_href: null,
          },
          transcript: {
            status: "available",
            original_revision_id: "rev_0",
            selected_revision_id: "rev_0",
            revisions: [{
              revision_id: "rev_0",
              ordinal: 0,
              source: "original",
              transcript: "Audio history survives extension restarts.",
              created_at: "2026-07-25T00:00:00.000Z",
              provenance: {
                provider: "unknown",
                api_version: "unknown",
                model: "unknown",
                method: "unknown",
                recognizer: "unknown",
                location: "unknown",
                language_codes: [],
                prompt_digest: "unknown",
                audio_sha256: "unknown",
                audio_duration_ms: 1000,
                chunk_strategy: "unknown",
                operation_id: "unknown",
                billed_duration_ms: "unknown",
                cost: { amount: "unknown", currency: "unknown" },
                error: { code: "unknown", message: "unknown" },
              },
            }],
          },
        }],
        next_cursor: null,
      }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  return new Promise((resolveServer) => {
    server.listen(0, "127.0.0.1", () => resolveServer({
      server,
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      messageReads: () => messageReads,
      audioHistoryReads: () => audioHistoryReads,
      legacyReads: () => legacyReads,
      setCanonicalAvailable: (available) => { canonicalAvailable = available === true; },
      setHistoryFailure: (failed) => { historyFailure = failed === true; },
    }));
  });
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function waitForFile(path, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (existsSync(path)) return readFileSync(path, "utf8");
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${path}`);
}

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.ready = new Promise((resolveReady, rejectReady) => {
      this.ws.onopen = resolveReady;
      this.ws.onerror = rejectReady;
    });
    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (!msg.id || !this.pending.has(msg.id)) return;
      const { resolveCall, rejectCall } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) rejectCall(new Error(`${msg.error.message}: ${msg.error.data || ""}`));
      else resolveCall(msg.result);
    };
  }

  async send(method, params = {}) {
    await this.ready;
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolveCall, rejectCall) => {
      this.pending.set(id, { resolveCall, rejectCall });
    });
  }

  close() {
    this.ws.close();
  }
}

async function targets(port) {
  return fetch(`http://127.0.0.1:${port}/json/list`).then((resp) => resp.json());
}

async function waitForTarget(port, predicate, timeoutMs = 15000) {
  const started = Date.now();
  let lastTargets = [];
  while (Date.now() - started < timeoutMs) {
    lastTargets = await targets(port);
    const found = lastTargets.find(predicate);
    if (found) return found;
    await delay(200);
  }
  throw new Error(`Timed out waiting for Chrome target. Last targets: ${JSON.stringify(lastTargets.map((target) => ({
    type: target.type,
    title: target.title,
    url: target.url,
  })), null, 2)}`);
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "Runtime evaluation failed");
  }
  return result.result.value;
}

async function waitForEval(cdp, expression, timeoutMs = 12000) {
  const started = Date.now();
  let lastValue;
  while (Date.now() - started < timeoutMs) {
    lastValue = await evaluate(cdp, expression).catch(() => undefined);
    if (lastValue) return lastValue;
    await delay(150);
  }
  throw new Error(`Timed out waiting for expression: ${expression}; last=${JSON.stringify(lastValue)}`);
}

async function openPanel(browserCdp, devToolsPort, panelUrl) {
  const { targetId } = await browserCdp.send("Target.createTarget", { url: panelUrl });
  const pageTarget = await waitForTarget(devToolsPort, (target) => target.type === "page" && target.id === targetId);
  const pageCdp = new Cdp(pageTarget.webSocketDebuggerUrl);
  await pageCdp.send("Runtime.enable");
  await waitForEval(pageCdp, 'document.readyState === "complete" && document.getElementById("status")');
  return { targetId, pageCdp };
}

async function assertHydratedHistory(pageCdp, label) {
  const history = await waitForEval(pageCdp, `(() => {
    const rows = [...document.querySelectorAll("#history .history-message")];
    if (rows.length !== 4) return null;
    return {
      ids: rows.map((row) => row.dataset.messageId),
      speakers: rows.map((row) => row.dataset.speaker),
      text: rows.map((row) => row.querySelector(".body")?.textContent || ""),
      stale: document.getElementById("history")?.dataset.stale,
      errorHidden: document.getElementById("historyError")?.hidden,
    };
  })()`);
  if (new Set(history.ids).size !== 4) throw new Error(`${label}: canonical ids were duplicated: ${JSON.stringify(history)}`);
  if (JSON.stringify(history.speakers) !== JSON.stringify(["user", "assistant", "user", "assistant"])) {
    throw new Error(`${label}: message ordering/speakers drifted: ${JSON.stringify(history)}`);
  }
  if (history.text[0] !== LONG_ANDROID_TEXT || history.text[3] !== "This response is durable.") {
    throw new Error(`${label}: seeded history text was truncated or reordered: ${JSON.stringify(history)}`);
  }
  if (history.stale !== "false" || history.errorHidden !== true) {
    throw new Error(`${label}: reconciled history stayed stale/error: ${JSON.stringify(history)}`);
  }
  return history;
}

async function assertAudioHistory(pageCdp, label) {
  await evaluate(pageCdp, 'document.getElementById("audioHistoryBtn").click(); true');
  const record = await waitForEval(pageCdp, `(() => {
    const row = document.querySelector("#audioHistoryList [data-audio-record-id]");
    const play = row?.querySelector("button");
    return row?.dataset.audioRecordId === ${JSON.stringify(AUDIO_RECORD_ID)}
      && /survives extension restarts/.test(row.textContent)
      && /media: missing/.test(row.textContent)
      && play?.disabled === true
      ? { id: row.dataset.audioRecordId, disabled: play.disabled }
      : null;
  })()`);
  if (!record) throw new Error(`${label}: audio history did not recover`);
}

async function main() {
  const chromePath = resolveChromeForTesting();
  mkdirSync(profilePath, { recursive: true });
  const gateway = await startGateway();

  const chrome = spawn(chromePath, quietChromeArgs({ extensionPath, profilePath }), {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let browserCdp;
  let pageCdp;
  let workerCdp;
  let pageTargetId;
  try {
    const devToolsPort = Number((await waitForFile(join(profilePath, "DevToolsActivePort"))).split("\n")[0]);
    const workerTarget = await waitForTarget(
      devToolsPort,
      (target) => target.type === "service_worker" && /^chrome-extension:\/\/[a-p]+\/background\.js$/.test(target.url || ""),
    );
    const extensionId = workerTarget.url.match(/^chrome-extension:\/\/([a-p]+)\//)[1];

    workerCdp = new Cdp(workerTarget.webSocketDebuggerUrl);
    await workerCdp.send("Runtime.enable");
    // The service-worker target can appear a few milliseconds before Chrome
    // has attached its extension APIs. Retry this first real API read instead
    // of treating that startup race as a product exception.
    const commands = await waitForEval(
      workerCdp,
      'globalThis.chrome?.commands?.getAll ? chrome.commands.getAll().then((items) => items.length ? items : null) : null',
    );
    if (!commands.find((command) => command.name === "open-agee-panel")) {
      throw new Error(`open-agee-panel command was not registered: ${JSON.stringify(commands)}`);
    }
    const sidePanelApi = await waitForEval(workerCdp, 'typeof chrome.sidePanel?.open === "function"');
    if (!sidePanelApi) throw new Error("chrome.sidePanel.open is not available in the service worker");

    await evaluate(workerCdp, `chrome.storage.local.set({
      ageeGatewayUrl: ${JSON.stringify(gateway.baseUrl)},
      ageeGatewayToken: ${JSON.stringify(GATEWAY_TOKEN)},
      ageeGatewayUserSet: true,
      ageeSessionId: ${JSON.stringify(SESSION_ID)}
    }).then(() => true)`);

    const panelUrl = `chrome-extension://${extensionId}/sidepanel.html`;
    const browserInfo = await fetch(`http://127.0.0.1:${devToolsPort}/json/version`).then((resp) => resp.json());
    browserCdp = new Cdp(browserInfo.webSocketDebuggerUrl);
    ({ targetId: pageTargetId, pageCdp } = await openPanel(browserCdp, devToolsPort, panelUrl));
    await assertHydratedHistory(pageCdp, "initial open");
    await assertAudioHistory(pageCdp, "initial open");

    // A failed refresh must preserve the last-good messages, mark them stale,
    // and expose a user-triggered recovery instead of presenting an empty chat.
    gateway.setHistoryFailure(true);
    await evaluate(pageCdp, 'refreshHistory({ reason: "smoke outage" })');
    const stale = await waitForEval(pageCdp, `(() => {
      const history = document.getElementById("history");
      const error = document.getElementById("historyError");
      return history?.dataset.stale === "true" && error?.hidden === false
        ? { count: history.children.length, error: error.textContent }
        : null;
    })()`);
    if (stale.count !== 4 || !/not cleared|retry/i.test(stale.error)) {
      throw new Error(`history outage did not preserve a recoverable last-good view: ${JSON.stringify(stale)}`);
    }
    gateway.setHistoryFailure(false);
    await evaluate(pageCdp, 'document.getElementById("historyRetry").click(); true');
    await waitForEval(pageCdp, 'document.getElementById("history")?.dataset.stale === "false" && document.getElementById("historyError")?.hidden === true');
    await assertHydratedHistory(pageCdp, "manual history recovery");

    const roleUi = await evaluate(pageCdp, `(() => ({
      selectors: document.querySelectorAll("#agentModeSelector, [data-agent-mode-option]").length,
      roles: [roleForInstruction("explain this"), roleForInstruction("help me do this"),
        roleForInstruction("work with me"), roleForInstruction("organize this page")],
    }))()`);
    if (roleUi?.selectors !== 0 || JSON.stringify(roleUi?.roles) !== JSON.stringify(["explain", "help", "collaborate", "delegate"])) {
      throw new Error(`side-panel conversational roles are not selector-free: ${JSON.stringify(roleUi)}`);
    }

    const submittedDelegate = await evaluate(pageCdp, `(() => {
      const input = document.getElementById("text");
      input.value = "organize this page";
      document.getElementById("form")?.requestSubmit();
      return {
        hasConfirmation: document.querySelector(".delegation-confirm-actions") !== null,
        assistantText: [...document.querySelectorAll(".turn .ag")].at(-1)?.textContent || "",
      };
    })()`);
    if (submittedDelegate?.hasConfirmation || submittedDelegate?.assistantText !== "delegate is working…") {
      throw new Error(`Delegate submission did not start immediately: ${JSON.stringify(submittedDelegate)}`);
    }

    // Round-trip the existing panel bridge: an unsupported command must come back with
    // its reqId and a readable error, proving onConnect -> handlePanelRequest
    // -> reqId correlation against the REAL background worker.
    const roundtrip = await evaluate(pageCdp, `request({ cmd: "panelSmokePing" })`);
    if (roundtrip?.ok !== false || !/unsupported panel command/.test(String(roundtrip?.error || ""))) {
      throw new Error(`unexpected panel bridge reply: ${JSON.stringify(roundtrip)}`);
    }

    // Closing and reopening the panel creates a new extension document. It must
    // reconstruct the same projection without content-script memory. Disable
    // the new route for this read to prove compatibility with a gateway whose
    // promotion lags the extension package.
    gateway.setCanonicalAvailable(false);
    pageCdp.close();
    await browserCdp.send("Target.closeTarget", { targetId: pageTargetId });
    ({ targetId: pageTargetId, pageCdp } = await openPanel(browserCdp, devToolsPort, panelUrl));
    await assertHydratedHistory(pageCdp, "panel reopen");
    await assertAudioHistory(pageCdp, "panel reopen");
    if (gateway.legacyReads() < 1) throw new Error("panel reopen did not exercise the legacy /turns fallback");

    // Stop the isolated service-worker target while leaving the panel document
    // alive. Its port disconnect/reconnect path must wake a new worker and
    // reconcile the same stable identities without clearing last-good history.
    const oldWorkerId = workerTarget.id;
    gateway.setCanonicalAvailable(true);
    await browserCdp.send("Target.closeTarget", { targetId: oldWorkerId });
    workerCdp.close();
    const restartedWorker = await waitForTarget(
      devToolsPort,
      (target) => target.type === "service_worker" && target.id !== oldWorkerId && target.url === `chrome-extension://${extensionId}/background.js`,
    );
    workerCdp = new Cdp(restartedWorker.webSocketDebuggerUrl);
    await workerCdp.send("Runtime.enable");
    await assertHydratedHistory(pageCdp, "extension/background restart");
    // The History panel remains live across a real service-worker target
    // termination and continues from its gateway-owned projection.
    const recoveredAudio = await waitForEval(pageCdp, `document.querySelector(
      "#audioHistoryList [data-audio-record-id='${AUDIO_RECORD_ID}']"
    )?.textContent.includes("survives extension restarts")`);
    if (!recoveredAudio || gateway.audioHistoryReads() < 2) {
      throw new Error(`audio history did not survive panel/worker restart; reads=${gateway.audioHistoryReads()}`);
    }
    if (gateway.messageReads() < 3) {
      throw new Error(`expected canonical history to be re-read for each document/restart, got ${gateway.messageReads()}`);
    }

    console.log(
      `sidepanel smoke passed (REAL extension, headless Chrome for Testing): panel page booted at ${panelUrl}, ` +
        "canonical mixed-surface and audio history hydrated on first open, panel reopen, and extension/background restart; " +
        "agee-panel port round-tripped, conversational roles had no selector, Delegate confirmation cancelled safely, " +
        "open-agee-panel and chrome.sidePanel.open remained available.",
    );
  } finally {
    workerCdp?.close();
    pageCdp?.close();
    browserCdp?.close();
    chrome.kill("SIGTERM");
    gateway.server.close();
    await delay(300);
    try {
      rmSync(runDir, { recursive: true, force: true });
    } catch {}
  }
}

main().catch((error) => {
  console.error(String(error?.stack || error));
  process.exit(1);
});
