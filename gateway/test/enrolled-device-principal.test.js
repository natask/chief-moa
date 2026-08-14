"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { attachEnrolledDevicePrincipal } = require("../lib/enrolled-device-principal");

test("verified Ag device becomes the owner-bound gateway principal", async () => {
  const request = { headers: { authorization: "Device opaque" } };
  const principal = await attachEnrolledDevicePrincipal(request, async () => ({
    tenant_id: "tenant_1",
    owner_id: "owner_1",
    device_id: "android_1",
    surface_id: "android",
    credential_id: "devc_1",
    application_id: "ag.companion",
    scopes: ["continuity.read", "conversation.read", "conversation.write", "profile.read"],
  }));

  assert.equal(principal.user_id, "owner_1");
  assert.equal(principal.kind, "enrolled_device");
  assert.equal(request.moaAuthPrincipal, principal);
});

test("wrong app and read-only credentials never gain normal gateway access", async () => {
  for (const device of [
    { owner_id: "owner_1", application_id: "other.app", scopes: ["conversation.read", "conversation.write"] },
    { owner_id: "owner_1", application_id: "ag.companion", scopes: ["conversation.read"] },
  ]) {
    const request = { headers: {} };
    assert.equal(await attachEnrolledDevicePrincipal(request, async () => device), null);
    assert.equal(request.moaAuthPrincipal, undefined);
  }
});

test("existing Better Auth principal is never replaced", async () => {
  const existing = { user_id: "owner" };
  const request = { moaAuthPrincipal: existing, headers: {} };
  let called = false;
  assert.equal(await attachEnrolledDevicePrincipal(request, async () => {
    called = true;
    return null;
  }), null);
  assert.equal(called, false);
  assert.equal(request.moaAuthPrincipal, existing);
});
