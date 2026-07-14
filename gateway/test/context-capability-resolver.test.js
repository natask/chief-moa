"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { POLICY, resolveContextCapabilities } = require("../lib/context-capability-resolver");

const NOW = "2026-07-13T18:00:00.000Z";

function browserManifest(overrides = {}) {
  return {
    device_id: "browser-1",
    surface_type: "browser_extension",
    online: true,
    session_authenticated: true,
    capabilities: [{
      name: "github.issue.create.browser",
      capability: "github.issue.create",
      domains: ["github.com"],
      risk: "medium",
    }],
    ...overrides,
  };
}

function githubSource(overrides = {}) {
  return {
    id: "github-api",
    provider_id: "github",
    tools: [{
      name: "issues.create",
      capability: "github.issue.create",
      domains: ["github.com"],
      required_scopes: ["repo"],
      risk: "medium",
    }],
    ...overrides,
  };
}

function baseInput(overrides = {}) {
  return {
    now: NOW,
    observation: {
      surface: "browser_extension",
      observed_at: "2026-07-13T17:59:30.000Z",
      page: { url: "https://github.com/acme/moa/issues", title: "Issues" },
    },
    device_manifests: [browserManifest()],
    tool_sources: [githubSource()],
    account_connections: [{ id: "connection-1", provider_id: "github", status: "active", scopes: ["repo"] }],
    project_context: { id: "moa", providers: ["github"] },
    ...overrides,
  };
}

test("prefers a connected API over an equivalent browser capability", () => {
  const result = resolveContextCapabilities(baseInput());
  assert.equal(result.executed, false);
  assert.equal(result.policy.id, POLICY.id);
  assert.equal(result.candidates[0].route, "api");
  assert.equal(result.candidates[0].recommended, true);
  assert.equal(result.candidates[0].approval.required, true);
  assert.equal(result.candidates[0].freshness.status, "fresh");
  assert.deepEqual(result.missing_access, []);
  assert.doesNotMatch(JSON.stringify(result), /access_token|secret|handler/);
});

test("prefers the authenticated browser session for an unsaved draft", () => {
  const input = baseInput();
  input.observation.page.state = "draft";
  const result = resolveContextCapabilities(input);
  assert.equal(result.candidates[0].route, "browser_session");
  assert.equal(result.candidates[0].recommended, true);
  assert.match(result.candidates[0].reason.join(" "), /authoritative/);
});

test("reports missing API scope and recommends the browser fallback", () => {
  const input = baseInput({
    account_connections: [{ id: "connection-1", provider_id: "github", status: "active", scopes: ["read:user"] }],
  });
  const result = resolveContextCapabilities(input);
  assert.equal(result.candidates[0].route, "browser_session");
  assert.equal(result.candidates[0].recommended, true);
  const api = result.candidates.find((candidate) => candidate.route === "api");
  assert.equal(api.status, "missing_access");
  assert.deepEqual(api.missing_access[0].scopes, ["repo"]);
  assert.equal(result.missing_access[0].kind, "oauth_scope");
});

test("reports login and connection access without inventing an executable route", () => {
  const input = baseInput({
    account_connections: [],
    device_manifests: [browserManifest({ session_authenticated: false })],
  });
  const result = resolveContextCapabilities(input);
  assert.equal(result.candidates.every((candidate) => candidate.status === "missing_access"), true);
  assert.equal(result.candidates.every((candidate) => candidate.recommended === false), true);
  assert.deepEqual(result.missing_access.map((item) => item.kind).sort(), ["account_connection", "browser_login"]);
  assert.equal(result.executed, false);
});

test("uses project context to surface a capability when there is no matching page", () => {
  const result = resolveContextCapabilities(baseInput({
    observation: { surface: "android", observed_at: "2026-07-13T17:59:30.000Z", app: { package: "com.android.launcher" } },
    device_manifests: [],
    project_context: { tool_source_ids: ["github-api"] },
  }));
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].route, "api");
  assert.match(result.candidates[0].reason.join(" "), /active project/);
});

test("stale context always requires owning-policy revalidation", () => {
  const input = baseInput();
  input.observation.observed_at = "2026-07-13T17:00:00.000Z";
  input.tool_sources[0].tools[0].risk = "low";
  input.tool_sources[0].tools[0].read_only = true;
  const result = resolveContextCapabilities(input);
  const api = result.candidates.find((candidate) => candidate.route === "api");
  assert.equal(api.freshness.status, "stale");
  assert.equal(api.approval.required, true);
  assert.equal(api.approval.mode, "revalidate_context");
});

test("ordering and output are deterministic for a supplied clock", () => {
  const input = baseInput();
  assert.deepEqual(resolveContextCapabilities(input), resolveContextCapabilities(input));
});

test("does not let a catalog subdomain widen into its parent domain", () => {
  const result = resolveContextCapabilities(baseInput({
    tool_sources: [githubSource({
      tools: [{
        name: "issues.create",
        capability: "github.issue.create",
        domains: ["private.github.com"],
        required_scopes: ["repo"],
      }],
    })],
    project_context: {},
    device_manifests: [],
  }));
  assert.equal(result.candidates.length, 0);
});

test("does not match lookalike suffix hosts", () => {
  const result = resolveContextCapabilities(baseInput({
    observation: {
      surface: "browser_extension",
      observed_at: "2026-07-13T17:59:30.000Z",
      page: { url: "https://github.com.attacker.test/acme/moa" },
    },
    project_context: {},
    device_manifests: [],
  }));
  assert.equal(result.candidates.length, 0);
});

test("normalizes the browser privacy descriptor and execution adapter heartbeat", () => {
  const result = resolveContextCapabilities({
    now: NOW,
    device_manifests: [{
      device_id: "browser-heartbeat",
      surface_type: "browser_extension",
      status: "online",
      local_tool_manifest: [{ tool: "page.snapshot", risk: "read_only", approval: "none" }],
      metadata: {
        context_descriptor: {
          version: 1,
          surface: "browser",
          availability: "available",
          captured_at: "2026-07-13T17:59:30.000Z",
          application: { kind: "web_application", id: "github.com", origin: "https://github.com" },
          page: { title: "Issues", location_scope: "origin_only" },
          privacy: { page_content_included: false, full_url_included: false, query_included: false, fragment_included: false },
        },
        execution_adapters: [{
          version: 1,
          adapter: "browser_session",
          status: "available",
          credential_source: "existing_browser_session",
          authentication_state: "not_inspected",
          context_binding: { application_id: "github.com", origin: "https://github.com" },
          modes: ["current_page_evidence", "bounded_dom_actions"],
        }],
      },
    }],
  });
  assert.equal(result.observation_freshness.status, "fresh");
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].route, "browser_session");
  assert.equal(result.candidates[0].executor.credential_source, "existing_browser_session");
  assert.deepEqual(result.candidates[0].executor.modes, ["current_page_evidence", "bounded_dom_actions"]);
});
