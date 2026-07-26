const join = (base, path) => `${String(base).replace(/\/+$/, "")}${path}`;

export function createChiefMoaIntentAdapter({ baseUrl, token, fetchImpl = globalThis.fetch }) {
  if (!baseUrl || typeof fetchImpl !== "function") throw new Error("baseUrl and fetch are required");
  const request = async (path, init = {}) => {
    const response = await fetchImpl(join(baseUrl, path), {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || `Chief MOA request failed: ${response.status}`);
    return body;
  };
  return {
    async readSnapshot() {
      const projection = await request("/v1/intent-plane?limit=500");
      return { ...projection, revision: projection.page?.total ?? 0, observed_at: new Date().toISOString() };
    },
    async readAttention() {
      const projection = await request("/v1/intent-plane?limit=500");
      return projection.notifications?.filter((item) => item.receipt_state !== "received") || [];
    },
    async readIntent(intentId) {
      return (await request(`/v1/intent-plane/intents/${encodeURIComponent(intentId)}/explain`));
    },
    async createIntent(input) {
      return (await request("/v1/intent-plane/intents", { method: "POST", body: JSON.stringify(input) })).intent;
    },
    async updateIntent(intentId, input) {
      return (await request(`/v1/intent-plane/intents/${encodeURIComponent(intentId)}`, { method: "PATCH", body: JSON.stringify(input) })).intent;
    },
    async recordObservation(input) {
      if (!input.intent_id) return { observation: input.note, source_envelope_id: input.source_envelope_id };
      return this.updateIntent(input.intent_id, { next_action: input.note });
    },
    async mergeIntents() {
      throw new Error("Chief MOA intent-plane v1 has no merge mutation; inject a merge-capable adapter");
    },
  };
}
