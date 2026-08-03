export function videoEvidenceRef(intent) {
  return (Array.isArray(intent?.evidence_refs) ? intent.evidence_refs : [])
    .find((ref) => /^video-note:\/\/[a-zA-Z0-9_-]+$/.test(String(ref || ""))) || "";
}

export function videoNoteId(intent) {
  return videoEvidenceRef(intent).slice("video-note://".length);
}

export function videoIntentItems(payload) {
  return (Array.isArray(payload?.items) ? payload.items : [])
    .filter((intent) => videoEvidenceRef(intent))
    .sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
}

export function videoIntentEditCommand(intent, text, idempotencyKey) {
  const objective = String(text || "");
  if (!objective.trim()) throw new Error("Intent text cannot be empty.");
  if (objective.length > 2_000) throw new Error("Intent text must be 2,000 characters or fewer; the full source transcript remains preserved.");
  return {
    type: "intent.enriched",
    statement: objective,
    normalized_objective: objective,
    next_step: "Review this captured intent before any dispatch.",
    source_receipt_refs: [videoEvidenceRef(intent)].filter(Boolean),
    expected_intent_version: Number(intent?.version || 0),
    idempotency_key: String(idempotencyKey || ""),
  };
}
