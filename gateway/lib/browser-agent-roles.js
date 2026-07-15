"use strict";

// User-addressable browser roles are an authority contract, not personality
// presets. The UI may default its selector to delegate, but legacy requests
// without an explicit role remain explain/read-only so an old client can never
// acquire execution authority by omission.
const ROLE_DEFINITIONS = Object.freeze({
  delegate: Object.freeze({
    id: "delegate",
    label: "Delegate",
    description: "Give the agent a bounded browser task to carry through the local claim and receipt loop.",
    authority: "bounded_browser_actions",
    execution_policy: "multi_step_claim_receipt",
    can_launch_browser_task: true,
    max_proposed_steps: 40,
  }),
  help: Object.freeze({
    id: "help",
    label: "Help",
    description: "Get practical guidance without browser actions.",
    authority: "read_only",
    execution_policy: "answer_only",
    can_launch_browser_task: false,
    max_proposed_steps: 0,
  }),
  collaborate: Object.freeze({
    id: "collaborate",
    label: "Collaborate",
    description: "Work together through one non-executable proposed step at a time.",
    authority: "proposal_only",
    execution_policy: "one_step_user_confirmed",
    can_launch_browser_task: false,
    max_proposed_steps: 1,
  }),
  explain: Object.freeze({
    id: "explain",
    label: "Explain",
    description: "Explain the observed page without browser actions.",
    authority: "read_only",
    execution_policy: "answer_only",
    can_launch_browser_task: false,
    max_proposed_steps: 0,
  }),
});

const ROLE_ORDER = Object.freeze(["delegate", "help", "collaborate", "explain"]);

function browserAgentRoleCatalog() {
  return {
    version: "moa.browser-agent-roles.v1",
    default_role: "delegate",
    legacy_omitted_role: "explain",
    roles: ROLE_ORDER.map((id) => ({ ...ROLE_DEFINITIONS[id] })),
  };
}

function resolveBrowserAgentRole(value, options = {}) {
  const explicit = options.explicit === true;
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) {
    return { ...ROLE_DEFINITIONS.explain, explicit: false };
  }
  const role = ROLE_DEFINITIONS[raw];
  if (!role) {
    throw new Error(`unsupported browser agent role: ${raw}`);
  }
  return { ...role, explicit };
}

function browserAgentRoleFromBody(body) {
  const value = body?.role || body?.agent_role || body?.browser_agent_role;
  return resolveBrowserAgentRole(value, { explicit: Boolean(String(value || "").trim()) });
}

module.exports = {
  ROLE_DEFINITIONS,
  browserAgentRoleCatalog,
  browserAgentRoleFromBody,
  resolveBrowserAgentRole,
};
