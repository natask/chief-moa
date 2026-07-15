"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  browserAgentRoleCatalog,
  browserAgentRoleFromBody,
  resolveBrowserAgentRole,
} = require("../lib/browser-agent-roles");

test("role catalog is selector-ready with delegate primary and bounded authority", () => {
  const catalog = browserAgentRoleCatalog();
  assert.equal(catalog.version, "moa.browser-agent-roles.v1");
  assert.equal(catalog.default_role, "delegate");
  assert.equal(catalog.legacy_omitted_role, "explain");
  assert.deepEqual(catalog.roles.map((role) => role.id), ["delegate", "help", "collaborate", "explain"]);
  assert.equal(catalog.roles[0].can_launch_browser_task, true);
  assert.equal(catalog.roles.find((role) => role.id === "collaborate").max_proposed_steps, 1);
  for (const id of ["help", "collaborate", "explain"]) {
    assert.equal(catalog.roles.find((role) => role.id === id).can_launch_browser_task, false);
  }
});

test("omission is legacy explain while explicit roles validate", () => {
  const omitted = browserAgentRoleFromBody({});
  assert.equal(omitted.id, "explain");
  assert.equal(omitted.explicit, false);
  assert.equal(browserAgentRoleFromBody({ role: " Delegate " }).explicit, true);
  assert.equal(browserAgentRoleFromBody({ agent_role: "help" }).id, "help");
  assert.equal(browserAgentRoleFromBody({ browser_agent_role: "collaborate" }).authority, "proposal_only");
  assert.throws(() => resolveBrowserAgentRole("autopilot", { explicit: true }), /unsupported browser agent role/);
});
