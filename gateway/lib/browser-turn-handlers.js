"use strict";

function createBrowserTurnHandlers(deps) {
  const {
    authorized, sendJson, readJsonBody, browserAgentRoleCatalog, browserTurnStore,
    browserTurns, browserTurnModality, browserTurnInputText, buildBrowserTurnRecord,
    cleanError, browserEvidenceSummaryFromBody, sanitizeOptionalId, randomId,
    sanitizeLooseId, sanitizeBrowserClientMetadata, mergeBrowserPageRefs,
    browserPageRefFromBody, sanitizeBrowserScreenshot, browserTurnLifecycle,
    mergeBrowserEvidenceSummaries, attachBrowserRoleExecution,
  } = deps;
  const now = typeof deps.now === "function" ? deps.now : () => new Date().toISOString();

  async function routeBrowserTurns(request, response, url) {
    const path = url.pathname;
    const roles = path === "/v1/browser/roles" && request.method === "GET";
    const create = path === "/v1/browser/turns" && request.method === "POST";
    const evidence = path === "/v1/browser/evidence" && request.method === "POST";
    const status = request.method === "GET" && path.startsWith("/v1/browser/turns/") && path.endsWith("/status");
    if (!(roles || create || evidence || status)) return false;
    if (!authorized(request)) {
      sendJson(response, 401, { error: "missing or invalid gateway token" });
      return true;
    }
    if (roles) sendJson(response, 200, browserAgentRoleCatalog());
    else if (create) await handleBrowserTurn(request, response);
    else if (evidence) await handleBrowserEvidence(request, response);
    else {
      const id = decodeURIComponent(path.slice("/v1/browser/turns/".length, -"/status".length));
      const record = browserTurnStore.readBrowserTurnRecord(id);
      if (!record) sendJson(response, 404, { error: "browser turn not found" });
      else sendJson(response, 200, browserTurns.browserLifecyclePayload(record));
    }
    return true;
  }

  async function handleBrowserTurn(request, response) {
    const body = await readJsonBody(request);
    await handleBrowserTurnBody(response, body, { modality: browserTurnModality(body), legacy: "browser" });
  }

  async function handleBrowserTurnBody(response, body, options = {}) {
    const text = browserTurnInputText(body);
    if (!text) { sendJson(response, 400, { error: "text or transcript is required" }); return; }
    let record;
    try { record = await buildBrowserTurnRecord(body, { modality: options.modality || browserTurnModality(body) }); }
    catch (error) { sendJson(response, 400, { error: cleanError(error) }); return; }
    browserTurnStore.writeBrowserTurnRecord(record);
    sendJson(response, browserTurns.browserTurnHttpStatus(record), browserTurns.browserLifecyclePayload(record, { legacy: options.legacy }));
  }

  async function handleBrowserEvidence(request, response) {
    const body = await readJsonBody(request);
    const requestedTurnId = String(body.turn_id || body.browser_turn_id || body.browserTurnId || "").trim();
    const requestedEvidenceRequestId = String(body.evidence_request_id || body.request_id || body.requestId || "").trim();
    if (!requestedTurnId && !requestedEvidenceRequestId) {
      sendJson(response, 400, { error: "turn_id or evidence_request_id is required" }); return;
    }
    const turn = requestedTurnId
      ? browserTurnStore.readBrowserTurnRecord(requestedTurnId)
      : browserTurnStore.findBrowserTurnByEvidenceRequestId(requestedEvidenceRequestId);
    if (!turn) { sendJson(response, 404, { error: "browser turn not found" }); return; }
    const summary = browserEvidenceSummaryFromBody(body);
    if (!summary.visible_text && !summary.source_ref && !summary.context_scope) {
      sendJson(response, 400, { error: "evidence or screen visible text is required" }); return;
    }
    const timestamp = now();
    const evidence = {
      id: sanitizeOptionalId(body.evidence_id || body.id, randomId("evidence")),
      turn_id: turn.id,
      evidence_request_id: requestedEvidenceRequestId
        ? sanitizeLooseId(requestedEvidenceRequestId)
        : String((turn.evidence_request_ids || [])[0] || ""),
      session_id: turn.session_id, conversation_id: turn.conversation_id, branch_id: turn.branch_id,
      source: String(body.source || body.client?.source || "browser-extension").slice(0, 80),
      client: sanitizeBrowserClientMetadata(body.client),
      page_ref: mergeBrowserPageRefs(turn.page_ref, summary.page_ref, browserPageRefFromBody(body)),
      screenshot: sanitizeBrowserScreenshot(body.screenshot), summary, created_at: timestamp,
    };
    browserTurnStore.writeBrowserEvidenceRecord(evidence);
    const evidenceRefs = Array.from(new Set([].concat(turn.evidence_refs || [], evidence.id).filter(Boolean)));
    let completed = await browserTurnLifecycle.completeBrowserTurnRecord({
      ...turn,
      page_ref: mergeBrowserPageRefs(turn.page_ref, evidence.page_ref),
      evidence_refs: evidenceRefs,
      evidence_summary: mergeBrowserEvidenceSummaries(turn.evidence_summary, summary),
      updated_at: timestamp,
    }, { completedAt: timestamp });
    completed = attachBrowserRoleExecution(completed);
    browserTurnStore.writeBrowserTurnRecord(completed);
    sendJson(response, 200, { ...browserTurns.browserLifecyclePayload(completed), evidence });
  }

  return { routeBrowserTurns, handleBrowserTurn, handleBrowserTurnBody, handleBrowserEvidence };
}

module.exports = { createBrowserTurnHandlers };
