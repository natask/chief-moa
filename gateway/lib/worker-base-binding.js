"use strict";

const SHA = /^[0-9a-f]{40}$/;

function workerBaseDrift(run, input = {}) {
  const expected = run?.workspace_base;
  if (!expected?.ref && !expected?.commit) return "";
  const ref = String(input.base_ref || "").trim();
  const commit = String(input.resolved_base_commit || "").trim().toLowerCase();
  if (ref === expected.ref && SHA.test(commit) && commit === expected.commit) return "";
  return `base drift: expected ${expected.ref}@${expected.commit}, observed ${ref || "missing"}@${commit || "missing"}`;
}

module.exports = { workerBaseDrift };
