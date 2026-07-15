const BROWSER_AGENT_ROLES = new Set(["delegate", "help", "collaborate", "explain"]);

export function normalizeBrowserAgentRole(value) {
  const role = String(value || "").trim().toLowerCase();
  return BROWSER_AGENT_ROLES.has(role) ? role : "";
}

export function browserDelegationEnvelope(text, pageUrl) {
  const intent = String(text || "").trim().replace(/\s+/g, " ");
  const url = new URL(String(pageUrl || ""));
  if (!["http:", "https:"].includes(url.protocol)) throw new TypeError("delegation requires an http(s) page");
  return {
    version: "moa.browser-delegation.v1",
    confirmation: { confirmed: true, user_intent: intent },
    goal: intent,
    scope: { page_url: url.href, allowed_origins: [url.origin] },
    allowed_action_classes: ["click", "type", "clear", "select", "scroll", "navigate", "key", "wait", "screenshot"],
    approval_policy: {
      preauthorized: ["click", "type", "clear", "select", "scroll", "key", "wait", "screenshot"],
      always_ask: ["navigate"],
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
