"use strict";

const VERSION = "moa.browser-delegation.v1";
const ACTION_CLASSES = Object.freeze([
  "click", "type", "clear", "select", "scroll", "navigate", "key", "wait", "screenshot",
]);
const MAX_STEPS = 40;

function validateBrowserDelegationEnvelope(value, context = {}) {
  const errors = [];
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const version = String(raw.version || "").trim();
  if (version !== VERSION) errors.push(`version must be ${VERSION}`);

  const confirmationRaw = objectOrEmpty(raw.confirmation);
  const confirmed = confirmationRaw.confirmed === true;
  const userIntent = boundedText(confirmationRaw.user_intent, 16000);
  const expectedIntent = boundedText(context.turnText, 16000);
  if (!confirmed) errors.push("confirmation.confirmed must be true");
  if (!userIntent) errors.push("confirmation.user_intent is required");
  else if (expectedIntent && userIntent !== expectedIntent) errors.push("confirmation.user_intent must match the current turn text");

  const goal = boundedText(raw.goal, 16000);
  if (!goal) errors.push("goal is required");

  const scopeRaw = objectOrEmpty(raw.scope);
  const pageUrl = httpUrl(scopeRaw.page_url);
  if (!pageUrl) errors.push("scope.page_url must be an absolute http(s) URL");
  const allowedOrigins = uniqueStrings(scopeRaw.allowed_origins, 12)
    .map(httpOrigin)
    .filter(Boolean);
  if (allowedOrigins.length === 0) errors.push("scope.allowed_origins must contain at least one http(s) origin");
  const observedUrl = httpUrl(context.pageUrl);
  if (observedUrl && pageUrl && observedUrl !== pageUrl) errors.push("scope.page_url must match the observed page URL");
  if (pageUrl && allowedOrigins.length > 0 && !allowedOrigins.includes(new URL(pageUrl).origin)) {
    errors.push("scope.allowed_origins must include the page origin");
  }

  const allowedActionClasses = actionClasses(raw.allowed_action_classes);
  if (allowedActionClasses.length === 0) errors.push("allowed_action_classes must contain at least one supported action class");
  const approvalRaw = objectOrEmpty(raw.approval_policy);
  const preauthorized = actionClasses(approvalRaw.preauthorized);
  const alwaysAsk = actionClasses(approvalRaw.always_ask);
  for (const item of [...preauthorized, ...alwaysAsk]) {
    if (!allowedActionClasses.includes(item)) errors.push(`approval_policy action is outside allowed_action_classes: ${item}`);
  }
  if (preauthorized.some((item) => alwaysAsk.includes(item))) errors.push("approval_policy action classes cannot be both preauthorized and always_ask");

  const checkpoints = uniqueBoundedText(raw.checkpoints, 20, 120);
  if (checkpoints.length === 0) errors.push("checkpoints must contain at least one checkpoint policy");
  const stopConditions = uniqueBoundedText(raw.stop_conditions, 20, 120);
  if (stopConditions.length === 0) errors.push("stop_conditions must contain at least one stop policy");
  const completionEvidence = uniqueBoundedText(raw.completion_evidence, 20, 160);
  if (completionEvidence.length === 0) errors.push("completion_evidence must contain at least one evidence requirement");
  const maxSteps = Number(raw.max_steps);
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > MAX_STEPS) errors.push(`max_steps must be an integer from 1 to ${MAX_STEPS}`);

  if (errors.length > 0) return { ok: false, errors: Array.from(new Set(errors)).slice(0, 20), envelope: null };
  return {
    ok: true,
    errors: [],
    envelope: {
      version: VERSION,
      confirmation: { confirmed: true, user_intent: userIntent },
      goal,
      scope: { page_url: pageUrl, allowed_origins: allowedOrigins },
      allowed_action_classes: allowedActionClasses,
      approval_policy: { preauthorized, always_ask: alwaysAsk },
      checkpoints,
      stop_conditions: stopConditions,
      max_steps: maxSteps,
      completion_evidence: completionEvidence,
    },
  };
}

function browserActionAllowedByEnvelope(action, envelope, observation = {}) {
  if (!envelope) return { ok: true };
  const observedOrigin = httpOrigin(observation.url);
  if (observedOrigin && !envelope.scope.allowed_origins.includes(observedOrigin)) {
    return { ok: false, reason: `page origin is outside delegated scope: ${observedOrigin}` };
  }
  if (action?.kind === "finish") return { ok: true };
  const kind = String(action?.kind || "");
  if (!envelope.allowed_action_classes.includes(kind)) return { ok: false, reason: `action class is outside delegated scope: ${kind || "unknown"}` };
  if (envelope.approval_policy.always_ask.includes(kind) || !envelope.approval_policy.preauthorized.includes(kind)) {
    return { ok: false, reason: `action requires a new user approval: ${kind}` };
  }
  if (kind === "navigate") {
    const targetOrigin = httpOrigin(action.url);
    if (!targetOrigin || !envelope.scope.allowed_origins.includes(targetOrigin)) {
      return { ok: false, reason: `navigation origin is outside delegated scope: ${targetOrigin || "invalid"}` };
    }
  }
  return { ok: true };
}

function objectOrEmpty(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function boundedText(value, max) { return String(value || "").trim().replace(/\s+/g, " ").slice(0, max); }
function uniqueStrings(value, cap) { return Array.from(new Set((Array.isArray(value) ? value : []).map((item) => String(item || "").trim()).filter(Boolean))).slice(0, cap); }
function uniqueBoundedText(value, cap, max) { return Array.from(new Set((Array.isArray(value) ? value : []).map((item) => boundedText(item, max)).filter(Boolean))).slice(0, cap); }
function actionClasses(value) { return uniqueStrings(value, ACTION_CLASSES.length).map((item) => item.toLowerCase()).filter((item) => ACTION_CLASSES.includes(item)); }
function httpUrl(value) { try { const url = new URL(String(value || "")); return ["http:", "https:"].includes(url.protocol) ? url.href : ""; } catch { return ""; } }
function httpOrigin(value) { const url = httpUrl(value); return url ? new URL(url).origin : ""; }

module.exports = {
  ACTION_CLASSES,
  VERSION,
  browserActionAllowedByEnvelope,
  validateBrowserDelegationEnvelope,
};
