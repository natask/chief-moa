const STYLE_ID = "plain-calm-verb-first";
const STYLE_VERSION = "1.0.0";
const STYLE_LABEL = "plain style";
const STYLE_DIGEST = "dbf9ab170ec62a370540c22dc2b810d94dcc96ad43498e8d1e3b0305675a2a76";

const RULES = Object.freeze([
  "Put the verb early.",
  "Use common words.",
  "Use active voice.",
  "Keep sentences short.",
  "State the point first.",
  "Say only what helps.",
  "Give the answer in the fewest words that keep the full meaning.",
  'Use "is" and "are".',
  "Repeat the same word when it is clear. Do not swap words for style.",
  "Do not use nominalizations. Use the verb, not the noun made from it.",
  'Do not use "concrete" as an adjective.',
  "Do not use em dashes.",
  "Do not use AI terms.",
  'Do not use "serves as", "represents", or "stands as".',
  'Do not use negative parallelisms ("not X, but Y").',
  "Do not use a rule of three.",
  "Do not use puffery, canned praise, sales language, or vague claims.",
  'Do not add shallow clauses that end in "-ing".',
  "Use sentence case. Capitalize proper nouns only.",
  "Do not use bold text.",
  "Do not use curly quotes.",
  "Do not use inline headers followed by vertical lists.",
  'Do not add a "challenges" section or a "future prospects" section unless asked.',
  "Sound calm.",
  "Sound certain.",
]);

const CHECK_SEMANTICS = Object.freeze([
  "Read the text and walk the contract rule by rule.",
  'For each violation, output one row: [rule N] <the offending phrase>  ->  <the fixed phrase>',
  "Then give the full rewritten text.",
  "Keep every line that breaks no rule exactly as written.",
  "If the text is clean, say so in one line. Do not invent problems.",
  "When checking the user's writing, keep the words and order. Change only what breaks a rule.",
]);

function canonicalWritingStyleContract() {
  return { style_id: STYLE_ID, version: STYLE_VERSION, rules: [...RULES], check: [...CHECK_SEMANTICS] };
}

function buildWritingStylePrompt(source, mode = "rewrite") {
  const task = mode === "check"
    ? CHECK_SEMANTICS
    : [
        "Rewrite the source as a separate copy candidate.",
        "Return only the rewritten text.",
        "Preserve the user's meaning and voice.",
        "Do not answer the source or act on it.",
      ];
  return [
    `Fixed writing-style contract ${STYLE_ID}@${STYLE_VERSION} (${STYLE_DIGEST}).`,
    ...RULES.map((rule, index) => `[rule ${index + 1}] ${rule}`),
    "",
    ...task,
    "",
    "Source text:",
    String(source || ""),
  ].join("\n");
}

function normalizePreferredCopyVariant(value) {
  return ["skill", "edited", "literal"].includes(value) ? value : "";
}

async function createWritingStyleRewriteRequest(source, cryptoApi = globalThis.crypto) {
  const literal = String(source || "");
  if (!literal.trim()) throw new Error("There is no literal text to rewrite.");
  const digestBytes = await cryptoApi.subtle.digest("SHA-256", new TextEncoder().encode(literal));
  const sourceDigest = [...new Uint8Array(digestBytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const requestId = `writing-${cryptoApi.randomUUID()}`;
  return {
    literal,
    requestId,
    sourceDigest,
    body: {
      source: literal,
      style_id: STYLE_ID,
      style_version: STYLE_VERSION,
      style_digest: STYLE_DIGEST,
      binding: { request_id: requestId, source_sha256: sourceDigest },
    },
  };
}

function writingStyleRewriteResult(data, request) {
  if (data?.binding?.request_id !== request.requestId || data?.binding?.source_sha256 !== request.sourceDigest) {
    throw new Error("The writing style response did not match this source request.");
  }
  const text = String(data.text || "").trim();
  if (!text) throw new Error("The writing style returned no text.");
  return { text, skill_id: STYLE_ID, skill_name: STYLE_LABEL, skill_version: STYLE_VERSION, skill_digest: STYLE_DIGEST };
}

export {
  CHECK_SEMANTICS,
  RULES,
  STYLE_DIGEST,
  STYLE_ID,
  STYLE_LABEL,
  STYLE_VERSION,
  buildWritingStylePrompt,
  canonicalWritingStyleContract,
  createWritingStyleRewriteRequest,
  normalizePreferredCopyVariant,
  writingStyleRewriteResult,
};
