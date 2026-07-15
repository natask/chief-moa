const fs = require("node:fs");
const path = require("node:path");

const MODES = Object.freeze(["ask", "note", "coach"]);
const DEFAULT_VERSION = "voice_mode_default";
const COACH_OVERLAY = [
  "Coach delivery mode applies to this turn only; preserve the saved persona and identity.",
  "Respond with concise, practical coaching: reflect the user's point, identify one useful next step, and ask at most one focused question.",
  "Do not claim that Coach mode changed the saved persona.",
].join(" ");

function normalizeDeviceId(value) {
  return String(value || "").trim().replace(/[^a-zA-Z0-9._:-]/g, "-").slice(0, 160);
}

function normalizeMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  if (!MODES.includes(mode)) throw new Error(`mode must be one of: ${MODES.join(", ")}`);
  return mode;
}

function routingFor(mode) {
  if (mode === "note") {
    return Object.freeze({
      response_policy: "none",
      provider_work_allowed: false,
      storage_policy: "audio_note",
      assistant_reply_allowed: false,
      agent_launch_allowed: false,
      capture_endpoint: "/v1/audio-notes",
    });
  }
  return Object.freeze({
    response_policy: mode === "coach" ? "coach" : "normal",
    provider_work_allowed: true,
    storage_policy: "conversation_turn",
    assistant_reply_allowed: true,
    agent_launch_allowed: true,
  });
}

function createVoiceModeStore({ dataDir, now = () => new Date().toISOString() }) {
  const filePath = path.join(dataDir, "voice-delivery-modes.json");

  function readState() {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (parsed?.schema_version === 1 && parsed.devices && typeof parsed.devices === "object") return parsed;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return { schema_version: 1, devices: {} };
  }

  function writeState(state) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, filePath);
  }

  function requireDeviceId(value) {
    const deviceId = normalizeDeviceId(value);
    if (!deviceId) throw new Error("device_id is required");
    return deviceId;
  }

  function current(deviceIdInput) {
    const deviceId = requireDeviceId(deviceIdInput);
    const device = readState().devices[deviceId];
    const record = device?.versions?.find((item) => item.version === device.current_version);
    return record || { mode: "ask", version: DEFAULT_VERSION, sequence: 0, created_at: null, source: "default" };
  }

  function set(deviceIdInput, modeInput, metadata = {}) {
    const deviceId = requireDeviceId(deviceIdInput);
    const mode = normalizeMode(modeInput);
    const state = readState();
    const device = state.devices[deviceId] || { current_version: DEFAULT_VERSION, versions: [] };
    const previous = current(deviceId);
    if (previous.mode === mode) return previous;
    const sequence = device.versions.length + 1;
    const record = {
      mode,
      version: `voice_mode_v${String(sequence).padStart(4, "0")}`,
      sequence,
      created_at: now(),
      source: String(metadata.source || "api").slice(0, 80),
      reason: String(metadata.reason || "").slice(0, 240),
      parent_version: previous.version,
    };
    device.versions.push(record);
    device.current_version = record.version;
    state.devices[deviceId] = device;
    writeState(state);
    return record;
  }

  function admit(deviceId) {
    const record = current(deviceId);
    return Object.freeze({ ...record, routing: routingFor(record.mode) });
  }

  function applyToProfile(profile, admission) {
    const copy = { ...profile };
    if (admission?.mode === "coach") {
      copy.system_prompt = [String(profile?.system_prompt || "").trim(), COACH_OVERLAY].filter(Boolean).join("\n\n");
    }
    return copy;
  }

  function versions(deviceIdInput) {
    const deviceId = requireDeviceId(deviceIdInput);
    return [...(readState().devices[deviceId]?.versions || [])];
  }

  return { admit, applyToProfile, current, set, versions };
}

function createVoiceModeHandlers({ store, authorized, readJsonBody, sendJson }) {
  function payload(deviceId) {
    const admission = store.admit(deviceId);
    return { device_id: normalizeDeviceId(deviceId), mode: admission.mode, version: admission.version, routing: admission.routing };
  }
  return async function handle(request, response, url) {
    if (!url.pathname.startsWith("/v1/voice/mode")) return false;
    if (!authorized(request)) {
      sendJson(response, 401, { error: "missing or invalid gateway token" });
      return true;
    }
    try {
      if (url.pathname === "/v1/voice/mode" && request.method === "GET") {
        sendJson(response, 200, payload(url.searchParams.get("device_id")));
        return true;
      }
      if (url.pathname === "/v1/voice/mode" && request.method === "PUT") {
        const body = await readJsonBody(request);
        store.set(body.device_id, body.mode, { source: body.source, reason: body.reason });
        sendJson(response, 200, payload(body.device_id));
        return true;
      }
      if (url.pathname === "/v1/voice/mode/versions" && request.method === "GET") {
        const deviceId = url.searchParams.get("device_id");
        sendJson(response, 200, { ...payload(deviceId), versions: store.versions(deviceId) });
        return true;
      }
      sendJson(response, 405, { error: "method not allowed" });
    } catch (error) {
      sendJson(response, 400, { error: error.message });
    }
    return true;
  };
}

module.exports = { COACH_OVERLAY, MODES, createVoiceModeHandlers, createVoiceModeStore, routingFor };
