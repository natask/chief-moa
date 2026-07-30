const CHECKPOINT_MAX_AGE_MS = 2 * 60 * 1000;

const SENSITIVE_TOKENS = new Map([
  ["buy", "purchase"],
  ["purchase", "purchase"],
  ["pay", "payment"],
  ["payment", "payment"],
  ["place_order", "purchase"],
  ["checkout", "checkout"],
  ["credential", "credential"],
  ["credentials", "credential"],
  ["password", "credential"],
  ["external_submit", "external_submit"],
  ["submit", "external_submit"],
  ["destructive", "destructive"],
  ["delete", "destructive"],
  ["destroy", "destructive"],
]);

const SAFE_TOKENS = new Set([
  "read",
  "read_only",
  "dom_read",
  "observe",
  "inspect",
  "query",
  "get",
  "get_text",
  "get_attribute",
  "extract_text",
  "list",
  "describe",
  "snapshot",
  "screenshot",
  "wait",
  "noop",
  "scroll",
]);

const SENSITIVE_PHRASES = [
  [/(?:^|\b)(?:buy|purchase|pay|payment|checkout)(?:\b|$)/i, "purchase"],
  [/(?:^|\b)place\s+(?:the\s+)?order(?:\b|$)/i, "purchase"],
  [/(?:^|\b)(?:credential|password|passcode)(?:s|\b|$)/i, "credential"],
  [/(?:^|\b)(?:submit|send)\s+(?:the\s+)?(?:form|application|message|request)(?:\b|$)/i, "external_submit"],
  [/(?:^|\b)(?:delete|destroy|erase|remove)\s+(?:the\s+)?(?:account|record|file|data|content)(?:\b|$)/i, "destructive"],
];

function normalizedToken(value) {
  return typeof value === "string"
    ? value.trim().toLowerCase().replace(/[\s.-]+/g, "_")
    : "";
}

function classifyBrowserActionCheckpoint(effect) {
  if (!effect || typeof effect !== "object" || Array.isArray(effect)) {
    return { required: true, reason: "malformed_effect" };
  }

  const tokenFields = ["effect_class", "risk", "kind", "action", "operation", "intent", "category", "sensitivity"];
  const tokens = [];
  for (const field of tokenFields) {
    const token = normalizedToken(effect[field]);
    if (token) tokens.push(token);
    const reason = SENSITIVE_TOKENS.get(token);
    if (reason) return { required: true, reason };
  }

  if (normalizedToken(effect.input_type) === "password" || normalizedToken(effect.autocomplete) === "current_password") {
    return { required: true, reason: "credential" };
  }

  const evidence = [effect.label, effect.description, effect.intent_text]
    .filter((value) => typeof value === "string")
    .join(" ");
  for (const [pattern, reason] of SENSITIVE_PHRASES) {
    if (pattern.test(evidence)) return { required: true, reason };
  }

  if (tokens.length > 0 && tokens.every((token) => SAFE_TOKENS.has(token))) {
    return { required: false, reason: "known_safe" };
  }
  return { required: true, reason: "unknown_side_effect" };
}

function exactNonEmptyString(value) {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

function checkpointBinding(request) {
  return {
    task_id: request?.task_id,
    envelope_digest: request?.envelope_digest,
    anchor_id: request?.anchor_id,
    before_hash: request?.before_hash,
  };
}

function bindingIsComplete(binding) {
  return Object.values(binding).every(exactNonEmptyString);
}

function consumedApprovalIds(state) {
  return Array.isArray(state?.consumed_approval_ids)
    ? state.consumed_approval_ids.filter(exactNonEmptyString)
    : [];
}

function deny(code, checkpoint, consumed) {
  return {
    ok: false,
    code,
    checkpoint,
    state: { consumed_approval_ids: consumed.slice() },
  };
}

function authorizeBrowserActionAttempt(request, state = {}, { now = Date.now(), maxAgeMs = CHECKPOINT_MAX_AGE_MS } = {}) {
  const checkpoint = classifyBrowserActionCheckpoint(request?.effect);
  const consumed = consumedApprovalIds(state);
  if (!checkpoint.required) {
    return {
      ok: true,
      checkpoint,
      state: { consumed_approval_ids: consumed.slice() },
    };
  }

  const binding = checkpointBinding(request);
  if (!bindingIsComplete(binding)) return deny("checkpoint_binding_invalid", checkpoint, consumed);
  if (request?.background === true) return deny("checkpoint_background_denied", checkpoint, consumed);

  const approval = request?.approval;
  if (!approval || typeof approval !== "object" || Array.isArray(approval) || !exactNonEmptyString(approval.approval_id)) {
    return deny("checkpoint_required", checkpoint, consumed);
  }
  if (consumed.includes(approval.approval_id)) return deny("checkpoint_replayed", checkpoint, consumed);

  const issuedAt = approval.issued_at_ms;
  const expiresAt = approval.expires_at_ms;
  const validClock = Number.isFinite(now) && Number.isFinite(issuedAt) && Number.isFinite(expiresAt);
  const validAge = Number.isFinite(maxAgeMs) && maxAgeMs > 0
    && issuedAt <= now && now < expiresAt
    && expiresAt > issuedAt && expiresAt - issuedAt <= maxAgeMs
    && now - issuedAt <= maxAgeMs;
  if (!validClock || !validAge) return deny("checkpoint_expired", checkpoint, consumed);

  const approvedBinding = checkpointBinding(approval);
  if (!bindingIsComplete(approvedBinding)
    || Object.keys(binding).some((key) => approvedBinding[key] !== binding[key])) {
    return deny("checkpoint_mismatch", checkpoint, consumed);
  }

  return {
    ok: true,
    checkpoint,
    approval_id: approval.approval_id,
    state: { consumed_approval_ids: [...consumed, approval.approval_id] },
  };
}

export {
  CHECKPOINT_MAX_AGE_MS,
  authorizeBrowserActionAttempt,
  classifyBrowserActionCheckpoint,
};
