const BROWSER_AGENT_ROLES = new Set(["delegate", "help", "collaborate", "explain"]);

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

export function browserIntentActionClasses(text) {
  const intent = String(text || "").trim();
  const inferred = ACTION_CLASS_RULES.filter(([, pattern]) => pattern.test(intent)).map(([actionClass]) => actionClass);
  return inferred.length ? inferred : ["click", "scroll", "wait"];
}

export function browserDelegationEnvelope(text, pageUrl) {
  const intent = String(text || "").trim().replace(/\s+/g, " ");
  const url = new URL(String(pageUrl || ""));
  if (!["http:", "https:"].includes(url.protocol)) throw new TypeError("delegation requires an http(s) page");
  return {
    version: "moa.browser-delegation.v1",
    confirmation: { confirmed: true, source: "user_submission", user_intent: intent },
    goal: intent,
    scope: { page_url: url.href, allowed_origins: [url.origin] },
    allowed_action_classes: browserIntentActionClasses(intent),
    approval_policy: {
      preauthorized: browserIntentActionClasses(intent).filter((actionClass) => actionClass !== "navigate"),
      always_ask: ["navigate", "sensitive", "destructive"],
    },
    checkpoints: [
      "before navigation",
      "before a sensitive or destructive action",
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
