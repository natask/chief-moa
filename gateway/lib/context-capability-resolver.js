"use strict";

// Pure context -> capability planning. This module deliberately returns data,
// never executable handlers: the existing broker/tool-source runtimes remain
// the only paths that may create work, ask for approval, or receive receipts.

const RESOLVER_VERSION = "context-capability.v1";
const POLICY = Object.freeze({
  id: "api-unless-session-state-is-authoritative.v1",
  observation_fresh_ms: 2 * 60 * 1000,
  observation_stale_ms: 15 * 60 * 1000,
  rules: Object.freeze([
    "Prefer a connected official API for equivalent durable remote data.",
    "Prefer the current authenticated browser session for drafts, unsaved state, and page-local UI state.",
    "Use the browser session as a fallback when API access is absent or lacks required scopes.",
    "Never execute a candidate; the owning integration or device must approve, execute, and receipt it.",
  ]),
});

function clean(value) {
  return String(value == null ? "" : value).trim().toLowerCase();
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function stringList(value) {
  return list(value).map(clean).filter(Boolean);
}

function unique(values) {
  return [...new Set(values)];
}

function hostFromPage(page) {
  const explicit = clean(page && (page.hostname || page.domain));
  if (explicit) return explicit.replace(/^www\./, "");
  try {
    return new URL(String((page && page.url) || "")).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function freshness(observation, nowMs) {
  const observedAt = String((observation && (observation.observed_at || observation.captured_at)) || "");
  const parsed = Date.parse(observedAt);
  if (!Number.isFinite(parsed)) {
    return { observed_at: "", age_ms: null, status: "unknown", revalidation_required: true };
  }
  const ageMs = Math.max(0, nowMs - parsed);
  const status = ageMs <= POLICY.observation_fresh_ms
    ? "fresh"
    : ageMs <= POLICY.observation_stale_ms ? "aging" : "stale";
  return {
    observed_at: new Date(parsed).toISOString(),
    age_ms: ageMs,
    status,
    revalidation_required: status !== "fresh",
  };
}

function contextKeys(observation, project) {
  const page = (observation && observation.page) || {};
  const app = (observation && observation.app) || {};
  const domain = hostFromPage(page);
  const domains = unique([domain, ...stringList(project && project.domains)]).filter(Boolean);
  const apps = unique([
    clean(app.id), clean(app.package), clean(app.bundle_id), clean(app.name),
    ...stringList(project && project.apps),
  ]).filter(Boolean);
  const integrations = unique([
    ...stringList(project && project.integration_ids),
    ...stringList(project && project.providers),
    ...stringList(project && project.tool_source_ids),
  ]);
  const intents = unique([
    clean(project && project.intent),
    ...stringList(project && project.intents),
  ]).filter(Boolean);
  return { domain, domains, apps, integrations, intents };
}

function domainMatches(actuals, expected) {
  return stringList(expected).some((candidate) => actuals.some((actual) =>
    actual === candidate || actual.endsWith(`.${candidate}`)));
}

function sourceAffinity(source, keys) {
  const domains = source && (source.domains || source.hosts);
  const apps = source && (source.apps || source.app_ids || source.packages);
  const intents = source && source.intents;
  const ids = [source && source.id, source && source.provider_id, source && source.namespace].map(clean);
  const reasons = [];
  let score = 0;
  if (domainMatches(keys.domains, domains)) {
    score += 50;
    reasons.push(`matches current domain ${keys.domain || keys.domains[0]}`);
  }
  if (stringList(apps).some((app) => keys.apps.includes(app))) {
    score += 50;
    reasons.push("matches the current application");
  }
  if (stringList(intents).some((intent) => keys.intents.includes(intent))) {
    score += 20;
    reasons.push("matches the active project intent");
  }
  if (ids.some((id) => keys.integrations.includes(id))) {
    score += 25;
    reasons.push("is selected by the active project");
  }
  const constrained = list(domains).length || list(apps).length || list(intents).length;
  return { score, reasons, applicable: score > 0 || (!constrained && ids.some((id) => keys.integrations.includes(id))) };
}

function normalizeCapability(raw) {
  if (typeof raw === "string") return { name: raw, capability: raw };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const name = String(raw.name || raw.id || raw.tool || raw.capability || "").trim();
  if (!name) return null;
  return { ...raw, name, capability: String(raw.capability || name).trim() };
}

function descriptorFor(manifest) {
  return manifest && manifest.metadata && manifest.metadata.context_descriptor
    ? manifest.metadata.context_descriptor
    : manifest && manifest.context_descriptor;
}

function executionAdaptersFor(manifest) {
  const raw = manifest && manifest.metadata && manifest.metadata.execution_adapters != null
    ? manifest.metadata.execution_adapters
    : manifest && manifest.execution_adapters;
  if (Array.isArray(raw)) return raw;
  return raw && Array.isArray(raw.adapters) ? raw.adapters : [];
}

// Browser heartbeats intentionally send origin-only context rather than full
// URLs or page content. Use the newest available descriptor when a caller does
// not already have a richer, explicitly granted observation.
function observationFromDescriptors(manifests) {
  const descriptors = list(manifests)
    .map(descriptorFor)
    .filter((descriptor) => descriptor && descriptor.availability === "available")
    .sort((left, right) => Date.parse(String(right.captured_at || "")) - Date.parse(String(left.captured_at || "")));
  const descriptor = descriptors[0];
  if (!descriptor) return {};
  const application = descriptor.application || {};
  return {
    surface: descriptor.surface || "browser",
    observed_at: descriptor.captured_at || "",
    app: { id: application.id || "", name: application.id || "" },
    page: {
      origin: application.origin || "",
      url: application.origin || "",
      title: descriptor.page && descriptor.page.title || "",
      location_scope: descriptor.page && descriptor.page.location_scope || "origin_only",
    },
    privacy: descriptor.privacy || {},
  };
}

function connectionFor(source, connections) {
  const sourceId = clean(source.id);
  const providerId = clean(source.provider_id || source.namespace);
  return list(connections).find((connection) => {
    const ids = [connection.tool_source_id, connection.source_id, connection.provider_id, connection.namespace].map(clean);
    return ids.includes(sourceId) || (providerId && ids.includes(providerId));
  }) || null;
}

function connectionState(source, capability, connections) {
  const connection = connectionFor(source, connections);
  if (!connection) {
    return {
      available: false,
      missing: [{ kind: "account_connection", provider_id: String(source.provider_id || source.namespace || source.id), message: "Connect this account to use its API." }],
    };
  }
  const status = clean(connection.status || "active");
  if (!["active", "connected", "healthy", "ready"].includes(status)) {
    return {
      available: false,
      missing: [{ kind: "account_reauthentication", connection_id: String(connection.id || ""), provider_id: String(source.provider_id || source.namespace || source.id), message: "Reconnect this account before using its API." }],
    };
  }
  const required = stringList(capability.required_scopes || capability.scopes);
  const granted = stringList(connection.scopes || connection.granted_scopes);
  const absent = required.filter((scope) => !granted.includes(scope));
  return {
    available: absent.length === 0,
    missing: absent.length ? [{
      kind: "oauth_scope",
      connection_id: String(connection.id || ""),
      provider_id: String(source.provider_id || source.namespace || source.id),
      scopes: absent,
      message: `Grant the missing scope${absent.length === 1 ? "" : "s"}: ${absent.join(", ")}.`,
    }] : [],
  };
}

function riskAndApproval(capability, route, stale) {
  const risk = clean(capability.risk) || (capability.read_only === true ? "low" : "medium");
  const declared = clean(capability.approval);
  const required = declared ? declared !== "none" : risk !== "low";
  return {
    risk,
    approval: {
      required: required || stale,
      mode: stale ? "revalidate_context" : (declared || (required ? "confirm" : "none")),
      owner: route === "api" ? "gateway_integration_policy" : "owning_device",
      reason: stale
        ? "The observation is not fresh; revalidate it before execution."
        : required ? "The capability may change external or local state." : "Declared read-only and low risk.",
    },
  };
}

function browserState(observation, manifest, capability) {
  const page = (observation && observation.page) || {};
  const authenticated = capability.session_authenticated != null
    ? Boolean(capability.session_authenticated)
    : manifest.session_authenticated != null ? Boolean(manifest.session_authenticated)
      : manifest.session && manifest.session.authenticated != null ? Boolean(manifest.session.authenticated) : null;
  const observedSurface = clean(observation && observation.surface);
  const sameBrowser = observedSurface.includes("browser") || observedSurface.includes("extension") || Boolean(page.url);
  const online = manifest.online !== false && !["offline", "expired"].includes(clean(manifest.status));
  const adapters = executionAdaptersFor(manifest);
  const browserAdapter = adapters.find((adapter) => clean(adapter.adapter || adapter.id) === "browser_session");
  const missing = [];
  if (!online) missing.push({ kind: "device_online", device_id: String(manifest.device_id || manifest.id || ""), message: "Bring the browser device online." });
  if (browserAdapter && clean(browserAdapter.status) !== "available") {
    missing.push({ kind: "browser_session", reason: String(browserAdapter.unavailable_reason || "unavailable"), message: "Make a non-incognito web page available in the connected browser." });
  }
  if (!sameBrowser) missing.push({ kind: "current_browser_page", message: "Open the relevant page in a connected browser." });
  if (authenticated === false) missing.push({ kind: "browser_login", domain: hostFromPage(page), message: "Log in to this site in the browser session." });
  return { available: missing.length === 0, missing };
}

function candidateId(route, owner, capability) {
  return `${route}:${clean(owner) || "unknown"}:${clean(capability).replace(/[^a-z0-9._-]+/g, "-")}`;
}

function resolveContextCapabilities(input = {}) {
  const manifests = input.device_manifests || [];
  const observation = input.observation && Object.keys(input.observation).length
    ? input.observation
    : observationFromDescriptors(manifests);
  const project = input.project_context || {};
  const connections = input.account_connections || [];
  const toolSources = input.tool_sources || [];
  const parsedNow = input.now instanceof Date ? input.now.getTime() : Date.parse(String(input.now || ""));
  const nowMs = Number.isFinite(parsedNow) ? parsedNow : Date.now();
  const observed = freshness(observation, nowMs);
  const keys = contextKeys(observation, project);
  const candidates = [];

  for (const source of list(toolSources)) {
    if (!source || source.enabled === false) continue;
    for (const raw of list(source.tools || source.capabilities)) {
      const capability = normalizeCapability(raw);
      if (!capability) continue;
      const affinity = sourceAffinity({ ...source, ...capability }, keys);
      if (!affinity.applicable) continue;
      const access = connectionState(source, capability, connections);
      const safety = riskAndApproval(capability, "api", observed.revalidation_required);
      candidates.push({
        id: candidateId("api", source.id || source.provider_id, capability.capability),
        capability: capability.capability,
        label: String(capability.label || capability.name),
        route: "api",
        executor: { kind: "tool_source", tool_source_id: String(source.id || ""), tool: capability.name },
        status: access.available ? "available" : "missing_access",
        missing_access: access.missing,
        risk: safety.risk,
        approval: safety.approval,
        freshness: observed,
        reason: [...affinity.reasons, access.available ? "connected API access is available" : "API access is incomplete"],
        score: affinity.score + (access.available ? 35 : -40),
      });
    }
  }

  for (const manifest of list(manifests)) {
    if (!manifest) continue;
    const surface = clean(manifest.surface_type || manifest.surface);
    const manifestCapabilities = manifest.capabilities || manifest.tools || manifest.local_tool_manifest;
    for (const raw of list(manifestCapabilities)) {
      const capability = normalizeCapability(raw);
      if (!capability) continue;
      const affinity = sourceAffinity({ ...manifest, ...capability }, keys);
      const isBrowser = surface.includes("browser") || surface.includes("extension");
      const sameSurface = clean(observation.surface).includes(surface) || (isBrowser && Boolean(keys.domain));
      if (!affinity.applicable && !sameSurface) continue;
      const access = isBrowser
        ? browserState(observation, manifest, capability)
        : {
          available: manifest.online !== false,
          missing: manifest.online === false ? [{ kind: "device_online", device_id: String(manifest.device_id || manifest.id || ""), message: `Bring the ${surface || "target"} device online.` }] : [],
        };
      const route = isBrowser ? "browser_session" : "device";
      const adapter = isBrowser
        ? executionAdaptersFor(manifest).find((entry) => clean(entry.adapter || entry.id) === "browser_session")
        : null;
      const safety = riskAndApproval(capability, route, observed.revalidation_required);
      candidates.push({
        id: candidateId(route, manifest.device_id || manifest.id || surface, capability.capability),
        capability: capability.capability,
        label: String(capability.label || capability.name),
        route,
        executor: {
          kind: "device_broker",
          device_id: String(manifest.device_id || manifest.id || ""),
          tool: capability.name,
          ...(adapter ? {
            adapter: "browser_session",
            credential_source: String(adapter.credential_source || "existing_browser_session"),
            modes: stringList(adapter.modes),
          } : {}),
        },
        status: access.available ? "available" : "missing_access",
        missing_access: access.missing,
        risk: safety.risk,
        approval: safety.approval,
        freshness: observed,
        reason: [...affinity.reasons, isBrowser ? "uses the user's existing browser session" : "is advertised by the owning device"],
        score: affinity.score + (access.available ? 15 : -50),
      });
    }
  }

  const documentState = clean(observation.page && (observation.page.state || observation.page.content_state));
  const sessionAuthoritative = ["draft", "unsaved", "local_only", "page_local"].includes(documentState)
    || Boolean(observation.page && observation.page.unsaved);
  const byCapability = new Map();
  for (const candidate of candidates) {
    const peers = byCapability.get(candidate.capability) || [];
    peers.push(candidate);
    byCapability.set(candidate.capability, peers);
  }
  for (const peers of byCapability.values()) {
    const hasAvailableApi = peers.some((candidate) => candidate.route === "api" && candidate.status === "available");
    const hasAvailableBrowser = peers.some((candidate) => candidate.route === "browser_session" && candidate.status === "available");
    for (const candidate of peers) {
      if (sessionAuthoritative && candidate.route === "browser_session") {
        candidate.score += 60;
        candidate.reason.push("the current page contains draft or page-local state, so the browser session is authoritative");
      } else if (!sessionAuthoritative && hasAvailableApi && candidate.route === "api") {
        candidate.score += 25;
        candidate.reason.push("policy prefers a connected API for durable remote data");
      } else if (!hasAvailableApi && hasAvailableBrowser && candidate.route === "browser_session") {
        candidate.score += 20;
        candidate.reason.push("the browser session is the available fallback for missing API access");
      }
    }
    peers.sort(compareCandidates);
    const selected = peers.find((candidate) => candidate.status === "available");
    for (const candidate of peers) candidate.recommended = candidate === selected;
  }

  candidates.sort(compareCandidates);
  const missingAccess = [];
  const seenMissing = new Set();
  for (const candidate of candidates) {
    for (const missing of candidate.missing_access) {
      const key = JSON.stringify(missing);
      if (!seenMissing.has(key)) {
        seenMissing.add(key);
        missingAccess.push(missing);
      }
    }
  }
  return {
    version: RESOLVER_VERSION,
    policy: { id: POLICY.id, rules: [...POLICY.rules] },
    observation_freshness: observed,
    candidates,
    missing_access: missingAccess,
    executed: false,
  };
}

function compareCandidates(left, right) {
  if (left.status !== right.status) return left.status === "available" ? -1 : 1;
  if (left.score !== right.score) return right.score - left.score;
  return left.id.localeCompare(right.id);
}

module.exports = {
  POLICY,
  RESOLVER_VERSION,
  resolveContextCapabilities,
};
