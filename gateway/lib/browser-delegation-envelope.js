"use strict";

const VERSION = "moa.browser-delegation.v1";
const ACTION_CLASSES = Object.freeze([
  "click", "type", "clear", "select", "scroll", "navigate", "key", "wait", "screenshot",
]);
const EFFECT_CLASSES = Object.freeze([
  "purchase", "payment", "checkout", "external_submit", "credential", "destructive",
]);
const EFFECT_CLASS_RULES = Object.freeze([
  ["purchase", /\b(?:buy|purchase)\b|\bplace\s+(?:the\s+)?order\b/i],
  ["payment", /\b(?:pay|payment)\b/i],
  ["checkout", /\bcheckout\b/i],
  ["external_submit", /\bsubmit\b|\bsend\s+(?:(?:the|this|that|my|your)\s+)?(?:it|form|application|message|request|email)\b/i],
  ["credential", /\b(?:credential|credentials|password|passcode)\b/i],
  ["destructive", /\b(?:delete|destroy|erase)\b|\bremove\s+(?:(?:the|this|that|my|your)\s+)?(?:it|account|record|file|data|content)\b/i],
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
  const approvalPolicyIsObject = raw.approval_policy && typeof raw.approval_policy === "object" && !Array.isArray(raw.approval_policy);
  if (!approvalPolicyIsObject) errors.push("approval_policy must be an object");
  const approvalRaw = objectOrEmpty(raw.approval_policy);
  const hasAllowedEffects = Object.hasOwn(raw, "allowed_effect_classes");
  const hasAlwaysAskEffects = Object.hasOwn(approvalRaw, "always_ask_effects");
  const hasEffectSchema = hasAllowedEffects || hasAlwaysAskEffects;
  if (hasAllowedEffects !== hasAlwaysAskEffects) errors.push("effect schema fields must be provided together");
  const allowedEffects = effectClasses(raw.allowed_effect_classes, errors, "allowed_effect_classes", hasAllowedEffects);
  const intentEffects = sensitiveEffectClasses(userIntent);
  if (intentEffects.length > 0 && !hasEffectSchema) {
    errors.push("sensitive confirmation.user_intent requires explicit effect classes");
  }
  for (const effect of intentEffects) {
    if (!allowedEffects.includes(effect)) errors.push(`allowed_effect_classes must include intent effect: ${effect}`);
  }
  for (const effect of allowedEffects) {
    if (!intentEffects.includes(effect)) errors.push(`allowed_effect_classes is not bound to confirmation.user_intent: ${effect}`);
  }
  const preauthorized = actionClasses(approvalRaw.preauthorized);
  const alwaysAsk = actionClasses(approvalRaw.always_ask);
  const alwaysAskEffects = effectClasses(approvalRaw.always_ask_effects, errors, "approval_policy.always_ask_effects", hasAlwaysAskEffects);
  for (const item of [...preauthorized, ...alwaysAsk]) {
    if (!allowedActionClasses.includes(item)) errors.push(`approval_policy action is outside allowed_action_classes: ${item}`);
  }
  if (preauthorized.some((item) => alwaysAsk.includes(item))) errors.push("approval_policy action classes cannot be both preauthorized and always_ask");
  for (const effect of alwaysAskEffects) {
    if (!allowedEffects.includes(effect)) errors.push(`approval_policy effect is outside allowed_effect_classes: ${effect}`);
  }
  for (const effect of allowedEffects) {
    if (!alwaysAskEffects.includes(effect)) errors.push(`sensitive effect must require an exact checkpoint: ${effect}`);
  }
  const preauthorizedSensitiveMechanics = preauthorized.filter((item) => EFFECTFUL_ACTION_CLASSES.has(item));
  if (allowedEffects.length > 0 && preauthorizedSensitiveMechanics.length > 0) {
    errors.push(`generic action classes cannot preauthorize a sensitive effect: ${preauthorizedSensitiveMechanics.join(", ")}`);
  }

  const checkpoints = uniqueBoundedText(raw.checkpoints, 20, 120);
  if (checkpoints.length === 0) errors.push("checkpoints must contain at least one checkpoint policy");
  for (const effect of allowedEffects) {
    if (!checkpoints.includes(`before_effect:${effect}`)) errors.push(`checkpoints must contain before_effect:${effect}`);
  }
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
      ...(hasEffectSchema ? { allowed_effect_classes: allowedEffects } : {}),
      approval_policy: {
        preauthorized,
        always_ask: alwaysAsk,
        ...(hasEffectSchema ? { always_ask_effects: alwaysAskEffects } : {}),
      },
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
  const effect = normalizedClass(action?.effect_class);
  if (effect && !EFFECT_CLASSES.includes(effect)) {
    return { ok: false, reason: `unknown action effect class: ${effect}` };
  }
  if (action?.effect_class != null && !effect) {
    return { ok: false, reason: "unknown action effect class: unknown" };
  }
  if (action?.kind === "finish") return { ok: true };
  const kind = String(action?.kind || "");
  if (!envelope.allowed_action_classes.includes(kind)) return { ok: false, reason: `action class is outside delegated scope: ${kind || "unknown"}` };
  const allowedEffects = Array.isArray(envelope.allowed_effect_classes) ? envelope.allowed_effect_classes : [];
  if (effect) {
    if (!allowedEffects.includes(effect)) return { ok: false, reason: `effect class is outside delegated scope: ${effect}` };
    return { ok: false, reason: `effect requires an exact checkpoint: ${effect}` };
  }
  if (allowedEffects.length > 0 && EFFECTFUL_ACTION_CLASSES.has(kind)) {
    return { ok: false, reason: `action effect class is required before sensitive delegated work: ${kind}` };
  }
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
function normalizedClass(value) { return typeof value === "string" ? value.trim().toLowerCase().replace(/[\s.-]+/g, "_") : ""; }
function effectClasses(value, errors, field, present) {
  if (!present) return [];
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array`);
    return [];
  }
  const normalized = [];
  for (const rawEffect of value) {
    const effect = normalizedClass(rawEffect);
    if (!effect) {
      errors.push(`${field} contains unsupported effect class: invalid`);
    } else if (!normalized.includes(effect)) {
      normalized.push(effect);
    }
  }
  for (const effect of normalized) {
    if (!EFFECT_CLASSES.includes(effect)) errors.push(`${field} contains unsupported effect class: ${effect}`);
  }
  return normalized.filter((effect) => EFFECT_CLASSES.includes(effect));
}
function sensitiveEffectClasses(value) {
  const text = boundedText(value, 16000);
  return EFFECT_CLASS_RULES.filter(([, pattern]) => pattern.test(text)).map(([effect]) => effect);
}
function httpUrl(value) { try { const url = new URL(String(value || "")); return ["http:", "https:"].includes(url.protocol) ? url.href : ""; } catch { return ""; } }
function httpOrigin(value) { const url = httpUrl(value); return url ? new URL(url).origin : ""; }

const EFFECTFUL_ACTION_CLASSES = new Set(["click", "type", "clear", "select", "navigate", "key"]);

module.exports = {
  ACTION_CLASSES,
  EFFECT_CLASSES,
  VERSION,
  browserActionAllowedByEnvelope,
  validateBrowserDelegationEnvelope,
};
