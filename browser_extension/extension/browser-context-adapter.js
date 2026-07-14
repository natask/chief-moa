// Bounded browser context for device-client discovery.
//
// This descriptor is intentionally much smaller than page evidence. It lets the
// gateway identify the web application that is currently available to this
// browser client without continuously uploading the URL, DOM, page text, or a
// screenshot. Detailed context remains an on-demand evidence operation.

const MAX_APPLICATION_ID_CHARS = 253;
const MAX_ORIGIN_CHARS = 512;
const MAX_TITLE_CHARS = 160;
const WEB_PROTOCOLS = new Set(["http:", "https:"]);

function cleanSingleLine(value, maxChars) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}

function unavailableContext(reason, capturedAt) {
  return {
    version: 1,
    surface: "browser",
    availability: "unavailable",
    reason,
    captured_at: capturedAt,
    privacy: {
      page_content_included: false,
      full_url_included: false,
      query_included: false,
      fragment_included: false,
    },
  };
}

export function browserContextDescriptor(tab, options = {}) {
  const capturedAt = cleanSingleLine(options.capturedAt || new Date().toISOString(), 64);
  if (!tab || typeof tab !== "object") return unavailableContext("no_active_tab", capturedAt);
  if (tab.incognito === true) return unavailableContext("incognito_withheld", capturedAt);

  let url;
  try {
    url = new URL(String(tab.url || ""));
  } catch {
    return unavailableContext("page_identity_unavailable", capturedAt);
  }
  if (!WEB_PROTOCOLS.has(url.protocol) || !url.hostname) {
    return unavailableContext("restricted_page", capturedAt);
  }

  const applicationId = cleanSingleLine(url.hostname.toLowerCase(), MAX_APPLICATION_ID_CHARS);
  const origin = cleanSingleLine(url.origin, MAX_ORIGIN_CHARS);
  return {
    version: 1,
    surface: "browser",
    availability: "available",
    captured_at: capturedAt,
    application: {
      kind: "web_application",
      id: applicationId,
      origin,
    },
    page: {
      title: cleanSingleLine(tab.title, MAX_TITLE_CHARS),
      location_scope: "origin_only",
    },
    privacy: {
      page_content_included: false,
      full_url_included: false,
      query_included: false,
      fragment_included: false,
    },
  };
}

// These are execution adapters, not model tools. The gateway can choose this
// already-running browser session when an applicable web app is open, while
// the extension's fixed local tool manifest remains the execution allowlist.
export function browserSessionExecutionAdapters(context) {
  const available = context?.availability === "available";
  const application = available ? context.application : null;
  return [{
    version: 1,
    adapter: "browser_session",
    status: available ? "available" : "unavailable",
    unavailable_reason: available ? "" : cleanSingleLine(context?.reason || "context_unavailable", 80),
    credential_source: "existing_browser_session",
    authentication_state: "not_inspected",
    context_binding: available ? {
      application_id: application?.id || "",
      origin: application?.origin || "",
    } : null,
    modes: [
      "current_page_evidence",
      "bounded_dom_actions",
      "bounded_cdp_actions",
      "http_navigation",
    ],
    constraints: [
      "local_allowlist_validation",
      "no_cookie_export",
      "no_provider_credentials",
      "proposal_before_execution",
    ],
  }];
}
