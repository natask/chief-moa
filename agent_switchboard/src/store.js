export function createMemoryDecisionStore() {
  const decisions = new Map();
  return {
    async save(decision) {
      const current = decisions.get(decision.decision_id);
      if (current && (
        current.source_envelope_id !== decision.source_envelope_id
        || JSON.stringify(current.action) !== JSON.stringify(decision.action)
      )) {
        throw new Error(`decision id collision: ${decision.decision_id}`);
      }
      decisions.set(decision.decision_id, structuredClone(decision));
      return structuredClone(decision);
    },
    async get(id) {
      const value = decisions.get(id);
      return value ? structuredClone(value) : null;
    },
    async list() {
      return [...decisions.values()].map(structuredClone);
    },
    async supersede(id, compensatingDecision) {
      const current = decisions.get(id);
      if (!current) throw new Error("route decision not found");
      if (current.state === "reversed") return structuredClone(current);
      decisions.set(id, { ...current, state: "reversed", reversed_by: compensatingDecision.decision_id });
      decisions.set(compensatingDecision.decision_id, structuredClone(compensatingDecision));
      return structuredClone(decisions.get(id));
    },
  };
}
