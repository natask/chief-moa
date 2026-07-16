const MAX_ELEMENTS = 100;

function normalizeBrowserSnapshot(snapshot, options = {}) {
  const raw = snapshot && typeof snapshot === "object" ? snapshot : {};
  const elements = Array.isArray(raw.elements) ? raw.elements : [];
  const elementSummaries = Array.isArray(raw.elementSummaries) && raw.elementSummaries.length
    ? raw.elementSummaries.map((item) => String(item || ""))
    : elements.slice(0, MAX_ELEMENTS).map((element) => {
      const type = element.type ? ` ${element.type}` : "";
      const label = element.label ? ` ${element.label}` : "";
      return `[${element.i}] <${element.tag}${type}>${label}`;
    });
  const randomUUID = options.randomUUID || globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
  const now = options.now || (() => new Date());
  return {
    ...raw,
    url: String(raw.url || ""),
    title: String(raw.title || ""),
    pageText: String(raw.pageText || raw.page_text || ""),
    elements,
    snapshotId: raw.snapshotId || raw.snapshot_id || `snap_${randomUUID?.() || now().getTime().toString(36)}`,
    viewport: raw.viewport && typeof raw.viewport === "object" ? raw.viewport : null,
    capturedAt: raw.capturedAt || raw.captured_at || now().toISOString(),
    elementSummaries,
  };
}

function browserTurnClient(deviceId, input) {
  return {
    platform: "browser",
    source: "agee-extension",
    device_id: deviceId,
    input,
  };
}

function browserEvidencePage(snapshot) {
  return {
    url: snapshot.url || "",
    title: snapshot.title || "",
    snapshot_id: snapshot.snapshotId || "",
    captured_at: snapshot.capturedAt || "",
    viewport: snapshot.viewport || null,
  };
}

function browserTurnId(data) {
  return data?.id || data?.turn_id || data?.browser_turn_id || data?.turn?.id || data?.turn?.turn_id || null;
}

function browserTurnStatusPath(data) {
  const raw = data?.status_url || data?.statusUrl || data?.turn?.status_url || data?.turn?.statusUrl || "";
  if (raw) {
    try {
      const url = new URL(raw);
      return `${url.pathname}${url.search || ""}`;
    } catch {
      return String(raw);
    }
  }
  const id = browserTurnId(data);
  return id ? `/v1/browser/turns/${encodeURIComponent(id)}/status` : "";
}

function browserTurnNeedsEvidence(data) {
  const status = String(data?.status || data?.state || data?.turn?.status || "").toLowerCase();
  return status === "needs_evidence";
}

function browserTurnEvidenceRequestId(data) {
  const requests = [
    ...(Array.isArray(data?.evidence_request_ids) ? data.evidence_request_ids : []),
    ...(Array.isArray(data?.turn?.evidence_request_ids) ? data.turn.evidence_request_ids : []),
  ].map((value) => String(value || "").trim()).filter(Boolean);
  return requests[0] || "";
}

function browserTurnReplyText(data) {
  const result = data?.result && typeof data.result === "object" ? data.result : {};
  const turn = data?.turn && typeof data.turn === "object" ? data.turn : {};
  for (const value of [
    data?.display,
    data?.text,
    data?.answer,
    data?.summary,
    result.display,
    result.text,
    result.answer,
    result.summary,
    turn.display,
    turn.text,
    turn.answer,
    turn.summary,
  ]) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function browserTurnActions(data) {
  const result = data?.result && typeof data.result === "object" ? data.result : {};
  return [
    ...(Array.isArray(data?.actions) ? data.actions : []),
    ...(Array.isArray(data?.proposals) ? data.proposals : []),
    ...(Array.isArray(data?.action_proposals) ? data.action_proposals : []),
    ...(Array.isArray(result.actions) ? result.actions : []),
    ...(Array.isArray(result.proposals) ? result.proposals : []),
    ...(Array.isArray(result.action_proposals) ? result.action_proposals : []),
  ];
}

function browserTurnSummary(data) {
  const reply = browserTurnReplyText(data);
  const actions = browserTurnActions(data);
  const actionNotice = actions.length
    ? `Gateway proposed ${actions.length} browser action${actions.length === 1 ? "" : "s"}; not executed in this slice.`
    : "";
  if (reply && actionNotice) return `${reply}\n\n${actionNotice}`;
  if (reply) return reply;
  if (actionNotice) return actionNotice;
  return "The gateway returned an empty browser-agent response.";
}

function browserTurnHasAnswer(data) {
  return Boolean(browserTurnReplyText(data) || browserTurnActions(data).length);
}

function browserTurnIsPending(data) {
  const status = String(data?.status || data?.state || data?.turn?.status || "").toLowerCase();
  return ["", "queued", "pending", "accepted", "created", "running", "working", "started", "processing", "in_progress"].includes(status)
    && !browserTurnHasAnswer(data);
}

function browserTurnFailed(data) {
  const status = String(data?.status || data?.state || data?.turn?.status || "").toLowerCase();
  return ["error", "failed", "cancelled", "canceled"].includes(status);
}

export {
  browserEvidencePage,
  browserTurnActions,
  browserTurnClient,
  browserTurnEvidenceRequestId,
  browserTurnFailed,
  browserTurnHasAnswer,
  browserTurnId,
  browserTurnIsPending,
  browserTurnNeedsEvidence,
  browserTurnReplyText,
  browserTurnStatusPath,
  browserTurnSummary,
  normalizeBrowserSnapshot,
};
