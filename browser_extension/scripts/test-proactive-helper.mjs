import assert from "node:assert/strict";

delete globalThis.AgeeProactiveHelper;
await import(`../extension/proactive-helper.js?test=${Date.now()}`);
const helper = globalThis.AgeeProactiveHelper;
assert.ok(helper, "proactive helper must install a browser/Node-compatible global");

const safe = helper.sanitizeSignals({
  article_count: 2.9,
  heading_count: 9999,
  paragraph_count: -2,
  page_text: "SENTINEL_BODY_MUST_NOT_SURVIVE",
  url: "https://private.example/secret",
  title: "Private title",
  form_values: { password: "secret" },
});
assert.deepEqual(Object.keys(safe).sort(), [
  "article_count",
  "button_count",
  "editable_count",
  "form_count",
  "heading_count",
  "link_count",
  "list_count",
  "paragraph_count",
  "schema_version",
  "table_count",
  "task_count",
].sort());
assert.equal(safe.article_count, 2);
assert.equal(safe.heading_count, 100);
assert.equal(safe.paragraph_count, 0);
assert.ok(!JSON.stringify(safe).includes("SENTINEL"));

assert.equal(helper.classifyStructuralPage({ form_count: 1, editable_count: 2 })?.kind, "form");
assert.equal(helper.classifyStructuralPage({ table_count: 1, paragraph_count: 20 })?.kind, "table");
assert.equal(helper.classifyStructuralPage({ task_count: 3 })?.kind, "tasks");
assert.equal(helper.classifyStructuralPage({ heading_count: 2, paragraph_count: 6 })?.kind, "document");
assert.equal(helper.classifyStructuralPage({ link_count: 2 }), null);
assert.equal(
  helper.buildAcceptedPrompt({ kind: "table", instruction: "SENTINEL_UNTRUSTED_PROMPT" }),
  "Help me plan an analysis for a table."
);
assert.equal(helper.buildAcceptedPrompt({ kind: "unknown" }), "");

function fakeDocument({ password = false, autocomplete = [], forms = [] } = {}) {
  return {
    querySelector(selector) {
      if (selector.startsWith('input[type="password"')) return password ? {} : null;
      if (selector.includes("autocomplete~=")) {
        const sensitive = new Set([
          "current-password", "new-password", "one-time-code", "cc-name", "cc-given-name",
          "cc-additional-name", "cc-family-name", "cc-number", "cc-exp", "cc-exp-month",
          "cc-exp-year", "cc-csc", "cc-type", "transaction-currency", "transaction-amount",
        ]);
        return autocomplete.some((value) => String(value).toLowerCase().split(/\s+/).some((token) => sensitive.has(token))) ? {} : null;
      }
      if (selector.startsWith("form[")) {
        const metadata = forms.flatMap((value) => Object.values(value)).join(" ");
        return /(auth|login|log-in|sign[ -]?in|password|credential|checkout|payment|billing|bank|wallet|card|patient|health|medical|tax|payroll|vault|security)/i.test(metadata) ? {} : null;
      }
      return null;
    },
    querySelectorAll(selector) {
      if (selector === "[autocomplete]") {
        return autocomplete.map((value) => ({ getAttribute: () => value }));
      }
      if (selector === "form") {
        return forms.map((metadata) => ({
          getAttribute(name) { return metadata[name] || ""; },
        }));
      }
      return [];
    },
  };
}

const safeLocation = { protocol: "https:", hostname: "example.test", pathname: "/notes", search: "" };
assert.deepEqual(helper.detectSensitivePage(fakeDocument(), safeLocation), { suppressed: false, reason: "" });
assert.equal(helper.detectSensitivePage(fakeDocument(), { ...safeLocation, pathname: "/oauth/authorize" }).reason, "sensitive_route");
assert.equal(helper.detectSensitivePage(fakeDocument(), { ...safeLocation, pathname: "/%63heckout" }).reason, "sensitive_route");
assert.equal(helper.detectSensitivePage(fakeDocument(), { ...safeLocation, hash: "#/checkout/payment" }).reason, "sensitive_route");
assert.equal(
  helper.detectSensitivePage(fakeDocument(), { ...safeLocation, pathname: `/${"a".repeat(4096)}`, hash: "#payment" }).reason,
  "sensitive_route"
);
assert.equal(
  helper.detectSensitivePage(fakeDocument(), { ...safeLocation, pathname: `/${"a".repeat(9000)}/checkout` }).reason,
  "route_too_long"
);
assert.equal(helper.detectSensitivePage(fakeDocument({ password: true }), safeLocation).reason, "password_field");
assert.equal(helper.detectSensitivePage(fakeDocument({ autocomplete: ["username current-password"] }), safeLocation).reason, "sensitive_autocomplete");
assert.equal(helper.detectSensitivePage(fakeDocument({ forms: [{ action: "/checkout/payment" }] }), safeLocation).reason, "sensitive_form");
assert.equal(helper.detectSensitivePage(fakeDocument(), { ...safeLocation, protocol: "chrome:" }).reason, "unsupported_protocol");

const originalChrome = globalThis.chrome;
const originalFetch = globalThis.fetch;
globalThis.chrome = {
  runtime: { getURL: (path) => `chrome-extension://test/${path}` },
  storage: {
    local: {
      get: async () => ({
        ageeGatewayUrl: "",
        ageeGatewayToken: "STALE_TOKEN_MUST_NOT_SURVIVE_DISCONNECT",
        ageeGatewayUserSet: true,
      }),
    },
  },
};
globalThis.fetch = async () => ({
  ok: true,
  json: async () => ({ gatewayUrl: "https://packaged.example", gatewayToken: "PACKAGED_TOKEN" }),
});

const config = await import(`../extension/config.js?test=${Date.now()}`);
assert.equal(config.effectiveGatewayUrl("", "https://packaged.example", true), "");
assert.equal(config.effectiveGatewayUrl("", "https://packaged.example", false), "https://packaged.example");
assert.equal(config.effectiveGatewayUrl("https://saved.example/base", "https://packaged.example", true), "");
assert.equal(config.gatewayUrlDiagnostic("https://api.agee.app/").ok, true);
assert.equal(config.gatewayUrlDiagnostic("https://api.agee.app/tenant").code, "endpoint_path");
assert.equal(config.gatewayUrlDiagnostic("https://api.agee.app?tenant=one").code, "query_or_fragment");
assert.equal(config.gatewayUrlDiagnostic("https://api.agee.app#tenant").code, "query_or_fragment");
assert.equal(config.gatewayUrlDiagnostic("https://api.agee.app/?").code, "non_canonical_origin");
assert.equal(config.gatewayUrlDiagnostic("https://api.agee.app/#").code, "non_canonical_origin");
assert.equal(config.gatewayUrlDiagnostic("https://user:secret@api.agee.app").code, "credentials");
assert.deepEqual(await config.getEffectiveGatewayConfig(), { gatewayUrl: "", gatewayToken: "" });

globalThis.chrome = originalChrome;
globalThis.fetch = originalFetch;

console.log("proactive helper unit checks passed");
