"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  VERSION,
  browserActionAllowedByEnvelope,
  validateBrowserDelegationEnvelope,
} = require("../lib/browser-delegation-envelope");

function envelope(intent = "Create the project", url = "https://example.test/projects") {
  return {
    version: VERSION,
    confirmation: { confirmed: true, user_intent: intent },
    goal: intent,
    scope: { page_url: url, allowed_origins: [new URL(url).origin] },
    allowed_action_classes: ["click", "type", "navigate", "wait"],
    allowed_effect_classes: [],
    approval_policy: { preauthorized: ["click", "type", "wait"], always_ask: ["navigate"], always_ask_effects: [] },
    checkpoints: ["before external submit"],
    stop_conditions: ["goal complete", "scope changed", "evidence stale"],
    max_steps: 12,
    completion_evidence: ["project identity", "task count"],
  };
}

test("confirmed envelope is normalized and bound to current intent and page", () => {
  const result = validateBrowserDelegationEnvelope(envelope(), {
    turnText: "Create the project",
    pageUrl: "https://example.test/projects",
  });
  assert.equal(result.ok, true);
  assert.equal(result.envelope.version, VERSION);
  assert.equal(result.envelope.max_steps, 12);
  assert.deepEqual(result.envelope.scope.allowed_origins, ["https://example.test"]);
});

test("sensitive effects are separate from primitive actions and require exact checkpoints", () => {
  const intents = new Map([
    ["purchase", "purchase it"],
    ["payment", "pay it"],
    ["checkout", "checkout"],
    ["external_submit", "submit it"],
    ["credential", "enter my credential"],
    ["destructive", "delete it"],
  ]);
  for (const [effect, intent] of intents) {
    const value = envelope(intent);
    value.allowed_action_classes = ["click", "type", "wait"];
    value.allowed_effect_classes = [effect];
    value.approval_policy = { preauthorized: ["wait"], always_ask: ["click", "type"], always_ask_effects: [effect] };
    value.checkpoints = [`before_effect:${effect}`];
    const result = validateBrowserDelegationEnvelope(value, {
      turnText: intent,
      pageUrl: "https://example.test/projects",
    });
    assert.equal(result.ok, true, effect);
    assert.deepEqual(result.envelope.allowed_effect_classes, [effect]);
    assert.match(
      browserActionAllowedByEnvelope({ kind: "click" }, result.envelope, { url: "https://example.test/projects" }).reason,
      /effect class is required/,
    );
    assert.match(
      browserActionAllowedByEnvelope({ kind: "click", effect_class: effect }, result.envelope, { url: "https://example.test/projects" }).reason,
      new RegExp(`exact checkpoint: ${effect}`),
    );
  }
});

test("unknown effects fail closed instead of disappearing during normalization", () => {
  const value = envelope("Do the task");
  value.allowed_effect_classes = ["purchase", "wire_money"];
  value.approval_policy.always_ask_effects = ["purchase", "wire_money"];
  value.checkpoints.push("before_effect:purchase", "before_effect:wire_money");
  const result = validateBrowserDelegationEnvelope(value, {
    turnText: "Do the task",
    pageUrl: "https://example.test/projects",
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /unsupported effect class: wire_money/);

  for (const unknown of ["", 42, null, { effect: "purchase" }]) {
    const malformed = envelope("Do the task");
    malformed.allowed_effect_classes = [unknown];
    const rejected = validateBrowserDelegationEnvelope(malformed, {
      turnText: "Do the task",
      pageUrl: "https://example.test/projects",
    });
    assert.equal(rejected.ok, false, JSON.stringify(unknown));
    assert.match(rejected.errors.join("\n"), /unsupported effect class: invalid/);
  }

  const valid = validateBrowserDelegationEnvelope(envelope(), {
    turnText: "Create the project",
    pageUrl: "https://example.test/projects",
  }).envelope;
  assert.match(
    browserActionAllowedByEnvelope({ kind: "click", effect_class: "wire_money" }, valid, { url: "https://example.test/projects" }).reason,
    /unknown action effect class/,
  );
});

test("generic click or type cannot preauthorize a sensitive effect", () => {
  const value = envelope("Buy the item");
  value.allowed_effect_classes = ["purchase"];
  value.approval_policy.always_ask_effects = ["purchase"];
  value.checkpoints.push("before_effect:purchase");
  const result = validateBrowserDelegationEnvelope(value, {
    turnText: "Buy the item",
    pageUrl: "https://example.test/projects",
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /generic action classes cannot preauthorize a sensitive effect/);
});

test("sensitive intent cannot omit, empty, null, or substitute its effect binding", () => {
  const repros = [
    ["submit it", "external_submit"],
    ["send this email", "external_submit"],
    ["delete it", "destructive"],
    ["buy it", "purchase"],
    ["pay it", "payment"],
    ["checkout", "checkout"],
    ["enter my password", "credential"],
  ];
  for (const [intent, effect] of repros) {
    for (const mode of ["omitted", "empty", "null", "substitute"]) {
      const value = envelope(intent);
      delete value.allowed_effect_classes;
      delete value.approval_policy.always_ask_effects;
      if (mode === "empty") {
        value.allowed_effect_classes = [];
        value.approval_policy.always_ask_effects = [];
      } else if (mode === "null") {
        value.allowed_effect_classes = null;
        value.approval_policy.always_ask_effects = null;
      } else if (mode === "substitute") {
        const wrong = effect === "purchase" ? "payment" : "purchase";
        value.allowed_effect_classes = [wrong];
        value.approval_policy.always_ask_effects = [wrong];
        value.checkpoints.push(`before_effect:${wrong}`);
      }
      const result = validateBrowserDelegationEnvelope(value, {
        turnText: intent,
        pageUrl: "https://example.test/projects",
      });
      assert.equal(result.ok, false, `${intent}: ${mode}`);
      assert.match(result.errors.join("\n"), mode === "null" ? /must be an array/ : new RegExp(effect));
    }
  }
});

test("ordinary safe legacy intent remains valid without effect schema fields", () => {
  const value = envelope("Create the project");
  delete value.allowed_effect_classes;
  delete value.approval_policy.always_ask_effects;
  const result = validateBrowserDelegationEnvelope(value, {
    turnText: "Create the project",
    pageUrl: "https://example.test/projects",
  });
  assert.equal(result.ok, true);
  assert.equal(Object.hasOwn(result.envelope, "allowed_effect_classes"), false);
  assert.equal(Object.hasOwn(result.envelope.approval_policy, "always_ask_effects"), false);
});

test("explicit null effect schema fields reject even for safe intent", () => {
  for (const field of ["allowed_effect_classes", "always_ask_effects"]) {
    const value = envelope("Create the project");
    if (field === "allowed_effect_classes") value.allowed_effect_classes = null;
    else value.approval_policy.always_ask_effects = null;
    const result = validateBrowserDelegationEnvelope(value, {
      turnText: "Create the project",
      pageUrl: "https://example.test/projects",
    });
    assert.equal(result.ok, false, field);
    assert.match(result.errors.join("\n"), /must be an array/);
  }

  const nullPolicy = envelope("Create the project");
  nullPolicy.approval_policy = null;
  const rejected = validateBrowserDelegationEnvelope(nullPolicy, {
    turnText: "Create the project",
    pageUrl: "https://example.test/projects",
  });
  assert.equal(rejected.ok, false);
  assert.match(rejected.errors.join("\n"), /approval_policy must be an object/);
});

test("missing, stale, and overbroad confirmations fail closed", () => {
  const missing = validateBrowserDelegationEnvelope(null, { turnText: "x", pageUrl: "https://example.test/" });
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.length >= 8);

  const bad = envelope();
  bad.confirmation.user_intent = "Different intent";
  bad.scope.page_url = "javascript:alert(1)";
  bad.scope.allowed_origins = ["file:///tmp/x"];
  bad.allowed_action_classes = ["eval"];
  bad.approval_policy = { preauthorized: ["click"], always_ask: ["click"] };
  bad.max_steps = 100;
  const rejected = validateBrowserDelegationEnvelope(bad, {
    turnText: "Create the project",
    pageUrl: "https://example.test/projects",
  });
  assert.equal(rejected.ok, false);
  assert.match(rejected.errors.join("\n"), /must match the current turn text/);
  assert.match(rejected.errors.join("\n"), /max_steps/);
});

test("planner policy enforces observed origin, class, approval, and navigation origin", () => {
  const valid = validateBrowserDelegationEnvelope(envelope(), {
    turnText: "Create the project",
    pageUrl: "https://example.test/projects",
  }).envelope;
  assert.deepEqual(browserActionAllowedByEnvelope({ kind: "click", index: 1 }, valid, { url: "https://example.test/projects" }), { ok: true });
  assert.match(browserActionAllowedByEnvelope({ kind: "scroll" }, valid, { url: "https://example.test/projects" }).reason, /outside delegated scope/);
  assert.match(browserActionAllowedByEnvelope({ kind: "navigate", url: "https://example.test/next" }, valid, { url: "https://example.test/projects" }).reason, /requires a new user approval/);
  const navigationApproved = {
    ...valid,
    approval_policy: { preauthorized: [...valid.approval_policy.preauthorized, "navigate"], always_ask: [] },
  };
  assert.match(browserActionAllowedByEnvelope({ kind: "navigate", url: "https://evil.test/" }, navigationApproved, { url: "https://example.test/projects" }).reason, /navigation origin is outside/);
  assert.match(browserActionAllowedByEnvelope({ kind: "click" }, valid, { url: "https://evil.test/" }).reason, /outside delegated scope/);
  assert.deepEqual(browserActionAllowedByEnvelope({ kind: "finish" }, valid, { url: "https://example.test/" }), { ok: true });
  assert.deepEqual(browserActionAllowedByEnvelope({ kind: "anything" }, null, {}), { ok: true });
});
