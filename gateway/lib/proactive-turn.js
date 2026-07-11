"use strict";

const PROACTIVE_TURN_MAX_BODY_BYTES = 2048;

const PROACTIVE_ACCEPTED_PROMPTS = Object.freeze([
  "Help me make a checklist for reviewing this form's structure.",
  "Help me plan an analysis for a table.",
  "Help me organize a task surface.",
  "Help me plan a concise document summary.",
]);

const PROACTIVE_PROMPT_SET = new Set(PROACTIVE_ACCEPTED_PROMPTS);
const PROACTIVE_FALLBACKS = new Map([
  [
    PROACTIVE_ACCEPTED_PROMPTS[0],
    "Review the form's purpose, required fields, labels, validation rules, error states, keyboard order, and final confirmation step.",
  ],
  [
    PROACTIVE_ACCEPTED_PROMPTS[1],
    "Define the question first, then identify the relevant columns, data types, missing values, useful groupings, comparisons, and the output you want.",
  ],
  [
    PROACTIVE_ACCEPTED_PROMPTS[2],
    "Group related items, separate outcomes from next actions, mark blockers and dependencies, choose one next step, and archive anything no longer active.",
  ],
  [
    PROACTIVE_ACCEPTED_PROMPTS[3],
    "Capture the document's purpose, main claim, key supporting points, important constraints, open questions, and a short takeaway.",
  ],
]);
const TOP_LEVEL_KEYS = Object.freeze(["client", "modality", "source", "transcript"]);
const CLIENT_KEYS = Object.freeze(["input", "platform", "source"]);

const PROACTIVE_SYSTEM_PROMPT = [
  "This is a user-approved, text-only proactive-help request.",
  "The request contains only a fixed packaged category prompt; no page content, URL, title, selection, form value, screen context, session history, or accessibility data is available.",
  "Answer with concise, generally useful prose for that category. Informational steps are inert advice, not executable instructions.",
  "Do not call or request tools, delegate work, start an agent or task, emit an action/proposal object, return structured machine commands, or claim anything was executed or saved.",
].join(" ");

class ProactiveTurnValidationError extends Error {
  constructor(code, statusCode = 422) {
    super(code);
    this.name = "ProactiveTurnValidationError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function assertExactKeys(value, expected, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProactiveTurnValidationError(code);
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new ProactiveTurnValidationError(code);
  }
}

function validateProactiveTurnBody(body) {
  assertExactKeys(body, TOP_LEVEL_KEYS, "invalid_request_shape");
  assertExactKeys(body.client, CLIENT_KEYS, "invalid_client_shape");

  if (body.source !== "proactive_accept_v1") {
    throw new ProactiveTurnValidationError("invalid_source");
  }
  if (body.modality !== "text") {
    throw new ProactiveTurnValidationError("invalid_modality");
  }
  if (!PROACTIVE_PROMPT_SET.has(body.transcript)) {
    throw new ProactiveTurnValidationError("unrecognized_prompt");
  }
  if (
    body.client.platform !== "browser"
    || body.client.source !== "agee-extension"
    || body.client.input !== "text"
  ) {
    throw new ProactiveTurnValidationError("invalid_client");
  }

  return Object.freeze({ transcript: body.transcript });
}

function buildProactiveModelMessages(transcript) {
  if (!PROACTIVE_PROMPT_SET.has(transcript)) {
    throw new ProactiveTurnValidationError("unrecognized_prompt");
  }
  return [
    { role: "system", content: PROACTIVE_SYSTEM_PROMPT },
    { role: "user", content: transcript },
  ];
}

function proactiveTurnResponse(text) {
  const safeText = String(text || "")
    .replace(/[\u0000\u000B\u000C\u007F]/g, " ")
    .trim()
    .slice(0, 4000)
    .trim();
  if (!safeText) {
    throw new Error("proactive model returned an empty reply");
  }
  return {
    source: "proactive_accept_v1",
    classification: "proactive_text_only",
    persisted: false,
    display: safeText,
    text: safeText,
    actions: [],
  };
}

function proactiveFallbackReply(transcript) {
  return PROACTIVE_FALLBACKS.get(transcript) || "";
}

module.exports = {
  PROACTIVE_ACCEPTED_PROMPTS,
  PROACTIVE_SYSTEM_PROMPT,
  PROACTIVE_TURN_MAX_BODY_BYTES,
  ProactiveTurnValidationError,
  buildProactiveModelMessages,
  proactiveFallbackReply,
  proactiveTurnResponse,
  validateProactiveTurnBody,
};
