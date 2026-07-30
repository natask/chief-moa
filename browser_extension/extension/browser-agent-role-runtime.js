const BROWSER_AGENT_ROLES = new Set(["delegate", "help", "collaborate", "explain"]);
const EFFECTFUL_ACTION_CLASSES = new Set(["click", "type", "clear", "select", "navigate", "key"]);

export function normalizeBrowserAgentRole(value) {
  const role = String(value || "").trim().toLowerCase();
  return BROWSER_AGENT_ROLES.has(role) ? role : "";
}

const ACTION_CLASS_RULES = Object.freeze([
  ["click", /\b(click|tap|press|activate|open|close|dismiss|toggle|check|uncheck|choose|pick|add|create|remove|delete|archive|send|submit|buy|purchase|pay)\b/i],
  ["type", /\b(type|write|enter|fill|draft|compose|edit|change|replace|rename|add|create|search|find|send|submit)\b/i],
  ["clear", /\b(clear|erase|empty|replace|rewrite|edit|change)\b/i],
  ["select", /\b(select|choose|pick|option|dropdown)\b/i],
  ["scroll", /\b(scroll|browse|scan|review|inspect|find|search|look for|locate)\b/i],
  ["navigate", /\b(navigate|go to|visit|open (?:the )?(?:page|site|link)|follow (?:the )?link)\b/i],
  ["key", /\b(key|keyboard|press (?:enter|return|escape|tab)|shortcut)\b/i],
  ["screenshot", /\b(screenshot|screen ?shot|capture (?:the )?(?:page|screen)|visual evidence)\b/i],
]);

const EFFECT_CLASS_RULES = Object.freeze([
  ["purchase", /\b(?:buy|purchase)\b|\bplace\s+(?:the\s+)?order\b/i],
  ["payment", /\b(?:pay|payment)\b/i],
  ["checkout", /\bcheckout\b/i],
  ["external_submit", /\bsubmit\b|\bsend\s+(?:(?:the|this|that|my|your)\s+)?(?:it|form|application|message|request|email)\b/i],
  ["credential", /\b(?:credential|credentials|password|passcode)\b/i],
  ["destructive", /\b(?:delete|destroy|erase)\b|\bremove\s+(?:(?:the|this|that|my|your)\s+)?(?:it|account|record|file|data|content)\b/i],
]);

export function browserIntentActionClasses(text) {
  const intent = String(text || "").trim();
  const inferred = ACTION_CLASS_RULES.filter(([, pattern]) => pattern.test(intent)).map(([actionClass]) => actionClass);
  return inferred.length ? inferred : ["click", "scroll", "wait"];
}

export function browserIntentEffectClasses(text) {
  const intent = String(text || "").trim();
  return EFFECT_CLASS_RULES.filter(([, pattern]) => pattern.test(intent)).map(([effectClass]) => effectClass);
}

export function browserDelegationEnvelope(text, pageUrl) {
  const intent = String(text || "").trim().replace(/\s+/g, " ");
  const url = new URL(String(pageUrl || ""));
  if (!["http:", "https:"].includes(url.protocol)) throw new TypeError("delegation requires an http(s) page");
  const actionClasses = browserIntentActionClasses(intent);
  const effectClasses = browserIntentEffectClasses(intent);
  const preauthorized = actionClasses.filter((actionClass) =>
    actionClass !== "navigate" && !(effectClasses.length > 0 && EFFECTFUL_ACTION_CLASSES.has(actionClass)));
  const alwaysAsk = actionClasses.filter((actionClass) => !preauthorized.includes(actionClass));
  return {
    version: "moa.browser-delegation.v1",
    confirmation: { confirmed: true, source: "user_submission", user_intent: intent },
    goal: intent,
    scope: { page_url: url.href, allowed_origins: [url.origin] },
    allowed_action_classes: actionClasses,
    allowed_effect_classes: effectClasses,
    approval_policy: {
      preauthorized,
      always_ask: alwaysAsk,
      always_ask_effects: effectClasses,
    },
    checkpoints: [
      "before navigation",
      ...effectClasses.map((effectClass) => `before_effect:${effectClass}`),
      "when page identity or origin changes",
      "when completion cannot be verified",
    ],
    stop_conditions: [
      "the user stops the task",
      "the page leaves the allowed origin",
      "an action requires authority outside this envelope",
      "the maximum step count is reached",
    ],
    max_steps: 20,
    completion_evidence: ["final page URL", "browser action receipts", "agent result summary"],
  };
}
