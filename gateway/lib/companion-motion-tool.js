"use strict";

const TARGETS = Object.freeze(["corner_top_left", "corner_top_right", "corner_bottom_left", "corner_bottom_right", "center", "pointer"]);
const MAX_DURATION_MS = 60_000;

function createCompanionMotionTool(commandVerbs) {
  return {
    name: "companion_motion",
    description: `Move the on-screen companion. verb must be one of: ${commandVerbs.join(", ")}; target is one of ${TARGETS.join(", ")} or null. This returns a proposal; the client validates and animates it.`,
    parameters: {
      type: "object",
      properties: {
        verb: { type: "string", description: `Motion verb: ${commandVerbs.join(", ")}.` },
        target: { type: "string", description: `Target: ${TARGETS.join(", ")}, or null.` },
        duration_ms: { type: "number", description: "Optional duration in milliseconds." },
      },
      required: ["verb"],
    },
    handler: (args = {}) => {
      const verb = String(args.verb || "").trim().toLowerCase();
      if (!commandVerbs.includes(verb)) return { ok: false, type: "companion_motion_rejected", error: `unsupported motion verb; use one of: ${commandVerbs.join(", ")}`, supported_verbs: commandVerbs.slice() };
      let target = null;
      if (args.target !== null && args.target !== undefined && String(args.target).trim() !== "") {
        target = String(args.target).trim().toLowerCase();
        if (!TARGETS.includes(target)) return { ok: false, type: "companion_motion_rejected", error: `unsupported motion target; use one of: ${TARGETS.join(", ")}, or null`, supported_targets: TARGETS.slice() };
      }
      const duration = Number(args.duration_ms ?? args.durationMs);
      const plan = { renderer: "shimeji-web", verb, target, ...(Number.isFinite(duration) && duration > 0 ? { duration_ms: Math.min(Math.round(duration), MAX_DURATION_MS) } : {}) };
      return { ok: true, type: "companion_motion", action: { type: "companion_motion", plan }, plan, message: `Proposed a ${plan.verb}${plan.target ? ` to ${plan.target}` : ""} motion for the companion; the on-screen runtime will animate it.` };
    },
  };
}

module.exports = { createCompanionMotionTool };
