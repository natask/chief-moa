import assert from "node:assert/strict";
import test from "node:test";
import { authorizeCdpCommand, compactCdpOutput } from "../extension/browser-cdp-policy.js";

test("automation grants Runtime.evaluate and broad page-local CDP", () => {
  for (const method of ["Runtime.evaluate", "Page.navigate", "DOM.getDocument", "Input.insertText", "Accessibility.getFullAXTree", "Emulation.setDeviceMetricsOverride"]) {
    assert.equal(authorizeCdpCommand({ method, params: method === "Runtime.evaluate" ? { expression: "document.title" } : {}, profile: "automation", tabUrl: "https://example.com/" }).ok, true, method);
  }
});

test("profiles and command budgets fail closed", () => {
  assert.equal(authorizeCdpCommand({ method: "Runtime.evaluate", profile: "semantic", tabUrl: "https://example.com/" }).code, "profile_method_denied");
  assert.equal(authorizeCdpCommand({ method: "Page.navigate", profile: "root", tabUrl: "https://example.com/" }).code, "invalid_authority_profile");
  assert.equal(authorizeCdpCommand({ method: "Page.navigate", profile: "automation", tabUrl: "https://example.com/", commandIndex: 40 }).code, "command_budget_exceeded");
});

test("cookie, storage, browser-wide, credential-origin, and secret eval paths are denied", () => {
  for (const method of ["Network.getAllCookies", "Storage.getCookies", "DOMStorage.getDOMStorageItems", "Browser.getVersion", "Target.getTargets", "Autofill.trigger"]) {
    assert.equal(authorizeCdpCommand({ method, profile: "debug", tabUrl: "https://example.com/" }).code, "secret_method_denied", method);
  }
  assert.equal(authorizeCdpCommand({ method: "Runtime.evaluate", params: { expression: "document.cookie" }, profile: "automation", tabUrl: "https://example.com/" }).code, "secret_expression_denied");
  assert.equal(authorizeCdpCommand({ method: "Runtime.evaluate", params: { expression: "document.title" }, profile: "automation", tabUrl: "https://accounts.google.com/" }).code, "secret_origin_denied");
  assert.equal(authorizeCdpCommand({ method: "Page.navigate", params: { url: "https://accounts.google.com/" }, profile: "automation", tabUrl: "https://example.com/" }).code, "secret_origin_denied");
});

test("CDP outputs are bounded and screenshot bytes are never returned", () => {
  assert.deepEqual(compactCdpOutput({ data: "abc" }, 2).value, { data_bytes: 3 });
  const bounded = compactCdpOutput({ result: { value: "abcdef" } }, 3);
  assert.equal(bounded.value, "abc");
  assert.equal(bounded.truncated, true);
});
