const CONFIRMATION_TTL_MS = 2 * 60 * 1000;
const OPERATIONS = new Set(["remember", "delete", "open", "search_open"]);

function boundedText(value, max) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function canonicalDetails(input = {}) {
  const operation = boundedText(input.operation, 20).toLowerCase();
  if (!OPERATIONS.has(operation)) throw new Error("unsupported media confirmation operation");
  const details = {
    operation,
    label: boundedText(input.label, 120),
    note: boundedText(input.note, 1000),
    video_id: boundedText(input.video_id, 11),
    position_seconds: Number.isFinite(input.position_seconds) ? Math.max(0, Math.floor(input.position_seconds)) : 0,
    bookmark_id: boundedText(input.bookmark_id, 120),
    query: boundedText(input.query, 200),
    title: boundedText(input.title, 160),
    channel: boundedText(input.channel, 120),
    disclosure: boundedText(input.disclosure, 1600),
  };
  const validIdentity = operation === "search_open"
    ? Boolean(details.query && details.title && !details.video_id)
    : /^[A-Za-z0-9_-]{11}$/.test(details.video_id);
  if (!details.disclosure || !validIdentity) {
    throw new Error("media confirmation requires bounded disclosure and video identity");
  }
  return details;
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function createMediaConfirmationRuntime({ chromeApi = chrome, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout, digestDetails = sha256 } = {}) {
  const pending = new Map();
  const windowToId = new Map();
  const pageUrl = chromeApi.runtime.getURL("media-confirm.html");

  async function confirm(input) {
    const details = canonicalDetails(input);
    const id = `mc_${crypto.randomUUID()}`;
    const expiresAt = now() + CONFIRMATION_TTL_MS;
    const digest = await digestDetails({ id, expires_at: expiresAt, details });
    return new Promise(async (resolve) => {
      const record = { id, digest, details, expiresAt, resolve, timer: null, windowId: null };
      record.timer = setTimer(() => settle(record, false), CONFIRMATION_TTL_MS);
      pending.set(id, record);
      try {
        const created = await chromeApi.windows.create({
          url: `${pageUrl}#${id}`,
          type: "popup",
          focused: true,
          width: 480,
          height: 620,
        });
        record.windowId = created?.id ?? null;
        if (record.windowId != null) windowToId.set(record.windowId, id);
      } catch {
        settle(record, false);
      }
    });
  }

  function settle(record, allowed) {
    if (!record || pending.get(record.id) !== record) return;
    pending.delete(record.id);
    if (record.windowId != null) windowToId.delete(record.windowId);
    clearTimer(record.timer);
    record.resolve(allowed === true);
  }

  function trustedPageSender(sender) {
    try {
      const url = new URL(sender?.url || "");
      const expected = new URL(pageUrl);
      return sender?.id === chromeApi.runtime.id
        && url.protocol === expected.protocol
        && url.host === expected.host
        && url.pathname === "/media-confirm.html";
    } catch {
      return false;
    }
  }

  function details(sender, message) {
    if (!trustedPageSender(sender)) return { ok: false, reason: "untrusted_confirmation_surface" };
    const record = pending.get(String(message?.id || ""));
    if (!record || now() >= record.expiresAt) {
      if (record) settle(record, false);
      return { ok: false, reason: "confirmation_missing_or_expired" };
    }
    return { ok: true, id: record.id, digest: record.digest, expires_at: new Date(record.expiresAt).toISOString(), details: record.details };
  }

  function decide(sender, message) {
    if (!trustedPageSender(sender)) return { ok: false, reason: "untrusted_confirmation_surface" };
    const record = pending.get(String(message?.id || ""));
    if (!record || now() >= record.expiresAt || message?.digest !== record.digest) {
      if (record && now() >= record.expiresAt) settle(record, false);
      return { ok: false, reason: "confirmation_missing_expired_or_changed" };
    }
    const allowed = message?.decision === "allow";
    if (!allowed && message?.decision !== "cancel") return { ok: false, reason: "invalid_decision" };
    settle(record, allowed);
    return { ok: true, allowed };
  }

  chromeApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.cmd === "mediaConfirmationDetails") {
      sendResponse(details(sender, message));
      return false;
    }
    if (message?.cmd === "mediaConfirmationDecision") {
      sendResponse(decide(sender, message));
      return false;
    }
    return false;
  });
  chromeApi.windows.onRemoved.addListener((windowId) => {
    const record = pending.get(windowToId.get(windowId));
    if (record) settle(record, false);
  });

  return Object.freeze({ confirm, details, decide, pendingCount: () => pending.size });
}

export { CONFIRMATION_TTL_MS, canonicalDetails, createMediaConfirmationRuntime };
