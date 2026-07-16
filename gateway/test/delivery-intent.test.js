"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DELIVERY_INTENTS,
  DELIVERY_CAPABILITIES,
  DeliveryIntentValidationError,
  parseDeliveryIntent,
  validateDeliveryRequest,
  deliveryIntentPolicy,
  canUseDeliveryCapability,
  routeDeliveryRequest,
} = require("../lib/delivery-intent");

function assertValidationError(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof DeliveryIntentValidationError);
    assert.equal(error.code, code);
    return true;
  });
}

test("parses only the two explicit delivery intents", () => {
  assert.equal(parseDeliveryIntent("literal_text"), DELIVERY_INTENTS.LITERAL_TEXT);
  assert.equal(
    parseDeliveryIntent({ delivery_intent: "  assistant_response  " }),
    DELIVERY_INTENTS.ASSISTANT_RESPONSE,
  );
  assert.ok(Object.isFrozen(DELIVERY_INTENTS));
  assert.ok(Object.isFrozen(DELIVERY_CAPABILITIES));
});

test("rejects absent, mistyped, and unsupported delivery intents", () => {
  for (const value of [undefined, null, "", {}]) {
    assertValidationError(() => parseDeliveryIntent(value), "delivery_intent_required");
  }
  for (const value of [42, [], { delivery_intent: false }]) {
    assertValidationError(() => parseDeliveryIntent(value), "delivery_intent_invalid_type");
  }
  for (const value of ["literal", "ask", "LITERAL_TEXT", "   "]) {
    assertValidationError(() => parseDeliveryIntent(value), "delivery_intent_unsupported");
  }
});

test("validates a request while preserving the exact transcript", () => {
  const request = validateDeliveryRequest({
    delivery_intent: "literal_text",
    transcript: "  exact words\n",
    ignored: "not projected",
  });
  assert.deepEqual(request, {
    delivery_intent: "literal_text",
    transcript: "  exact words\n",
  });
  assert.ok(Object.isFrozen(request));

  for (const input of [null, [], "request"]) {
    assertValidationError(() => validateDeliveryRequest(input), "delivery_request_invalid_type");
  }
  for (const transcript of [undefined, null, "", "   ", 42]) {
    assertValidationError(
      () => validateDeliveryRequest({ delivery_intent: "literal_text", transcript }),
      "transcript_required",
    );
  }
});

test("literal policy denies every model-side and dispatch capability", () => {
  const policy = deliveryIntentPolicy("literal_text");
  assert.equal(policy.route, "literal_candidate");
  assert.ok(Object.isFrozen(policy));
  assert.ok(Object.isFrozen(policy.capabilities));
  assert.deepEqual(policy.capabilities, {
    model: false,
    tools: false,
    memory: false,
    tts: false,
    agent_dispatch: false,
    approved_evidence: false,
  });
  for (const capability of DELIVERY_CAPABILITIES) {
    assert.equal(canUseDeliveryCapability("literal_text", capability), false);
  }
  assert.equal(canUseDeliveryCapability("literal_text", "unknown"), false);
});

test("assistant policy delegates to the existing pipeline with approved evidence available", () => {
  const policy = deliveryIntentPolicy({ delivery_intent: "assistant_response" });
  assert.equal(policy.route, "assistant_pipeline");
  for (const capability of DELIVERY_CAPABILITIES) {
    assert.equal(canUseDeliveryCapability("assistant_response", capability), true);
  }
});

test("literal routing returns only the exact candidate and never reads effect hooks", async () => {
  const hooks = new Proxy({}, {
    get(_target, property) {
      throw new Error(`literal route touched ${String(property)}`);
    },
  });
  const result = await routeDeliveryRequest({
    delivery_intent: "literal_text",
    transcript: "Do not normalize me.  ",
    approved_evidence: { screenshot: "must-not-be-read" },
  }, hooks);
  assert.deepEqual(result, {
    candidate: {
      kind: "literal_text",
      text: "Do not normalize me.  ",
    },
  });
  assert.deepEqual(Object.keys(result), ["candidate"]);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.candidate));
});

test("assistant routing calls one existing-pipeline hook and preserves source evidence", async () => {
  const source = {
    delivery_intent: "assistant_response",
    transcript: "Draft from what I approved",
    approved_evidence: { digest: "sha256:test" },
  };
  let calls = 0;
  const result = await routeDeliveryRequest(source, {
    async assistantResponse(context) {
      calls += 1;
      assert.equal(context.source, source);
      assert.deepEqual(context.request, {
        delivery_intent: "assistant_response",
        transcript: source.transcript,
      });
      assert.equal(context.policy.route, "assistant_pipeline");
      return { reply: "draft" };
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, { reply: "draft" });

  await assert.rejects(
    routeDeliveryRequest(source),
    /assistantResponse hook is required/,
  );
  await assert.rejects(
    routeDeliveryRequest(source, { assistantResponse: "not a function" }),
    /assistantResponse hook is required/,
  );
});
