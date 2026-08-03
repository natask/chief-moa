"use strict";

function extractPlan(textInput) {
  const text = String(textInput || "").trim();
  if (!text) throw new Error("planner returned no task graph");
  const unfenced = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const starts = [unfenced.indexOf("{"), unfenced.indexOf("[")].filter((index) => index >= 0);
  if (!starts.length) throw new Error("planner returned no JSON task graph");
  const start = Math.min(...starts);
  const end = Math.max(unfenced.lastIndexOf("}"), unfenced.lastIndexOf("]"));
  if (end < start) throw new Error("planner returned incomplete JSON");
  let parsed;
  try { parsed = JSON.parse(unfenced.slice(start, end + 1)); }
  catch { throw new Error("planner returned invalid JSON"); }
  const tasks = Array.isArray(parsed) ? parsed : parsed?.tasks;
  if (!Array.isArray(tasks)) throw new Error("planner JSON must contain tasks");
  return tasks;
}

function excerpt(value, max) {
  const text = String(value || "");
  return text.length <= max ? text : `${text.slice(0, max - 14)}\n[truncated]`;
}

function planningMessages(intent) {
  const acceptanceCriteria = intent.acceptance_criteria || [];
  const evidenceRefs = intent.evidence_refs || [];
  const criteria = acceptanceCriteria.length ? acceptanceCriteria.slice(0, 20).map((item) => `- ${excerpt(item, 400)}`).join("\n") : "- Derive observable checks from the riff.";
  const evidence = evidenceRefs.length ? evidenceRefs.slice(0, 20).map((item) => `- ${excerpt(item, 500)}`).join("\n") : "- No attached media.";
  return [
    {
      role: "system",
      content: [
        "Turn one user's development riff into a small dependency graph.",
        "Return JSON only: {\"tasks\":[...]}. Use 2-32 narrow tasks.",
        "Each task needs task_id, title, kind, depends_on, path_claims, acceptance_check, estimated_memory_mb, and parallel_safe.",
        "kind is implementation, qa, or integration. Independent path claims may run in parallel.",
        "Add one non-parallel integration task after implementation and one final QA task after integration.",
        "Do not add deployment. User acceptance owns the later release handoff.",
      ].join(" "),
    },
    {
      role: "user",
      content: [
        `Intent: ${intent.intent_id}`,
        `Objective: ${intent.objective || "Use the raw riff."}`,
        "",
        "Raw riff:", excerpt(intent.riff, 40_000),
        "",
        "Acceptance criteria:", criteria,
        "",
        "Attached evidence:", evidence,
      ].join("\n"),
    },
  ];
}

module.exports = { extractPlan, planningMessages };
