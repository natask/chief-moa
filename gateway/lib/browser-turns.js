"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { browserTurnStatusUrl } = require("./browser-evidence");
const { sanitizeLooseId } = require("./input-utils");

const NEEDS_EVIDENCE_DISPLAY = "I need page evidence from the browser extension before I can answer this page question.";

function browserNeedsEvidenceRecord(record) {
  return {
    ...record,
    status: "needs_evidence",
    classification: "browser_page_question",
    response: {
      display: NEEDS_EVIDENCE_DISPLAY,
      text: NEEDS_EVIDENCE_DISPLAY,
      speak: "",
      actions: [],
    },
  };
}

function createBrowserTurnLifecycle({ answerBrowserEvidence, now = () => new Date().toISOString() }) {
  if (typeof answerBrowserEvidence !== "function") throw new TypeError("answerBrowserEvidence is required");
  return {
    async completeBrowserTurnRecord(record, options = {}) {
      const completedAt = options.completedAt || record.completed_at || now();
      const response = await answerBrowserEvidence(record);
      return {
        ...record,
        status: "completed",
        classification: "browser_page_question",
        completed_at: completedAt,
        updated_at: record.updated_at || completedAt,
        response,
      };
    },
  };
}

function browserLifecyclePayload(record, options = {}) {
  const response = record.response || {};
  const display = String(response.display || response.text || "");
  const speak = String(response.speak || "");
  return {
    id: record.id,
    turn_id: record.turn_id || record.id,
    session_id: record.session_id,
    conversation_id: record.conversation_id,
    branch_id: record.branch_id,
    source: record.source || "",
    device_id: record.device_id || "",
    client: record.client || {},
    modality: record.modality || "text",
    transcript: record.transcript || "",
    text: display || String(record.text || ""),
    display,
    speak,
    page_ref: record.page_ref || {},
    evidence_refs: arrayOrEmpty(record.evidence_refs),
    evidence_summary: record.evidence_summary || null,
    status: record.status,
    broker_event_id: record.broker_event_id || "",
    route_decision_id: record.route_decision_id || "",
    classification: record.classification || "browser_page_question",
    action: record.classification || "browser_page_question",
    status_url: record.status_url || browserTurnStatusUrl(record.id),
    task_ids: arrayOrEmpty(record.task_ids),
    agent_run_ids: arrayOrEmpty(record.agent_run_ids),
    evidence_request_ids: arrayOrEmpty(record.evidence_request_ids),
    proposal_ids: arrayOrEmpty(record.proposal_ids),
    actions: arrayOrEmpty(record.actions),
    browser_turn: summarizeBrowserTurn(record),
    follow_up_expected: record.status === "needs_evidence",
    end_of_turn: record.status !== "needs_evidence",
    legacy_surface: options.legacy || undefined,
  };
}

function browserTurnHttpStatus(record) {
  return record.status === "needs_evidence" ? 202 : record.status === "failed" ? 500 : 200;
}

function summarizeBrowserTurn(record) {
  return {
    id: record.id,
    turn_id: record.turn_id || record.id,
    session_id: record.session_id,
    conversation_id: record.conversation_id,
    branch_id: record.branch_id,
    modality: record.modality,
    status: record.status,
    classification: record.classification,
    page_ref: record.page_ref || {},
    evidence_request_ids: arrayOrEmpty(record.evidence_request_ids),
    evidence_refs: arrayOrEmpty(record.evidence_refs),
    task_ids: arrayOrEmpty(record.task_ids),
    agent_run_ids: arrayOrEmpty(record.agent_run_ids),
    proposal_ids: arrayOrEmpty(record.proposal_ids),
    created_at: record.created_at,
    updated_at: record.updated_at,
    completed_at: record.completed_at || "",
    deleted_at: record.deleted_at || "",
  };
}

function createBrowserTurnStore({ turnsDir, evidenceDir }) {
  if (!turnsDir || !evidenceDir) throw new TypeError("turnsDir and evidenceDir are required");
  for (const dir of [turnsDir, evidenceDir]) fs.mkdirSync(dir, { recursive: true });

  const turnPath = (id) => path.join(turnsDir, `${requiredId(id)}.json`);
  const evidencePath = (id) => path.join(evidenceDir, `${requiredId(id)}.json`);

  function readRecord(id, fileFor) {
    const safe = sanitizeLooseId(id);
    if (!safe) return null;
    try {
      return JSON.parse(fs.readFileSync(fileFor(safe), "utf8"));
    } catch {
      return null;
    }
  }

  function writeRecord(record, fileFor) {
    const filePath = fileFor(record.id);
    const tmpPath = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(record, null, 2));
    fs.renameSync(tmpPath, filePath);
  }

  function listAllBrowserTurns() {
    if (!fs.existsSync(turnsDir)) return [];
    const records = [];
    for (const name of fs.readdirSync(turnsDir)) {
      if (!name.endsWith(".json")) continue;
      try {
        const record = JSON.parse(fs.readFileSync(path.join(turnsDir, name), "utf8"));
        if (record?.id) records.push(record);
      } catch {
        // Skip unreadable records; one corrupt record must not hide the rest.
      }
    }
    records.sort((a, b) => String(b.updated_at || b.created_at || "").localeCompare(String(a.updated_at || a.created_at || "")));
    return records;
  }

  return {
    readBrowserTurnRecord: (id) => readRecord(id, turnPath),
    writeBrowserTurnRecord: (record) => writeRecord(record, turnPath),
    listAllBrowserTurns,
    findBrowserTurnByEvidenceRequestId(id) {
      const safe = sanitizeLooseId(id);
      if (!safe) return null;
      return listAllBrowserTurns().find((turn) => arrayOrEmpty(turn.evidence_request_ids).includes(safe)) || null;
    },
    readBrowserEvidenceRecord: (id) => readRecord(id, evidencePath),
    writeBrowserEvidenceRecord: (record) => writeRecord(record, evidencePath),
  };
}

function requiredId(id) {
  const safe = sanitizeLooseId(id);
  if (!safe) throw new Error("conversation_id is invalid");
  return safe;
}

function arrayOrEmpty(value) { return Array.isArray(value) ? value : []; }

module.exports = {
  browserLifecyclePayload,
  browserNeedsEvidenceRecord,
  browserTurnHttpStatus,
  createBrowserTurnLifecycle,
  createBrowserTurnStore,
  summarizeBrowserTurn,
};
