import { assertChronological, stableDecisionId } from "./schemas.js";

const requiredCapability = (capability, name, method) => {
  if (!capability || typeof capability[method] !== "function") throw new Error(`${name}.${method} capability is unavailable`);
};
const applied = (decision, result) => ({
  ...decision,
  state: "applied",
  applied_at: new Date().toISOString(),
  result,
  links: {
    ...decision.links,
    intent_ids: [...new Set([...(decision.links.intent_ids || []), result?.intent_id].filter(Boolean))],
    message_ids: [...new Set([...(decision.links.message_ids || []), result?.message_id].filter(Boolean))],
    run_ids: [...new Set([...(decision.links.run_ids || []), result?.run_id].filter(Boolean))],
  },
});

export function createSwitchboardClient({ intentManagement, router, decisionStore, launcher, durableMessages, clock = () => new Date().toISOString() }) {
  requiredCapability(intentManagement, "intentManagement", "readSnapshot");
  requiredCapability(intentManagement, "intentManagement", "readAttention");
  requiredCapability(decisionStore, "decisionStore", "save");
  if (!router?.route) throw new Error("router.route capability is unavailable");

  async function inspect(envelopes) {
    const chronological = assertChronological(envelopes);
    const [snapshot, attention] = await Promise.all([
      intentManagement.readSnapshot(),
      intentManagement.readAttention(),
    ]);
    const decisions = [];
    for (const envelope of chronological) {
      const decision = router.route({ envelope, snapshot, attention });
      await decisionStore.save(decision);
      decisions.push(decision);
    }
    return { envelopes: chronological, snapshot, attention, decisions };
  }

  async function apply(decisionId, options = {}) {
    const decision = await decisionStore.get(decisionId);
    if (!decision) throw new Error("route decision not found");
    if (decision.state !== "proposed") return decision;
    if (options.confirmed !== true) throw new Error("applying a route decision requires confirmed: true");
    const action = decision.action;
    let result;
    if (action.type === "status") {
      result = action.intent_id
        ? await intentManagement.readIntent(action.intent_id)
        : { snapshot: await intentManagement.readSnapshot(), attention: await intentManagement.readAttention() };
    } else if (action.type === "observation") {
      requiredCapability(intentManagement, "intentManagement", "recordObservation");
      result = await intentManagement.recordObservation({ ...action, source_envelope_id: decision.source_envelope_id });
    } else if (action.type === "new" || action.type === "fork") {
      requiredCapability(intentManagement, "intentManagement", "createIntent");
      result = await intentManagement.createIntent({
        title: action.title,
        objective: action.objective,
        parent_intent_id: action.parent_intent_id || "",
        user_confirmed: true,
        provenance: {
          source_envelope_id: decision.source_envelope_id,
          route_decision_id: decision.decision_id,
          ...(action.parent_intent_id ? { parent_intent_id: action.parent_intent_id } : {}),
        },
      });
    } else if (action.type === "update") {
      requiredCapability(intentManagement, "intentManagement", "updateIntent");
      result = await intentManagement.updateIntent(action.intent_id, {
        next_action: action.next_action,
        route_decision_id: decision.decision_id,
      });
    } else if (action.type === "merge") {
      requiredCapability(intentManagement, "intentManagement", "mergeIntents");
      result = await intentManagement.mergeIntents({
        source_intent_ids: action.source_intent_ids,
        target_intent_id: action.target_intent_id,
        route_decision_id: decision.decision_id,
      });
    } else if (action.type === "launch") {
      requiredCapability(launcher, "launcher", "launchOrReopen");
      result = await launcher.launchOrReopen({
        intent_id: action.intent_id,
        reopen: action.reopen,
        source_envelope_id: decision.source_envelope_id,
        route_decision_id: decision.decision_id,
      });
    } else if (action.type === "steer") {
      requiredCapability(durableMessages, "durableMessages", "supports");
      if (!await durableMessages.supports({ agent_id: action.agent_id, intent_id: action.intent_id })) {
        throw new Error("downstream runtime does not support durable steering messages");
      }
      requiredCapability(durableMessages, "durableMessages", "send");
      result = await durableMessages.send({
        agent_id: action.agent_id,
        intent_id: action.intent_id,
        body: action.message,
        source_envelope_id: decision.source_envelope_id,
        route_decision_id: decision.decision_id,
      });
    }
    const final = applied(decision, result || {});
    await decisionStore.save(final);
    return final;
  }

  async function reverse(decisionId, reason) {
    const prior = await decisionStore.get(decisionId);
    if (!prior) throw new Error("route decision not found");
    const compensating = {
      schema: prior.schema,
      decision_id: stableDecisionId(prior.source_envelope_id, `reverse:${prior.action.type}`, [prior.decision_id]),
      source_envelope_id: prior.source_envelope_id,
      snapshot_revision: prior.snapshot_revision,
      action: { type: "observation", intent_id: prior.links.intent_ids[0] || "", note: `Reverse ${prior.decision_id}: ${reason}` },
      confidence: 1,
      reasons: ["user requested a compensating reversal"],
      visibility: "required",
      state: "proposed",
      reversible: false,
      reverses: prior.decision_id,
      created_at: clock(),
      links: { source_envelope_id: prior.source_envelope_id, intent_ids: prior.links.intent_ids, message_ids: [], run_ids: [] },
    };
    await decisionStore.supersede(prior.decision_id, compensating);
    return compensating;
  }

  return { inspect, apply, reverse, getDecision: decisionStore.get, listDecisions: decisionStore.list };
}
