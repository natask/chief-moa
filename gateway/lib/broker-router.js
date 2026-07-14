"use strict";

const { normalizeSpeech } = require("./voice-intent");

function createBrokerRouter({ listSessions, listProjects, listAgentRuns, isTerminalRunStatus, randomId, sanitizeOptionalId }) {
  for (const dependency of [listSessions, listProjects, listAgentRuns, isTerminalRunStatus, randomId, sanitizeOptionalId]) {
    if (typeof dependency !== "function") throw new TypeError("broker router dependencies must be functions");
  }

  function decision({ targetType, targetId, action, confidence, reason, contextRefs, cancellation }) {
    return {
      id: randomId("route"),
      target_type: targetType,
      target_id: String(targetId || ""),
      action,
      confidence: Math.max(0, Math.min(Number(confidence || 0), 1)),
      reason,
      context_refs: contextRefs || [],
      cancellation_behavior: cancellation || "none",
      created_at: new Date().toISOString(),
    };
  }

  function routeDecisions(event, body = {}) {
    const decisions = [];
    const text = String(event.text || "");
    const lower = normalizeSpeech(text);
    const explicitSessionId = event.session_id;
    const explicitProjectId = event.project_id;
    const explicitRunId = body.agent_run_id ? sanitizeOptionalId(body.agent_run_id, "") : "";

    for (const session of listSessions()) {
      const score = explicitSessionId && session.session_id === explicitSessionId
        ? 0.98
        : textOverlapScore(text, `${session.latest_transcript || ""} ${session.session_id || ""} ${session.branch_id || ""}`);
      if (score < 0.18) continue;
      const explicit = explicitSessionId && session.session_id === explicitSessionId;
      decisions.push(decision({
        targetType: "session",
        targetId: session.session_id,
        action: "continue_session",
        confidence: score,
        reason: explicit ? "message carried this session_id" : "message overlaps recent session transcript",
        contextRefs: [{ type: "session", id: session.session_id, branch_id: session.branch_id }],
        cancellation: "none",
      }));
    }

    for (const project of listProjects()) {
      const score = explicitProjectId && project.id === explicitProjectId
        ? 0.98
        : textOverlapScore(text, `${project.name || ""} ${project.id || ""}`);
      if (score < 0.2) continue;
      const explicit = explicitProjectId && project.id === explicitProjectId;
      decisions.push(decision({
        targetType: "project",
        targetId: project.id,
        action: "attach_project_context",
        confidence: score,
        reason: explicit ? "message carried this project_id" : "message overlaps a known project name",
        contextRefs: [{ type: "project", id: project.id }],
        cancellation: "none",
      }));
    }

    const activeRuns = listAgentRuns().filter((run) => run.active || !isTerminalRunStatus(run.status)).slice(0, 25);
    const broadcast = body.fanout_all_active === true
      || /\b(?:all|every)\b[^.]*\b(?:active|running|open)\b[^.]*\b(?:agent|thread|run|fork)s?\b/.test(lower)
      || /\b(?:tell|update|notify|ask)\s+(?:all|every|the)\b[^.]*\bagents?\b/.test(lower);
    for (const run of activeRuns) {
      const explicit = explicitRunId && run.id === explicitRunId;
      const overlap = textOverlapScore(text, `${run.prompt_preview || ""} ${run.output_preview || ""} ${run.id || ""}`);
      const score = explicit ? 0.99 : overlap;
      if (score >= 0.16) {
        decisions.push(decision({
          targetType: "agent_run",
          targetId: run.id,
          action: "attach_as_evidence",
          confidence: score,
          reason: explicit
            ? "message carried this agent_run_id"
            : broadcast ? "broadcast overlaps this active run's context" : "message overlaps active run context",
          contextRefs: [{ type: "agent_run", id: run.id }],
          cancellation: "none",
        }));
      } else if (broadcast) {
        decisions.push(decision({
          targetType: "agent_run",
          targetId: run.id,
          action: "dismiss_irrelevant",
          confidence: 0.1,
          reason: "broadcast to active agents did not match this run; left running unchanged as a no-op",
          contextRefs: [{ type: "agent_run", id: run.id }],
          cancellation: "none",
        }));
      }
    }

    const workflow = workflowRecommendation(lower);
    if (workflow) {
      decisions.push(decision({
        targetType: "workflow",
        targetId: workflow.id,
        action: "invoke_workflow",
        confidence: workflow.confidence,
        reason: workflow.reason,
        contextRefs: [{ type: "broker_event", id: event.id }],
        cancellation: "none",
      }));
    }

    if (!decisions.length || looksLikeNewWork(lower)) {
      const noMatches = decisions.length === 0;
      decisions.push(decision({
        targetType: "session",
        targetId: event.session_id || randomId("session"),
        action: "create_new_fork",
        confidence: noMatches ? 0.62 : 0.48,
        reason: noMatches ? "no strong existing session/project/run match" : "message appears to start a distinct line of work",
        contextRefs: [{ type: "broker_event", id: event.id }],
        cancellation: "none",
      }));
    }

    const dismissals = decisions.filter((item) => item.action === "dismiss_irrelevant").slice(0, 25);
    const primary = decisions
      .filter((item) => item.action !== "dismiss_irrelevant")
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 12);
    return [...primary, ...dismissals];
  }

  return { decision, routeDecisions };
}

function workflowRecommendation(lower) {
  if (/\b(?:research|search online|look up|landscape|compare|comparison|report|explore|find the best|most optimal|optimal path)\b/.test(lower)) {
    return { id: "landscape-research", confidence: 0.82, reason: "message asks for research/search/comparison/report workflow" };
  }
  if (/\b(?:qa|smoke|test|tests|testing|verify|verification|validate|validation|regression)\b/.test(lower)) {
    return { id: "qa", confidence: 0.78, reason: "message asks for testing, validation, smoke, or QA workflow" };
  }
  if (/\b(?:design|ui|ux|frontend|visual|layout|screen|component)\b/.test(lower)) {
    return { id: "design", confidence: 0.74, reason: "message asks for design, frontend, or visual workflow" };
  }
  if (/\b(?:fix|build|implement|code|bug|test|deploy|commit)\b/.test(lower)) {
    return { id: "coding", confidence: 0.72, reason: "message asks for implementation or verification work" };
  }
  if (/\b(?:write|rewrite|edit|draft|copy|essay|post|email)\b/.test(lower)) {
    return { id: "writing", confidence: 0.68, reason: "message asks for writing or editing workflow" };
  }
  return null;
}

function looksLikeNewWork(lower) {
  return /\b(?:start|new|another|different|fork|separate|also|besides)\b/.test(lower);
}

function textOverlapScore(a, b) {
  const left = meaningfulTokens(a);
  const right = meaningfulTokens(b);
  if (!left.length || !right.length) return 0;
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  let hits = 0;
  for (const token of leftSet) if (rightSet.has(token)) hits += 1;
  return hits / Math.max(4, Math.min(leftSet.size, rightSet.size));
}

function meaningfulTokens(text) {
  const stop = new Set(["the", "and", "that", "this", "with", "for", "you", "have", "from", "into", "should", "could", "would", "message", "messages"]);
  return normalizeSpeech(text)
    .split(/[^a-z0-9_-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !stop.has(token))
    .slice(0, 120);
}

module.exports = {
  createBrokerRouter,
  looksLikeNewWork,
  meaningfulTokens,
  textOverlapScore,
  workflowRecommendation,
};
