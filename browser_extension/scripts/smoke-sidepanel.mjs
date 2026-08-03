// Headless smoke for the AG side panel agent surface.
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
const AUDIO_CAPTURE_BLOCK_ID = `cap_${"a".repeat(64)}`;
const AUDIO_CAPTURE_BLOCK = {
  schema_version: 2,
  id: AUDIO_CAPTURE_BLOCK_ID,
  processing_state: "transcribed",
  source: { kind: "audio_note", audio_note_id: "note_older", surface: "agee-extension" },
  audio: { audio_note_id: "note_older", content_type: "audio/L16; rate=16000; channels=1" },
  transcript: {
    state: "transcribed",
    literal: "Exact retained voice-note transcript.",
    result_id: "result_sidepanel_smoke",
    provider: { id: "chirp", model: "chirp_3", request_id: "provider_sidepanel_smoke" },
  },
};
const SEEDED_AUDIO_NOTES = [
  {
    id: "note_older",
    created_at: "2026-07-30T07:00:00.000Z",
    surface: "agee-extension",
    content_type: "audio/L16; rate=16000; channels=1",
    bytes: 4,
    duration_ms: 125,
    label: "Older note",
    audio: { href: "/v1/audio-notes/note_older/audio", bytes: 4 },
  },
  {
    id: "note_newer",
    created_at: "2026-07-30T10:00:00.000Z",
    surface: "agee-extension",
    content_type: "audio/L16; rate=16000; channels=1",
    bytes: 4,
    duration_ms: 125,
    label: "Newer note",
    transcription: { state: "failed", error: "provider unavailable", retryable: true },
    audio: { href: "/v1/audio-notes/note_newer/audio", bytes: 4 },
  },
];

const SEEDED_MESSAGES = [
  {
    message_id: "msg_android_user",
    session_id: SESSION_ID,
    turn_id: "turn_android",
    source_surface: "android",
    source_kind: "voice",
    speaker: "user",
    text: LONG_ANDROID_TEXT,
    created_at: "2026-07-30T08:00:00.000Z",
    completion_state: "completed",
    voice_history: {
      audio_accessible: true,
      audio_accessibility: "available",
      retranscription_supported: true,
      retranscription_available: true,
      current_revision: 0,
      revision_count: 1,
      revisions_truncated: false,
      transcript_revisions: [{
        revision: 0,
        transcript: LONG_ANDROID_TEXT,
        source: "original",
        created_at: "2026-07-30T08:00:00.000Z",
      }],
    },
  },
  {
    message_id: "msg_android_assistant",
    session_id: SESSION_ID,
    turn_id: "turn_android",
    source_surface: "android",
    source_kind: "voice",
    speaker: "assistant",
    text: "I preserved that Android direction in the shared session.",
    created_at: "2026-07-30T08:00:01.000Z",
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
    created_at: "2026-07-30T09:00:00.000Z",
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
    created_at: "2026-07-30T09:00:01.000Z",
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
    created_at: "2026-07-30T09:00:01.000Z",
    completion_state: "completed",
  },
];

function startGateway() {
  let messageReads = 0;
  let legacyReads = 0;
  let retranscribeCalls = 0;
  let retranscribeFailure = false;
  let canonicalAvailable = true;
  let historyFailure = false;
  let audioNotes = SEEDED_AUDIO_NOTES.map((note) => structuredClone(note));
  let audioNoteReads = 0;
  let audioNoteDeletes = 0;
  let audioNotesFailure = false;
  let captureBlockCreates = 0;
  let handoffCalls = 0;
  const captureBodies = [];
  const handoffBodies = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (req.headers.authorization !== `Bearer ${GATEWAY_TOKEN}`) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/audio-notes") {
      audioNoteReads += 1;
      if (audioNotesFailure) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "temporary audio-note outage" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ notes: audioNotes }));
      return;
    }
    if (req.method === "GET" && /^\/v1\/audio-notes\/[^/]+\/audio$/.test(url.pathname)) {
      const id = decodeURIComponent(url.pathname.split("/")[3]);
      if (!audioNotes.some((note) => note.id === id)) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      res.writeHead(200, { "content-type": "audio/L16; rate=16000; channels=1" });
      res.end(Buffer.from([1, 2, 3, 4]));
      return;
    }
    if (req.method === "DELETE" && /^\/v1\/audio-notes\/[^/]+$/.test(url.pathname)) {
      const id = decodeURIComponent(url.pathname.split("/")[3]);
      const before = audioNotes.length;
      audioNotes = audioNotes.filter((note) => note.id !== id);
      if (audioNotes.length === before) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      audioNoteDeletes += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ deleted: true, note_id: id }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/capture-blocks") {
      captureBlockCreates += 1;
      captureBodies.push(await readRequestJson(req));
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ capture_block: AUDIO_CAPTURE_BLOCK }));
      return;
    }
    if (req.method === "GET" && url.pathname === `/v1/capture-blocks/${AUDIO_CAPTURE_BLOCK_ID}`) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ capture_block: AUDIO_CAPTURE_BLOCK }));
      return;
    }
    if (req.method === "POST" && url.pathname === `/v1/capture-blocks/${AUDIO_CAPTURE_BLOCK_ID}/handoff`) {
      handoffCalls += 1;
      handoffBodies.push(await readRequestJson(req));
      res.writeHead(202, { "content-type": "application/json" });
      res.end(JSON.stringify({ handoff: {
        schema_version: 1,
        source_system: "chief-moa",
        source_record_id: AUDIO_CAPTURE_BLOCK_ID,
        source_revision: `capture-block-v2:${"b".repeat(64)}`,
        request_digest: `sha256:${"c".repeat(64)}`,
        switchboard: {
          admission_id: "ext_sidepanel_smoke",
          raw_intent_id: "raw_sidepanel_smoke",
          compiled_intent_ids: ["intent_sidepanel_smoke"],
          state: "queued",
        },
      } }));
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
      // Canonical History is newest-turn-first while preserving user then
      // assistant inside each turn.
      const newestFirst = [...SEEDED_MESSAGES.slice(2), ...SEEDED_MESSAGES.slice(0, 2)];
      res.end(JSON.stringify({ messages: newestFirst, has_more: false }));
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
    if (req.method === "POST"
        && url.pathname.startsWith(`/v1/voice/turns/${SESSION_ID}/`)
        && url.pathname.endsWith("/retranscribe")) {
      retranscribeCalls += 1;
      const turnId = decodeURIComponent(
        url.pathname.slice(`/v1/voice/turns/${SESSION_ID}/`.length, -"/retranscribe".length),
      );
      if (retranscribeFailure) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "provider retry failed" }));
        return;
      }
      if (turnId === "turn_android") {
        const userMessage = SEEDED_MESSAGES.find((message) => message.message_id === "msg_android_user");
        const revision = userMessage.voice_history.current_revision + 1;
        userMessage.text = `A cleaner transcript revision ${revision}.`;
        userMessage.voice_history.current_revision = revision;
        userMessage.voice_history.transcript_revisions.push({
          revision,
          transcript: userMessage.text,
          source: "retranscribe",
          created_at: `2026-07-30T10:0${revision}:00.000Z`,
        });
        userMessage.voice_history.revision_count =
          userMessage.voice_history.transcript_revisions.length;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        session_id: SESSION_ID,
        turn_id: turnId,
        transcript: turnId === "turn_android"
          ? SEEDED_MESSAGES.find((message) => message.message_id === "msg_android_user").text
          : "A cleaner transcript.",
        retranscribed: true,
        revision: 1,
      }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/voice/turns/sidepanel-final-transcript") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "sidepanel-final-transcript",
        transcript: "Canonical final transcript from retained audio.",
        assistant_text: "The final transcript is ready.",
        status: "completed",
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
      legacyReads: () => legacyReads,
      retranscribeCalls: () => retranscribeCalls,
      audioNoteReads: () => audioNoteReads,
      audioNoteDeletes: () => audioNoteDeletes,
      captureBlockCreates: () => captureBlockCreates,
      captureBodies: () => captureBodies,
      handoffCalls: () => handoffCalls,
      handoffBodies: () => handoffBodies,
      setCanonicalAvailable: (available) => { canonicalAvailable = available === true; },
      setAudioNotesFailure: (failed) => { audioNotesFailure = failed === true; },
      setHistoryFailure: (failed) => { historyFailure = failed === true; },
      setRetranscribeFailure: (failed) => { retranscribeFailure = failed === true; },
    }));
  });
}

async function readRequestJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
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

async function assertHydratedHistory(pageCdp, label, { retranscriptionAdvertised = true } = {}) {
  const history = await waitForEval(pageCdp, `(() => {
    const cards = [...document.querySelectorAll("#history > .history-turn")];
    const rows = [...document.querySelectorAll("#history .history-message")];
    if (cards.length !== 2 || rows.length !== 4) return null;
    return {
      outerTurns: cards.map((card) => card.dataset.turnId),
      nestedSpeakers: cards.map((card) =>
        [...card.querySelectorAll(":scope > .history-message")].map((row) => row.dataset.speaker)),
      ids: rows.map((row) => row.dataset.messageId),
      speakers: rows.map((row) => row.dataset.speaker),
      text: rows.map((row) => row.querySelector(".body")?.textContent || ""),
      copyLabels: rows.map((row) => row.querySelector(".history-copy")?.getAttribute("aria-label") || ""),
      latestVoiceTurns: rows
        .filter((row) => row.dataset.latestVoiceTranscript === "true"
          && row.classList.contains("latest-voice-transcript"))
        .map((row) => row.dataset.turnId),
      retranscribeTurns: rows
        .filter((row) => row.querySelector(".history-retranscribe"))
        .map((row) => row.dataset.turnId),
      stale: document.getElementById("history")?.dataset.stale,
      errorHidden: document.getElementById("historyError")?.hidden,
    };
  })()`);
  if (JSON.stringify(history.outerTurns) !== JSON.stringify(["turn_browser", "turn_android"])
      || JSON.stringify(history.nestedSpeakers) !== JSON.stringify([["user", "assistant"], ["user", "assistant"]])) {
    throw new Error(`${label}: outer turn cards were not newest-first with nested speaker order: ${JSON.stringify(history)}`);
  }
  if (new Set(history.ids).size !== 4) throw new Error(`${label}: canonical ids were duplicated: ${JSON.stringify(history)}`);
  if (JSON.stringify(history.speakers) !== JSON.stringify(["user", "assistant", "user", "assistant"])) {
    throw new Error(`${label}: message ordering/speakers drifted: ${JSON.stringify(history)}`);
  }
  if (history.text[0] !== "Show this browser turn after restart."
      || history.text[1] !== "This response is durable."
      || history.text[2] !== LONG_ANDROID_TEXT
      || history.text[3] !== "I preserved that Android direction in the shared session.") {
    throw new Error(`${label}: seeded history text was truncated or reordered: ${JSON.stringify(history)}`);
  }
  if (JSON.stringify(history.copyLabels) !== JSON.stringify([
    "Copy transcript", "Copy Ag response", "Copy transcript", "Copy Ag response",
  ])) {
    throw new Error(`${label}: retained messages did not expose accessible copy actions: ${JSON.stringify(history)}`);
  }
  if (JSON.stringify(history.latestVoiceTurns) !== JSON.stringify(["turn_android"])) {
    throw new Error(`${label}: latest completed user voice transcript hook drifted: ${JSON.stringify(history)}`);
  }
  const expectedRetranscribeTurns = retranscriptionAdvertised ? ["turn_android"] : [];
  if (JSON.stringify(history.retranscribeTurns) !== JSON.stringify(expectedRetranscribeTurns)) {
    throw new Error(`${label}: re-transcribe availability did not follow advertised voice metadata: ${JSON.stringify(history)}`);
  }
  if (history.stale !== "false" || history.errorHidden !== true) {
    throw new Error(`${label}: reconciled history stayed stale/error: ${JSON.stringify(history)}`);
  }
  return history;
}

async function assertCompanionIdentity(pageCdp, label) {
  const identity = await waitForEval(pageCdp, `(() => {
    const root = document.getElementById("companionIdentity");
    const image = document.getElementById("companionIdentityImage");
    const name = document.getElementById("companionIdentityName");
    return root && image?.complete && name?.textContent
      ? { name: name.textContent, label: root.getAttribute("aria-label"), src: image.src }
      : null;
  })()`);
  if (identity.name !== "Scout" || identity.label !== "Ag, Scout companion" || !identity.src) {
    throw new Error(`${label}: active companion identity was not visible: ${JSON.stringify(identity)}`);
  }
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
      ageeSessionId: ${JSON.stringify(SESSION_ID)},
      ageeActiveCompanionPetCache: {
        active_companion: {
          companion_id: "scout",
          companion_name: "Scout",
          pet: { palette: "amber", motion: "walk", sprite: { type: "css-shigmi" } }
        },
        reason: "smoke"
      }
    }).then(() => true)`);

    const panelUrl = `chrome-extension://${extensionId}/sidepanel.html`;
    const browserInfo = await fetch(`http://127.0.0.1:${devToolsPort}/json/version`).then((resp) => resp.json());
    browserCdp = new Cdp(browserInfo.webSocketDebuggerUrl);
    ({ targetId: pageTargetId, pageCdp } = await openPanel(browserCdp, devToolsPort, panelUrl));
    await assertHydratedHistory(pageCdp, "initial open");
    await assertCompanionIdentity(pageCdp, "initial open");

    const storedPromotion = await waitForEval(pageCdp, `(() => {
      const card = document.querySelector('.voice-note-card[data-note-id="note_older"]');
      const buttons = [...(card?.querySelectorAll(".voice-note-actions button") || [])];
      const prepare = buttons.find((button) => button.textContent === "Prepare transcript");
      const handoff = buttons.find((button) => /Switchboard/.test(button.textContent));
      return card && prepare?.disabled === false
        ? { prepare: prepare.textContent, handoffVisible: Boolean(handoff && !handoff.hidden) }
        : null;
    })()`);
    if (storedPromotion.handoffVisible) {
      throw new Error(`stored note exposed execution before transcription: ${JSON.stringify(storedPromotion)}`);
    }
    await evaluate(pageCdp, `(() => {
      const card = document.querySelector('.voice-note-card[data-note-id="note_older"]');
      [...card.querySelectorAll(".voice-note-actions button")]
        .find((button) => button.textContent === "Prepare transcript")?.click();
      return true;
    })()`);
    const terminalPromotion = await waitForEval(pageCdp, `(() => {
      const card = document.querySelector('.voice-note-card[data-note-id="note_older"]');
      const handoff = [...(card?.querySelectorAll(".voice-note-actions button") || [])]
        .find((button) => /Switchboard/.test(button.textContent));
      return handoff && !handoff.hidden && handoff.disabled === false
        ? { label: handoff.textContent, status: card.querySelector(".voice-note-handoff")?.textContent }
        : null;
    })()`);
    if (terminalPromotion.label !== "Send to Switchboard"
        || terminalPromotion.status !== "Ready for explicit Switchboard handoff"
        || gateway.captureBlockCreates() !== 1
        || gateway.captureBodies()[0]?.authority) {
      throw new Error(`transcript preparation crossed the execution boundary: ${JSON.stringify(terminalPromotion)}`);
    }

    await evaluate(pageCdp, `(() => {
      globalThis.confirm = () => false;
      const card = document.querySelector('.voice-note-card[data-note-id="note_older"]');
      [...card.querySelectorAll(".voice-note-actions button")]
        .find((button) => button.textContent === "Send to Switchboard")?.click();
      return true;
    })()`);
    await waitForEval(pageCdp, `document.querySelector(
      '.voice-note-card[data-note-id="note_older"] .voice-note-operation'
    )?.textContent.includes("cancelled")`);
    if (gateway.handoffCalls() !== 0) throw new Error("cancelled handoff reached the gateway");

    await evaluate(pageCdp, `(() => {
      globalThis.confirm = () => true;
      const card = document.querySelector('.voice-note-card[data-note-id="note_older"]');
      [...card.querySelectorAll(".voice-note-actions button")]
        .find((button) => button.textContent === "Send to Switchboard")?.click();
      return true;
    })()`);
    const admitted = await waitForEval(pageCdp, `(() => {
      const card = document.querySelector('.voice-note-card[data-note-id="note_older"]');
      const status = card?.querySelector(".voice-note-handoff")?.textContent || "";
      return status.includes("intent_sidepanel_smoke")
        ? { status, action: [...card.querySelectorAll(".voice-note-actions button")]
          .find((button) => /Switchboard receipt/.test(button.textContent))?.textContent }
        : null;
    })()`);
    if (admitted.action !== "Check Switchboard receipt"
        || gateway.handoffCalls() !== 1
        || JSON.stringify(gateway.handoffBodies()[0]) !== JSON.stringify({ confirmed: true, authority: "execute" })) {
      throw new Error(`confirmed handoff did not retain an exact receipt: ${JSON.stringify(admitted)}`);
    }
    await evaluate(pageCdp, `(() => {
      const card = document.querySelector('.voice-note-card[data-note-id="note_older"]');
      [...card.querySelectorAll(".voice-note-actions button")]
        .find((button) => button.textContent === "Check Switchboard receipt")?.click();
      return true;
    })()`);
    await waitForEval(pageCdp, `document.querySelector(
      '.voice-note-card[data-note-id="note_older"] .voice-note-operation'
    )?.textContent.includes("same server-side admission")`);
    if (gateway.handoffCalls() !== 2) throw new Error("receipt replay did not use server continuity");

    const copied = await evaluate(pageCdp, `(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async (value) => { globalThis.__sidepanelCopied = value; } },
      });
      document.querySelector("#history .history-copy")?.click();
      return new Promise((resolveCopy) => setTimeout(() => resolveCopy({
        value: globalThis.__sidepanelCopied,
        feedback: document.querySelector("#history .history-copy")?.textContent,
        label: document.querySelector("#history .history-copy")?.getAttribute("aria-label"),
      }), 20));
    })()`);
    if (copied?.value !== "Show this browser turn after restart."
        || copied?.feedback !== "Copied"
        || !/copied$/i.test(copied?.label || "")) {
      throw new Error(`one-click history copy did not preserve exact text or expose feedback: ${JSON.stringify(copied)}`);
    }
    const copiedAssistant = await evaluate(pageCdp, `(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async (value) => { globalThis.__sidepanelCopiedAssistant = value; } },
      });
      document.querySelector(
        '#history .history-message[data-message-id="msg_browser_assistant"] .history-copy'
      )?.click();
      return new Promise((resolveCopy) => setTimeout(() => resolveCopy({
        value: globalThis.__sidepanelCopiedAssistant,
        label: document.querySelector(
          '#history .history-message[data-message-id="msg_browser_assistant"] .history-copy'
        )?.getAttribute("aria-label"),
      }), 20));
    })()`);
    if (copiedAssistant?.value !== "This response is durable."
        || !/Ag response copied$/i.test(copiedAssistant?.label || "")) {
      throw new Error(`assistant history copy was not exact: ${JSON.stringify(copiedAssistant)}`);
    }

    const finalTranscript = await evaluate(pageCdp, `(() => {
      if (!startVoiceLifecycleDiagnostic("sidepanel-final-transcript")) return null;
      handleVoiceEvent({ event: { type: "transcript_partial", text: "Provisional words" } });
      handleVoiceEvent({ event: { type: "transcript_final", text: "Provider final words" } });
      handleVoiceEvent({ event: { type: "transcript_partial", text: "Late stale hypothesis" } });
      handleVoiceEvent({ event: { type: "assistant_text", text: "The final transcript is ready." } });
      handleVoiceEvent({ event: {
        type: "turn_done",
        turn_id: "sidepanel-final-transcript",
        status: "completed",
      } });
      return true;
    })()`);
    if (!finalTranscript) throw new Error("could not start the final-transcript lifecycle fixture");
    const reconciledTranscript = await waitForEval(pageCdp, `(() => {
      const card = [...document.querySelectorAll(".turn")].at(-1);
      const heard = card?.querySelector(".you")?.textContent || "";
      const reply = card?.querySelector(".ag")?.textContent || "";
      return heard === "Canonical final transcript from retained audio."
        ? { heard, reply, status: document.getElementById("status")?.textContent }
        : null;
    })()`);
    if (reconciledTranscript.reply !== "The final transcript is ready."
        || reconciledTranscript.status !== "Ready.") {
      throw new Error(`terminal transcript did not reconcile cleanly: ${JSON.stringify(reconciledTranscript)}`);
    }

    const retranscribed = await evaluate(pageCdp, `request({
      cmd: "historyRetranscribe",
      sessionId: ${JSON.stringify(SESSION_ID)},
      turnId: "sidepanel-final-transcript",
    })`);
    if (!retranscribed?.ok || retranscribed.result?.transcript !== "A cleaner transcript."
        || gateway.retranscribeCalls() !== 1) {
      throw new Error(`panel re-transcribe proxy did not round-trip once: ${JSON.stringify(retranscribed)}`);
    }

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
    if (stale.count !== 2 || !/not cleared|retry/i.test(stale.error)) {
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
    await assertHydratedHistory(pageCdp, "panel reopen", { retranscriptionAdvertised: false });
    await assertCompanionIdentity(pageCdp, "panel reopen");
    const persistedHandoff = await waitForEval(pageCdp, `(() => {
      const card = document.querySelector('.voice-note-card[data-note-id="note_older"]');
      const status = card?.querySelector(".voice-note-handoff")?.textContent || "";
      const action = [...(card?.querySelectorAll(".voice-note-actions button") || [])]
        .find((button) => /Switchboard receipt/.test(button.textContent));
      return status.includes("intent_sidepanel_smoke") && action && !action.hidden
        ? { status, action: action.textContent, disabled: action.disabled }
        : null;
    })()`);
    if (persistedHandoff.action !== "Check Switchboard receipt" || persistedHandoff.disabled) {
      throw new Error(`Switchboard receipt did not survive panel reopen: ${JSON.stringify(persistedHandoff)}`);
    }
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
    if (gateway.messageReads() < 3) {
      throw new Error(`expected canonical history to be re-read for each document/restart, got ${gateway.messageReads()}`);
    }

    gateway.setRetranscribeFailure(true);
    await evaluate(pageCdp, `document.querySelector(
      '#history .history-message[data-turn-id="turn_android"] .history-retranscribe'
    )?.click(); true`);
    const failedRetranscription = await waitForEval(pageCdp, `(() => {
      const row = document.querySelector('#history .history-message[data-turn-id="turn_android"]');
      const button = row?.querySelector(".history-retranscribe");
      const status = document.getElementById("status");
      return button?.disabled === false && /failed/i.test(status?.textContent || "")
        ? { text: row.querySelector(":scope > .body")?.textContent, button: button.textContent }
        : null;
    })()`);
    if (failedRetranscription.text !== LONG_ANDROID_TEXT || failedRetranscription.button !== "Re-transcribe") {
      throw new Error(`failed re-transcription hid or changed the original: ${JSON.stringify(failedRetranscription)}`);
    }

    gateway.setRetranscribeFailure(false);
    await evaluate(pageCdp, `document.querySelector(
      '#history .history-message[data-turn-id="turn_android"] .history-retranscribe'
    )?.click(); true`);
    await waitForEval(pageCdp, `(() => {
      const row = document.querySelector('#history .history-message[data-turn-id="turn_android"]');
      return row?.dataset.transcriptRevision === "1"
        && row?.dataset.selectedTranscriptRevision === "1"
        && row?.querySelector(".history-retranscribe")?.disabled === false;
    })()`);
    await evaluate(pageCdp, `document.querySelector(
      '#history .history-message[data-turn-id="turn_android"] .history-retranscribe'
    )?.click(); true`);
    const revised = await waitForEval(pageCdp, `(() => {
      const row = document.querySelector('#history .history-message[data-turn-id="turn_android"]');
      const revision = row?.querySelector('.history-transcript-revision[data-revision="0"]');
      return row?.dataset.transcriptRevision === "2"
        && row?.dataset.selectedTranscriptRevision === "2"
        && revision
        ? {
            current: row.querySelector(":scope > .body")?.textContent,
            original: revision.querySelector(".body")?.textContent,
            copyCount: row.querySelectorAll(".history-copy").length,
            revisions: [...row.querySelectorAll(".history-transcript-revision")]
              .map((entry) => entry.dataset.revision),
            retranscribeReady: row.querySelector(".history-retranscribe")?.disabled === false,
          }
        : null;
    })()`);
    if (revised.current !== "A cleaner transcript revision 2."
        || revised.original !== LONG_ANDROID_TEXT
        || revised.copyCount !== 4
        || JSON.stringify(revised.revisions) !== JSON.stringify(["0", "1", "2"])
        || revised.retranscribeReady !== true
        || gateway.retranscribeCalls() !== 4) {
      throw new Error(`completed transcript revisions were not individually retained: ${JSON.stringify(revised)}`);
    }
    const selectedOriginal = await evaluate(pageCdp, `(() => {
      const row = document.querySelector('#history .history-message[data-turn-id="turn_android"]');
      row?.querySelector('.history-transcript-revision[data-revision="0"] .revision-label')?.click();
      return {
        selected: row?.dataset.selectedTranscriptRevision,
        presented: row?.querySelector(":scope > .body")?.textContent,
      };
    })()`);
    if (selectedOriginal.selected !== "0" || selectedOriginal.presented !== LONG_ANDROID_TEXT) {
      throw new Error(`selecting the original did not present that exact revision: ${JSON.stringify(selectedOriginal)}`);
    }
    const copiedOriginal = await evaluate(pageCdp, `(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async (value) => { globalThis.__sidepanelCopiedRevision = value; } },
      });
      document.querySelector(
        '#history .history-message[data-turn-id="turn_android"] .history-transcript-revision .history-copy'
      )?.click();
      return new Promise((resolveCopy) => setTimeout(
        () => resolveCopy(globalThis.__sidepanelCopiedRevision),
        20,
      ));
    })()`);
    if (copiedOriginal !== LONG_ANDROID_TEXT) {
      throw new Error("original transcript revision was not independently copyable");
    }

    console.log(
      `sidepanel smoke passed (REAL extension, headless Chrome for Testing): panel page booted at ${panelUrl}, ` +
        "canonical mixed-surface history hydrated as newest-first outer turn cards with nested user/assistant content on first open, panel reopen, and extension/background restart; " +
        "the active companion identity survived fallback/reopen; newest turns rendered first with speaker order intact, exact user and assistant copy feedback worked, final voice transcript reconciled from storage; " +
        "the retained-audio proxy failed safely, then re-transcribed twice into chronological revisions 0/1/2 with latest selected and older versions copyable; " +
        "a selected voice note prepared a terminal transcript without execution, required explicit confirmation for Switchboard, retained the exact intent receipt across retry and panel reopen; " +
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
