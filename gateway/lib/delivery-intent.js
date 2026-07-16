"use strict";

const DELIVERY_INTENTS = Object.freeze({
  LITERAL_TEXT: "literal_text",
  ASSISTANT_RESPONSE: "assistant_response",
});

const DELIVERY_CAPABILITIES = Object.freeze([
  "model",
  "tools",
  "memory",
  "tts",
  "agent_dispatch",
  "approved_evidence",
]);

const LITERAL_POLICY = createPolicy("literal_candidate", false);
const ASSISTANT_POLICY = createPolicy("assistant_pipeline", true);

class DeliveryIntentValidationError extends TypeError {
  constructor(code, message) {
    super(message);
    this.name = "DeliveryIntentValidationError";
    this.code = code;
  }
}

function createPolicy(route, allowed) {
  const capabilities = Object.freeze(Object.fromEntries(
    DELIVERY_CAPABILITIES.map((capability) => [capability, allowed]),
  ));
  return Object.freeze({ route, capabilities });
}

function parseDeliveryIntent(input) {
  const value = input && typeof input === "object" && !Array.isArray(input)
    ? input.delivery_intent
    : input;
  if (value === undefined || value === null || value === "") {
    throw new DeliveryIntentValidationError(
      "delivery_intent_required",
      "delivery_intent is required",
    );
  }
  if (typeof value !== "string") {
    throw new DeliveryIntentValidationError(
      "delivery_intent_invalid_type",
      "delivery_intent must be a string",
    );
  }
  const normalized = value.trim();
  if (!Object.values(DELIVERY_INTENTS).includes(normalized)) {
    throw new DeliveryIntentValidationError(
      "delivery_intent_unsupported",
      "delivery_intent must be literal_text or assistant_response",
    );
  }
  return normalized;
}

function validateDeliveryRequest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new DeliveryIntentValidationError(
      "delivery_request_invalid_type",
      "delivery request must be an object",
    );
  }
  const deliveryIntent = parseDeliveryIntent(input);
  if (typeof input.transcript !== "string" || !input.transcript.trim()) {
    throw new DeliveryIntentValidationError(
      "transcript_required",
      "transcript must be a non-empty string",
    );
  }
  return Object.freeze({
    delivery_intent: deliveryIntent,
    transcript: input.transcript,
  });
}

function deliveryIntentPolicy(input) {
  return parseDeliveryIntent(input) === DELIVERY_INTENTS.LITERAL_TEXT
    ? LITERAL_POLICY
    : ASSISTANT_POLICY;
}

function canUseDeliveryCapability(input, capability) {
  if (!DELIVERY_CAPABILITIES.includes(capability)) return false;
  return deliveryIntentPolicy(input).capabilities[capability];
}

async function routeDeliveryRequest(input, hooks) {
  const request = validateDeliveryRequest(input);
  if (request.delivery_intent === DELIVERY_INTENTS.LITERAL_TEXT) {
    return Object.freeze({
      candidate: Object.freeze({
        kind: DELIVERY_INTENTS.LITERAL_TEXT,
        text: request.transcript,
      }),
    });
  }

  const assistantResponse = hooks?.assistantResponse;
  if (typeof assistantResponse !== "function") {
    throw new TypeError("assistantResponse hook is required for assistant_response");
  }
  return assistantResponse(Object.freeze({
    request,
    policy: ASSISTANT_POLICY,
    source: input,
  }));
}

module.exports = {
  DELIVERY_INTENTS,
  DELIVERY_CAPABILITIES,
  DeliveryIntentValidationError,
  parseDeliveryIntent,
  validateDeliveryRequest,
  deliveryIntentPolicy,
  canUseDeliveryCapability,
  routeDeliveryRequest,
};
