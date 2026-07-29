"use strict";

const { workerBaseDrift } = require("./worker-base-binding");

const DEPLOYMENT_OPERATIONS = new Set(["preview", "apply", "rollback"]);

function createWorkHistoryHandlers(deps) {
  const {
    workHistory,
    intentWorkflow,
    modificationCoordinator,
    semanticTelemetry,
    parseWorkHistoryIntent,
    authorized,
    deploymentPrincipal,
    requireDeploymentPrincipal,
    accountUserId,
    readJsonBody,
    sendJson,
    cleanError,
    sanitizeOptionalId,
    randomId,
    storeBrokerMessage,
    truncate,
    listAllAgentRuns,
    createToolRequest,
    recordToolRequestProductEvent,
    emitPreviewTelemetry,
  } = deps;

  async function routeWorkHistory(request, response, url) {
    const method = request.method;
    const pathname = url.pathname;
    try {
      const candidateEvidencePath = pathname.match(/^\/v1\/work-history\/modification-requests\/([^/]+)\/candidate-evidence$/);
      if (!authorized(request) && !pathname.startsWith("/v1/work-history/deployments")
          && !(candidateEvidencePath && deploymentPrincipal(request, "preview"))) {
        sendJson(response, 403, { error: "scoped deployment credentials cannot access general work-history actions" });
        return true;
      }
      if (method === "POST" && candidateEvidencePath) {
        const owner = authorized(request);
        const worker = owner ? null : deploymentPrincipal(request, "preview");
        if (!owner && !worker) throw new Error("owner or preview worker authority is required");
        const coordinator = modificationCoordinator?.();
        if (!coordinator?.admitCandidate) throw new Error("modification coordinator is unavailable");
        const status = await coordinator.admitCandidate(
          decodeURIComponent(candidateEvidencePath[1]), await readJsonBody(request),
          owner ? { kind: "owner", id: accountUserId() } : worker.actor,
        );
        sendJson(response, 201, { status });
        return true;
      }
      if (method === "POST" && pathname === "/v1/work-history/turns") {
        await handleWorkHistoryTurn(request, response);
        return true;
      }
      if (method === "GET" && pathname === "/v1/work-history/status") {
        sendJson(response, 200, await workHistory.statusSummary());
        return true;
      }
      if (method === "GET" && pathname === "/v1/work-history/telemetry") {
        sendJson(response, 200, await semanticTelemetry.query({
          limit: url.searchParams.get("limit"), name: url.searchParams.get("name"), outcome: url.searchParams.get("outcome"),
        }));
        return true;
      }
      if (method === "GET" && pathname === "/v1/work-history/tasks") {
        const summary = await workHistory.statusSummary();
        sendJson(response, 200, { tasks: summary.tasks });
        return true;
      }
      const taskMatch = pathname.match(/^\/v1\/work-history\/tasks\/([^/]+)$/);
      if (method === "GET" && taskMatch) {
        const detail = await workHistory.taskDetail(decodeURIComponent(taskMatch[1]));
        sendJson(response, detail ? 200 : 404, detail || { error: "work task not found" });
        return true;
      }
      if (method === "POST" && pathname === "/v1/work-history/runs") {
        const body = await readJsonBody(request);
        const run = await workHistory.queueRun({ ...body, actor: body.actor || { kind: "user", id: body.source || "api" } });
        sendJson(response, 202, { run });
        return true;
      }
      if (method === "POST" && pathname === "/v1/work-history/runs/claim") {
        const body = await readJsonBody(request);
        if (!body.run_id) {
          const summary = await workHistory.statusSummary();
          let pinnedQueued = false;
          for (const queued of summary.queued || []) {
            const detail = await workHistory.runDetail(queued.run_id);
            if (detail?.run?.workspace_base?.ref && detail.run.workspace_base.commit) {
              pinnedQueued = true;
              continue;
            }
            body.run_id = queued.run_id;
            break;
          }
          if (!body.run_id && pinnedQueued) throw new Error("run_id, base_ref, and resolved_base_commit are required to claim pinned modification work");
        }
        if (body.run_id) {
          const detail = await workHistory.runDetail(body.run_id);
          const drift = workerBaseDrift(detail?.run, body);
          if (drift) {
            await workHistory.appendRunEvent({ run_id: body.run_id, type: "run.failed", summary: drift, worker_id: body.worker_id });
            if (detail?.run?.task_id) await workHistory.setTaskStatus(detail.run.task_id, "blocked", drift);
            throw new Error(drift);
          }
        }
        const result = await workHistory.claimRun(body);
        sendJson(response, result.run ? 200 : 204, result.run ? result : {});
        return true;
      }
      const runActionMatch = pathname.match(/^\/v1\/work-history\/runs\/([^/]+)\/(events|snapshots|diffs|verifications)$/);
      if (method === "POST" && runActionMatch) {
        const input = { ...(await readJsonBody(request)), run_id: decodeURIComponent(runActionMatch[1]) };
        const actions = {
          events: ["event", "appendRunEvent"], snapshots: ["snapshot", "recordSnapshot"],
          diffs: ["diff", "recordDiff"], verifications: ["verification", "recordVerification"],
        };
        const [key, operation] = actions[runActionMatch[2]];
        sendJson(response, 201, { [key]: await workHistory[operation](input) });
        return true;
      }
      const runMatch = pathname.match(/^\/v1\/work-history\/runs\/([^/]+)$/);
      if (method === "GET" && runMatch) {
        const detail = await workHistory.runDetail(decodeURIComponent(runMatch[1]));
        sendJson(response, detail ? 200 : 404, detail || { error: "work run not found" });
        return true;
      }
      if (method === "POST" && pathname === "/v1/work-history/feedback") {
        sendJson(response, 201, await workHistory.attachFeedback(await readJsonBody(request)));
        return true;
      }
      if (method === "POST" && pathname === "/v1/work-history/controls/claim") {
        sendJson(response, 200, await workHistory.claimControlRequest(await readJsonBody(request)));
        return true;
      }
      const receiptMatch = pathname.match(/^\/v1\/work-history\/controls\/([^/]+)\/receipt$/);
      if (method === "POST" && receiptMatch) {
        sendJson(response, 200, await workHistory.receiptControlRequest({
          ...(await readJsonBody(request)), control_id: decodeURIComponent(receiptMatch[1]),
        }));
        return true;
      }
      if (method === "GET" && pathname === "/v1/work-history/deployments") {
        if (!authorized(request)) throw new Error("scoped deployment credentials cannot list broad deployment history");
        sendJson(response, 200, await workHistory.deploymentLinks({ target: url.searchParams.get("target") || "" }));
        return true;
      }
      if (method === "POST" && pathname === "/v1/work-history/deployments") {
        const body = await readJsonBody(request);
        const operation = body.mode === "applied" ? "apply" : "preview";
        const principal = requireDeploymentPrincipal(request, operation);
        const deployment = await workHistory.recordDeployment({
          ...body, worker_id: principal.id, applied_by_actor: principal.id, actor: principal.actor,
        });
        if (operation === "preview" && deployment.request_id && deployment.status === "available") {
          emitPreviewTelemetry("preview.available", deployment.request_id, "preview_available", "ok");
        } else if (operation === "preview" && deployment.request_id && deployment.status === "failed") {
          emitPreviewTelemetry("preview.failed", deployment.request_id, "preview_failure", "error");
        }
        sendJson(response, 201, { deployment });
        return true;
      }
      if (method === "POST" && pathname === "/v1/work-history/deployments/requests") {
        if (!authorized(request)) throw new Error("only the authenticated user may request a deployment");
        const body = await readJsonBody(request);
        sendJson(response, 202, { request: await workHistory.requestDeployment({
          ...body, actor: { kind: "user", id: accountUserId() },
        }) });
        return true;
      }
      if (method === "GET" && pathname === "/v1/work-history/deployments/requests") {
        requireDeploymentPrincipal(request, "preview");
        sendJson(response, 200, { requests: await workHistory.pendingApprovedPreviewRequests({ limit: url.searchParams.get("limit") }) });
        return true;
      }
      const deploymentMatch = pathname.match(/^\/v1\/work-history\/deployments\/requests\/([^/]+)(?:\/(review|claim|verification|effect|adopt|receipt))?$/);
      if (deploymentMatch) {
        const requestId = decodeURIComponent(deploymentMatch[1]);
        const action = deploymentMatch[2] || "";
        if (method === "GET" && !action) {
          await readDeploymentRequest(request, response, requestId);
          return true;
        }
        if (method === "POST" && action) {
          await mutateDeploymentRequest(request, response, requestId, action);
          return true;
        }
      }
    } catch (error) {
      const partial = error?.intent_workflow_partial;
      sendJson(response, 400, {
        error: cleanError(error),
        ...(partial ? { intent_workflow_partial: partial } : {}),
      });
      return true;
    }
    sendJson(response, 404, { error: "unknown work-history endpoint" });
    return true;
  }

  async function readDeploymentRequest(request, response, requestId) {
    const user = authorized(request);
    const preview = deploymentPrincipal(request, "preview");
    if (!user && !preview && !deploymentPrincipal(request, "review") && !deploymentPrincipal(request, "apply")) {
      throw new Error("a scoped deployment credential is required");
    }
    const detail = await workHistory.deploymentRequestDetail(requestId);
    if (!detail) {
      sendJson(response, 404, { error: "deployment request not found" });
      return;
    }
    if (!user && preview) {
      const claim = [...(detail.claims || [])].reverse().find((item) => item.operation === "preview");
      if (detail.request?.mode !== "preview" || detail.review?.decision !== "approved"
        || !["preview_claimed", "preview_available", "verification_failed", "verified"].includes(detail.status)
        || claim?.worker_id !== preview.id
        || (claim.lease_expires_at && Date.parse(claim.lease_expires_at) <= Date.now())) {
        throw new Error("preview credential may only read its current approved preview assignment");
      }
      sendJson(response, 200, {
        request: {
          request_id: detail.request.request_id, target: detail.request.target, mode: "preview",
          commit_sha: detail.request.commit_sha, adapter_kind: detail.request.adapter_kind,
          candidate_refs: detail.request.candidate_refs, artifact_refs: detail.request.artifact_refs,
          provenance_ref: detail.request.provenance_ref,
        },
        review: { decision: "approved" }, preview_claim: claim,
        preview_records: detail.preview_records, latest_preview: detail.latest_preview,
        latest_preview_verification: detail.latest_preview_verification, status: detail.status,
      });
      return;
    }
    sendJson(response, 200, detail);
  }

  async function mutateDeploymentRequest(request, response, requestId, action) {
    const body = { ...(await readJsonBody(request)), request_id: requestId };
    if (action === "review") {
      const principal = requireDeploymentPrincipal(request, "review");
      sendJson(response, 200, await workHistory.reviewDeploymentRequest({
        ...body, actor: principal.actor, reviewed_by_actor: principal.id,
      }));
      return;
    }
    const operation = DEPLOYMENT_OPERATIONS.has(body.operation) ? body.operation : (action === "claim" ? "preview" : "apply");
    const principal = requireDeploymentPrincipal(request, operation);
    const controlled = { ...body, worker_id: principal.id, created_by_worker_id: principal.id, actor: principal.actor };
    if (action === "claim") {
      const result = await workHistory.claimDeploymentRequest(controlled);
      if (operation === "preview") emitPreviewTelemetry("preview.claimed", requestId, "preview_claim", "ok");
      sendJson(response, 200, result);
    } else if (action === "verification") {
      const result = await workHistory.recordDeploymentVerification(controlled);
      if (operation === "preview") {
        emitPreviewTelemetry("preview.verification.completed", requestId, "preview_verification", result.status === "passed" ? "ok" : "error");
        if (result.status === "failed") emitPreviewTelemetry("preview.failed", requestId, "preview_failure", "error");
      }
      sendJson(response, 201, result);
    } else if (action === "effect") {
      sendJson(response, 201, await workHistory.observeDeploymentOperationEffect(controlled));
    } else if (action === "adopt") {
      sendJson(response, 200, await workHistory.adoptDeploymentOperationEffect(controlled));
    } else {
      sendJson(response, 200, await workHistory.receiptDeploymentOperation(controlled));
    }
  }

  async function handleWorkHistoryTurn(request, response) {
    const body = await readJsonBody(request);
    const transcript = String(body.transcript || body.text || "").trim();
    if (!transcript) {
      sendJson(response, 400, { error: "transcript or text is required" });
      return;
    }
    const intent = parseWorkHistoryIntent(transcript);
    if (!intent) {
      sendJson(response, 422, { handled: false, error: "no work-history intent recognized; use the normal voice/chat route" });
      return;
    }
    const turnId = sanitizeOptionalId(body.turn_id, randomId("turn"));
    const { stored: brokerEvent } = await storeBrokerMessage(
      { ...body, source: body.source || "work-history-turn" }, truncate(transcript, 16000),
    );
    const result = await executeWorkHistoryIntent(intent, {
      transcript, turnId, brokerEvent,
      sessionId: sanitizeOptionalId(body.session_id || body.conversation_id, ""),
      branchId: sanitizeOptionalId(body.branch_id, "default"), body,
    });
    sendJson(response, result.status_code || 200, {
      handled: true, turn_id: turnId, broker_event_id: brokerEvent.id, intent,
      speak: result.speak, display: result.display || result.speak,
      actions: result.actions || [], refs: result.refs || {},
    });
  }

  async function executeWorkHistoryIntent(intent, context) {
    const { transcript, turnId, brokerEvent, sessionId, branchId, body = {} } = context;
    const topDecision = (brokerEvent?.decisions || [])[0] || null;
    const actor = { kind: "user", id: body.device_id || body.source || "voice" };
    if (intent.kind === "create_work") {
      const objective = intent.objective || transcript;
      const linked = await intentWorkflow.createWork({
        title: firstLine(objective).slice(0, 120),
        statement: transcript,
        objective,
        owner_hint: intent.owner_hint || "",
        wants_run: intent.wants_run !== false,
        completion_criteria: body.completion_criteria,
        acceptance_contract_ref: body.acceptance_contract_ref,
        session_id: sessionId,
        branch_id: branchId,
        project_id: body.project_id || "",
        broker_event_id: brokerEvent?.id || "",
        turn_id: turnId,
        surface: body.source || "work-history-turn",
        harness_hint: body.harness || "",
        route_decision_id: topDecision?.id || "",
        context_pack_ref: topDecision?.context_pack_id || "",
        profile_version: brokerEvent?.profile_version || "",
        actor,
      });
      const { intent: deliveryIntent, task, run, delivery } = linked;
      return {
        status_code: 202,
        speak: run
          ? `Captured intent ${deliveryIntent.intent_id}, created task ${task.task_id}, and queued run ${run.run_id}. It stays queued until a worker claims it.`
          : `Captured intent ${deliveryIntent.intent_id} and created task ${task.task_id}. No run queued yet.`,
        refs: {
          intent_id: deliveryIntent.intent_id,
          intent_revision: deliveryIntent.version,
          acceptance_contract_ref: delivery.acceptance_contract_ref,
          task_id: task.task_id,
          run_id: run?.run_id || "",
          run_status: run?.status || "",
        },
        actions: [{ type: "delivery_intent_recorded", delivery }],
      };
    }
    if (intent.kind === "status_query") {
      const summary = await workHistory.statusSummary();
      const agentRuns = agentRunStatusSummary(listAllAgentRuns());
      const merged = mergeRunStatusSummaries(summary, agentRuns);
      const changedDetail = await workHistoryChangedDetail(intent, summary, workHistory);
      return {
        speak: workHistoryStatusSpeech(intent, merged, changedDetail),
        display: workHistoryStatusDisplay(intent, merged, changedDetail),
        refs: {
          queued_run_ids: merged.queued.map((run) => run.run_id), active_run_ids: merged.active.map((run) => run.run_id),
          blocked_run_ids: merged.blocked.map((run) => run.run_id), failed_run_ids: merged.failed.map((run) => run.run_id),
          agent_run_ids: agentRuns.runs.map((run) => run.run_id),
        },
      };
    }
    if (intent.kind === "feedback") {
      const result = await workHistory.attachFeedback({
        targets: intent.target ? [intent.target] : [], transcript: intent.text || transcript,
        summary: firstLine(intent.text || transcript).slice(0, 300), intent: intent.intent,
        control_action: intent.control_action || "", source_turn_id: turnId,
        source_broker_event_id: brokerEvent?.id || "", actor,
      });
      const targets = result.feedback.target_refs.map((ref) => ref.id).join(", ");
      return {
        status_code: intent.intent === "cancellation" ? 202 : 200,
        speak: intent.intent === "cancellation"
          ? `Queued a ${intent.control_action || "cancel"} request for ${targets}. The owning worker must claim and confirm it; nothing is canceled yet.`
          : `Attached your feedback to ${targets}. The work keeps running.`,
        refs: {
          feedback_id: result.feedback.feedback_id, feedback_status: result.feedback.status,
          control_request_ids: result.control_requests.map((control) => control.control_id),
        },
      };
    }
    if (intent.kind === "deployment_link") {
      const links = await workHistory.deploymentLinks({ target: workHistoryDeploymentTarget(transcript) });
      const parts = [];
      if (links.latest_preview) parts.push(`Latest preview: ${links.latest_preview.preview_url || links.latest_preview.deployment_id} (${links.latest_preview.status}).`);
      if (links.latest_applied) parts.push(`Active: ${links.latest_applied.active_url || links.latest_applied.deployment_id}, applied at ${links.latest_applied.applied_at || links.latest_applied.recorded_at}.`);
      if (!parts.length) parts.push("No deployment records yet. Say 'create a deploy request' to queue one; nothing gets applied without your explicit promotion.");
      return {
        speak: parts.join(" "), refs: {
          latest_preview_id: links.latest_preview?.deployment_id || "", latest_applied_id: links.latest_applied?.deployment_id || "",
          preview_url: links.latest_preview?.preview_url || "", active_url: links.latest_applied?.active_url || "",
        },
      };
    }
    if (intent.kind === "deployment_request") {
      const request = await workHistory.requestDeployment({
        target: workHistoryDeploymentTarget(transcript), mode: "preview",
        run_id: intent.target && intent.target.startsWith("wr_") ? intent.target : "",
        branch: body.branch || "", reason: transcript, source_turn_id: turnId, actor,
      });
      return { status_code: 202, speak: `Queued deployment request ${request.request_id} for ${request.target} as a preview. It will not be applied without your explicit promotion.`, refs: { deployment_request_id: request.request_id } };
    }
    if (intent.kind === "ui_open") {
      const route = await workHistory.resolveUiRoute({ route_kind: intent.route_kind, target: intent.target });
      if (!route) return { status_code: 404, speak: `I could not find a ${intent.route_kind} record to open yet.`, refs: {} };
      let toolRequest = null;
      let queueError = "";
      try {
        toolRequest = createToolRequest({
          tool: "ui.open", target_surface_type: intent.surface || "", source: "work-history-voice",
          session_id: sessionId, branch_id: branchId, instruction: truncate(transcript, 2000),
          input: { route_kind: route.route_kind, route_ref: route.route_ref, safe_url: route.safe_url, created_from_turn_id: turnId },
        });
        await recordToolRequestProductEvent(toolRequest, "queued");
      } catch (error) {
        queueError = cleanError(error);
      }
      const surface = intent.surface === "android" ? "your phone" : intent.surface === "browser_extension" ? "your browser" : "a client";
      return {
        status_code: toolRequest ? 202 : 200,
        speak: toolRequest ? `Asked ${surface} to open the ${route.route_kind} ${route.route_ref}. It opens only after the client claims the request.` : `No client is reachable right now. Open it yourself at ${route.safe_url}.`,
        actions: toolRequest ? [{ type: "ui_open_requested", request_id: toolRequest.id, safe_url: route.safe_url }] : [],
        refs: { tool_request_id: toolRequest?.id || "", route_kind: route.route_kind, route_ref: route.route_ref, safe_url: route.safe_url, queue_error: queueError },
      };
    }
    throw new Error(`unsupported work-history intent: ${intent.kind}`);
  }

  return { routeWorkHistory, handleWorkHistoryTurn, executeWorkHistoryIntent };
}

function firstLine(value) {
  return String(value || "").split(/\r?\n/).find((line) => line.trim())?.trim() || "";
}

function workHistoryDeploymentTarget(transcript) {
  const lower = String(transcript || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (/\bgateway\b/.test(lower)) return "gateway";
  if (/\bandroid|phone\b/.test(lower)) return "android";
  if (/\bextension\b/.test(lower)) return "browser_extension";
  if (/\bwebsite|site\b/.test(lower)) return "website";
  return "";
}

function agentRunStatusSummary(sourceRuns) {
  const runs = [...sourceRuns].sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
  const norm = (run) => ({
    run_id: run.id, status: run.status, worker_id: run.claimed_by_worker_id || "",
    objective: run.prompt_preview || "", latest_summary: run.output_preview || "", blocking_reason: "", source: "agent-runs",
  });
  const bucket = (statuses, limit) => runs.filter((run) => statuses.includes(run.status)).slice(0, limit).map(norm);
  return {
    runs: runs.slice(0, 50).map(norm), queued: bucket(["queued"], 25), active: bucket(["claimed", "running"], 25),
    completed: bucket(["completed"], 5), failed: bucket(["failed", "canceled", "timed-out"], 5),
  };
}

function mergeRunStatusSummaries(summary, agentRuns) {
  return {
    ...summary, queued: [...summary.queued, ...agentRuns.queued], active: [...summary.active, ...agentRuns.active],
    completed: [...summary.completed, ...agentRuns.completed], failed: [...summary.failed, ...agentRuns.failed], runs: [...summary.runs, ...agentRuns.runs],
  };
}

function workHistoryStatusSpeech(intent, summary, changedDetail) {
  if (intent.scope === "changed" && changedDetail) return changedDetail;
  if (intent.scope === "failed") {
    if (!summary.failed.length) return "Nothing has failed.";
    return summary.failed.map((run) => `Run ${run.run_id} ${run.status}: ${run.blocking_reason || run.latest_summary || "no failure detail recorded"}.`).join(" ");
  }
  if (intent.scope === "waiting") {
    const waiting = summary.waiting_on_user.concat(summary.queued);
    if (!waiting.length) return "Nothing is waiting on you.";
    return waiting.map((run) => `Run ${run.run_id}: ${run.blocking_reason || run.status}.`).join(" ");
  }
  const parts = [];
  if (summary.active.length) parts.push(`Active: ${summary.active.map((run) => spokenRun(run)).join("; ")}.`);
  if (summary.queued.length) parts.push(`Queued: ${summary.queued.map((run) => spokenRun(run)).join("; ")}.`);
  if (summary.blocked.length) parts.push(`Blocked: ${summary.blocked.map((run) => spokenRun(run, run.blocking_reason)).join("; ")}.`);
  if (intent.scope !== "running") {
    if (summary.completed.length) parts.push(`Recently completed: ${summary.completed.map((run) => spokenRun(run)).join("; ")}.`);
    if (summary.failed.length) parts.push(`Failed or canceled: ${summary.failed.map((run) => spokenRun(run, run.blocking_reason || run.latest_summary)).join("; ")}.`);
  }
  if (parts.length) return parts.join(" ");
  return intent.scope === "running" ? "No agents are running, queued, or blocked." : "No work-history tasks or runs recorded yet.";
}

function workHistoryStatusDisplay(intent, summary, changedDetail) {
  if (intent.scope === "changed" && changedDetail) return changedDetail;
  if (intent.scope === "failed" || intent.scope === "waiting") {
    return workHistoryStatusSpeech(intent, summary, changedDetail);
  }
  const groups = [
    ["Active agents", summary.active],
    ["Queued agents", summary.queued],
    ["Blocked agents", summary.blocked],
  ];
  if (intent.scope !== "running") {
    groups.push(["Recently completed", summary.completed], ["Failed or canceled", summary.failed]);
  }
  const sections = groups
    .filter(([, runs]) => runs.length)
    .map(([heading, runs]) => [
      `### ${heading}`,
      ...runs.map((run) => markdownRun(run)),
    ].join("\n"));
  if (sections.length) return sections.join("\n\n");
  return intent.scope === "running" ? "No agents are running, queued, or blocked." : "No work-history tasks or runs recorded yet.";
}

function spokenRun(run, detail = "") {
  const objective = compactRunText(run.objective || run.latest_summary || "intent not recorded", 90);
  const suffix = compactRunText(detail || (run.latest_summary !== run.objective ? run.latest_summary : ""), 80);
  return `${run.run_id}, ${objective}, is ${run.status}${run.worker_id ? ` on ${run.worker_id}` : ""}${suffix ? `; latest: ${suffix}` : ""}`;
}

function markdownRun(run) {
  const objective = compactRunText(run.objective || run.latest_summary || "Intent not recorded", 140);
  const latest = compactRunText(run.blocking_reason || (run.latest_summary !== run.objective ? run.latest_summary : ""), 160);
  const worker = run.worker_id ? ` on ${run.worker_id}` : "";
  return `- **${run.run_id}** — ${objective} \`${run.status}${worker}\`${latest ? ` — ${latest}` : ""}`;
}

function compactRunText(value, max) {
  const text = firstLine(value).replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

async function workHistoryChangedDetail(intent, summary, workHistory) {
  if (intent.scope !== "changed") return "";
  let runId = intent.target || "";
  if (!runId) {
    const candidates = summary.runs.filter((run) => run.diff_count > 0 || ["completed", "running", "claimed"].includes(run.status))
      .sort((a, b) => String(b.latest_event_at).localeCompare(String(a.latest_event_at)));
    runId = candidates[0]?.run_id || "";
  }
  if (!runId) return "No runs with recorded changes yet.";
  const detail = await workHistory.runDetail(runId);
  if (!detail) return `I have no work run named ${runId}.`;
  const parts = [`Run ${runId} is ${detail.status}.`];
  if (detail.before_snapshot && detail.after_snapshot) {
    parts.push(`It moved ${detail.before_snapshot.branch || "the repo"} from commit ${shortSha(detail.before_snapshot.commit_sha)} to ${shortSha(detail.after_snapshot.commit_sha)}.`);
  } else if (detail.before_snapshot) {
    parts.push(`It started from commit ${shortSha(detail.before_snapshot.commit_sha)}; no after snapshot yet.`);
  } else parts.push("No repo snapshots recorded yet.");
  const diff = detail.diffs.slice(-1)[0];
  if (diff) parts.push(`The diff ${diff.diff_id} touches ${diff.stats.files || diff.changed_paths.length} files, +${diff.stats.insertions} -${diff.stats.deletions}.`);
  const verification = detail.verifications.slice(-1)[0];
  if (verification) parts.push(`Latest verification ${verification.status}: ${verification.command || verification.verification_id}.`);
  return parts.join(" ");
}

function shortSha(sha) {
  const safe = String(sha || "").trim();
  return safe ? safe.slice(0, 10) : "unknown";
}

module.exports = {
  createWorkHistoryHandlers,
  agentRunStatusSummary,
  mergeRunStatusSummaries,
  workHistoryChangedDetail,
  workHistoryDeploymentTarget,
  workHistoryStatusDisplay,
  workHistoryStatusSpeech,
};
