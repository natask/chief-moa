import { stableDecisionId, validateAction } from "./schemas.js";

const words = (value) => new Set(String(value || "").toLowerCase().match(/[a-z0-9_-]{3,}/g) || []);
const overlap = (left, right) => {
  const a = words(left);
  const b = words(right);
  if (!a.size || !b.size) return 0;
  let matches = 0;
  for (const word of a) if (b.has(word)) matches += 1;
  return matches / Math.max(a.size, b.size);
};
const explicitId = (text, intents) => intents.find((intent) => text.includes(intent.intent_id));
const title = (message) => message.replace(/\s+/g, " ").slice(0, 120);

export function createDeterministicRouter({ minimumMatch = 0.34 } = {}) {
  return {
    route({ envelope, snapshot }) {
      const message = envelope.message.text.trim();
      const lower = message.toLowerCase();
      const intents = Array.isArray(snapshot?.intents) ? snapshot.intents : [];
      const agents = Array.isArray(snapshot?.agents) ? snapshot.agents : [];
      const named = explicitId(message, intents);
      const ranked = intents.map((intent) => ({
        intent,
        score: overlap(message, `${intent.title} ${intent.objective} ${intent.next_action || ""}`),
      })).sort((a, b) => b.score - a.score || a.intent.intent_id.localeCompare(b.intent.intent_id));
      const match = named || (ranked[0]?.score >= minimumMatch ? ranked[0].intent : null);

      let action;
      let confidence;
      const why = [];
      if (/^(status|progress|what(?:'s| is) (?:the )?status)\b/.test(lower)) {
        action = { type: "status", intent_id: match?.intent_id || "" };
        confidence = match ? 1 : 0.7;
        why.push(match ? "status request names or matches an existing intent" : "status request applies to the current intent projection");
      } else if (/^(merge|combine)\b/.test(lower)) {
        const ids = intents.filter((item) => lower.includes(item.intent_id.toLowerCase())).map((item) => item.intent_id);
        action = { type: "merge", source_intent_ids: ids, target_intent_id: ids.at(-1) || "" };
        confidence = ids.length >= 2 ? 1 : 0.35;
        why.push("explicit merge language");
      } else if (/^(fork|branch|split)\b/.test(lower)) {
        action = { type: "fork", parent_intent_id: match?.intent_id || "", title: title(message), objective: message };
        confidence = match ? 0.95 : 0.55;
        why.push("explicit fork language");
      } else if (/^(launch|start agent|reopen agent)\b/.test(lower)) {
        action = { type: "launch", intent_id: match?.intent_id || "", reopen: lower.includes("reopen") };
        confidence = match ? 0.95 : 0.45;
        why.push("explicit launch language");
      } else if (/^(steer|tell agent|send to agent|continue with)\b/.test(lower)) {
        const agent = agents.find((item) => lower.includes(item.agent_id.toLowerCase()))
          || agents.find((item) => item.intent_id === match?.intent_id && ["running", "registered"].includes(item.status));
        action = { type: "steer", intent_id: match?.intent_id || agent?.intent_id || "", agent_id: agent?.agent_id || "", message };
        confidence = agent ? 0.95 : 0.4;
        why.push(agent ? "active registered agent is available" : "steering requested but no durable-message target was established");
      } else if (/^(note|observe|observation|fyi)\b/.test(lower)) {
        action = { type: "observation", intent_id: match?.intent_id || "", note: message };
        confidence = match ? 0.85 : 0.65;
        why.push("message is explicitly observational");
      } else if (match) {
        action = { type: "update", intent_id: match.intent_id, next_action: message };
        confidence = named ? 1 : ranked[0].score;
        why.push(named ? "message explicitly names the intent" : "message overlaps the existing intent");
      } else {
        action = { type: "new", title: title(message), objective: message };
        confidence = 0.6;
        why.push("no existing intent cleared the conservative match threshold");
      }
      validateAction(action);
      const targetIds = [
        action.intent_id, action.parent_intent_id, action.target_intent_id,
        ...(action.source_intent_ids || []),
      ].filter(Boolean);
      return Object.freeze({
        schema: "chief-moa.agent-switchboard.route-decision.v1",
        decision_id: stableDecisionId(envelope.envelope_id, action.type, targetIds),
        source_envelope_id: envelope.envelope_id,
        snapshot_revision: snapshot?.revision || snapshot?.observed_at || "unknown",
        action,
        confidence,
        reasons: why,
        visibility: "required",
        state: "proposed",
        reversible: true,
        links: {
          source_envelope_id: envelope.envelope_id,
          intent_ids: targetIds,
          message_ids: [],
          run_ids: [],
        },
      });
    },
  };
}
