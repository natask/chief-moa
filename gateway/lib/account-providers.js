"use strict";

// Provider catalog + adapters for account connections.
//
// The catalog is user-independent product data: stable provider ids, display
// labels, supported credential kinds, refresh support, manual reauth support,
// and docs URLs. It backs GET /v1/account-providers and validates connection
// creation. See reference/openspec/changes/remote-hosted-gateway/
// account-connection-policy.md.
//
// Adapters hold the provider round-trip logic (OAuth authorize URL, code
// exchange, refresh, best-effort revoke). Raw provider credentials only ever
// pass through adapter calls on the gateway side; nothing here serializes a
// secret into an API response. OAuth client configuration comes from env:
//
//   ACCOUNT_OAUTH_<PROVIDER>_CLIENT_ID
//   ACCOUNT_OAUTH_<PROVIDER>_CLIENT_SECRET
//   ACCOUNT_OAUTH_<PROVIDER>_AUTH_URL      (optional when a default exists)
//   ACCOUNT_OAUTH_<PROVIDER>_TOKEN_URL     (optional when a default exists)
//   ACCOUNT_OAUTH_<PROVIDER>_SCOPES        (optional, space-separated)
//
// The deterministic `fixture` provider (enabled with ACCOUNT_FIXTURE_PROVIDER=1)
// exercises the full OAuth + refresh lifecycle with no network and no real
// credential, so smoke tests can prove state transitions.

const CREDENTIAL_KINDS = [
  "oauth2_authorization_code",
  "oauth2_device_code",
  "api_key",
  "personal_access_token",
  "service_account",
  "external_handle",
  "none",
];

const OAUTH_DEFAULTS = {
  google: {
    auth_url: "https://accounts.google.com/o/oauth2/v2/auth",
    token_url: "https://oauth2.googleapis.com/token",
  },
  github: {
    auth_url: "https://github.com/login/oauth/authorize",
    token_url: "https://github.com/login/oauth/access_token",
  },
};

function baseCatalog() {
  return [
    {
      id: "openai",
      label: "OpenAI",
      credential_kinds: ["api_key"],
      supports_refresh: false,
      supports_manual_reauth: true,
      supports_multiple_connections: true,
      scopes: [],
      docs_url: "https://platform.openai.com/api-keys",
    },
    {
      id: "anthropic",
      label: "Anthropic",
      credential_kinds: ["api_key"],
      supports_refresh: false,
      supports_manual_reauth: true,
      supports_multiple_connections: true,
      scopes: [],
      docs_url: "https://console.anthropic.com/settings/keys",
    },
    {
      id: "google",
      label: "Google",
      credential_kinds: ["oauth2_authorization_code", "api_key"],
      supports_refresh: true,
      supports_manual_reauth: true,
      supports_multiple_connections: true,
      scopes: ["openid", "email", "profile"],
      docs_url: "https://console.cloud.google.com/apis/credentials",
    },
    {
      id: "github",
      label: "GitHub",
      credential_kinds: ["oauth2_authorization_code", "personal_access_token"],
      supports_refresh: true,
      supports_manual_reauth: true,
      supports_multiple_connections: true,
      scopes: ["repo", "read:user"],
      docs_url: "https://github.com/settings/tokens",
    },
  ];
}

function fixtureProviderDefinition() {
  return {
    id: "fixture",
    label: "Fixture Provider",
    credential_kinds: ["oauth2_authorization_code", "api_key"],
    supports_refresh: true,
    supports_manual_reauth: true,
    supports_multiple_connections: true,
    scopes: ["fixture.read"],
    docs_url: "https://example.invalid/fixture",
  };
}

function loadProviderCatalog(env = process.env) {
  const catalog = baseCatalog();
  if (String(env.ACCOUNT_FIXTURE_PROVIDER || "") === "1") {
    catalog.push(fixtureProviderDefinition());
  }
  return catalog;
}

function providerById(catalog, id) {
  return catalog.find((provider) => provider.id === id) || null;
}

function oauthConfigFor(providerId, env = process.env) {
  const key = String(providerId || "").toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const defaults = OAUTH_DEFAULTS[providerId] || {};
  const clientId = String(env[`ACCOUNT_OAUTH_${key}_CLIENT_ID`] || "").trim();
  const clientSecret = String(env[`ACCOUNT_OAUTH_${key}_CLIENT_SECRET`] || "").trim();
  const authUrl = String(env[`ACCOUNT_OAUTH_${key}_AUTH_URL`] || defaults.auth_url || "").trim();
  const tokenUrl = String(env[`ACCOUNT_OAUTH_${key}_TOKEN_URL`] || defaults.token_url || "").trim();
  const scopes = String(env[`ACCOUNT_OAUTH_${key}_SCOPES`] || "").split(/[\s,]+/).filter(Boolean);
  if (!clientId || !clientSecret || !authUrl || !tokenUrl) {
    return null;
  }
  return { client_id: clientId, client_secret: clientSecret, auth_url: authUrl, token_url: tokenUrl, scopes };
}

// --- adapters -----------------------------------------------------------------

// An adapter exposes:
//   oauthConfigured()                 -> boolean
//   authorizeUrl({state, redirectUri, scopes}) -> string
//   exchangeCode({code, redirectUri}) -> Promise<grant>
//   supportsRefresh()                 -> boolean
//   refresh({refreshToken})           -> Promise<grant>
//   revoke({secret})                  -> Promise<{revoked}>   (best-effort)
// A `grant` is gateway-internal only:
//   { access_token, refresh_token, token_type, scope: [], expires_at: iso|"",
//     account_subject: {display, provider_account_id, subscription_id, organization_id} }
// Refresh failures throw an Error with .code set to a non-secret provider code.

function createProviderAdapters({ env = process.env, fetchImpl = fetch } = {}) {
  const adapters = new Map();

  function get(providerId) {
    if (adapters.has(providerId)) {
      return adapters.get(providerId);
    }
    const adapter = providerId === "fixture"
      ? createFixtureAdapter()
      : createGenericOauthAdapter(providerId, env, fetchImpl);
    adapters.set(providerId, adapter);
    return adapter;
  }

  return { get };
}

function createGenericOauthAdapter(providerId, env, fetchImpl) {
  const config = oauthConfigFor(providerId, env);

  async function tokenRequest(params) {
    const response = await fetchImpl(config.token_url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams({
        client_id: config.client_id,
        client_secret: config.client_secret,
        ...params,
      }).toString(),
    });
    let payload = {};
    try {
      payload = await response.json();
    } catch {
      payload = {};
    }
    if (!response.ok || payload.error) {
      const error = new Error(String(payload.error_description || payload.error || `token endpoint returned ${response.status}`).slice(0, 300));
      error.code = String(payload.error || `http_${response.status}`);
      throw error;
    }
    return grantFromTokenPayload(payload);
  }

  return {
    oauthConfigured: () => Boolean(config),
    authorizeUrl({ state, redirectUri, scopes }) {
      const url = new URL(config.auth_url);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", config.client_id);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("state", state);
      const scopeList = (scopes && scopes.length ? scopes : config.scopes) || [];
      if (scopeList.length) {
        url.searchParams.set("scope", scopeList.join(" "));
      }
      // Ask for a refresh token where the provider honors it (Google pattern).
      url.searchParams.set("access_type", "offline");
      url.searchParams.set("prompt", "consent");
      return url.href;
    },
    exchangeCode({ code, redirectUri }) {
      return tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
    },
    supportsRefresh: () => Boolean(config),
    refresh({ refreshToken }) {
      return tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken });
    },
    async revoke() {
      // Generic OAuth revocation endpoints vary per provider; treat as
      // best-effort no-op until per-provider revoke lands.
      return { revoked: false };
    },
  };
}

function grantFromTokenPayload(payload) {
  const expiresIn = Number(payload.expires_in || 0);
  return {
    access_token: String(payload.access_token || ""),
    refresh_token: String(payload.refresh_token || ""),
    token_type: String(payload.token_type || "bearer"),
    scope: String(payload.scope || "").split(/[\s,]+/).filter(Boolean),
    expires_at: expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000).toISOString() : "",
    account_subject: { display: "", provider_account_id: "", subscription_id: "", organization_id: "" },
  };
}

// The fixture adapter: deterministic, no network. The authorization "code"
// encodes the grant behavior so smoke tests can drive every lifecycle path:
//   fixture-grant-ok[:name]         -> refreshable grant, 1h expiry
//   fixture-grant-shortlived[:name] -> refreshable grant, 60s expiry
//   fixture-grant-badrefresh[:name] -> grant whose refresh always fails
//   fixture-grant-deny              -> access_denied error
// [:name] sets a stable provider account subject so multiple connections per
// provider (different subjects) and duplicate subjects are both testable.
function createFixtureAdapter() {
  function grantFor(code) {
    const [head, name] = String(code || "").split(":");
    if (head === "fixture-grant-deny") {
      const error = new Error("user denied fixture authorization");
      error.code = "access_denied";
      throw error;
    }
    const shortlived = head === "fixture-grant-shortlived";
    const badRefresh = head === "fixture-grant-badrefresh";
    if (!shortlived && !badRefresh && head !== "fixture-grant-ok") {
      const error = new Error("unknown fixture authorization code");
      error.code = "invalid_grant";
      throw error;
    }
    const subject = name || "primary";
    const ttlMs = shortlived ? 60 * 1000 : 60 * 60 * 1000;
    return {
      access_token: `fixture-access-${subject}-${Date.now().toString(36)}`,
      refresh_token: badRefresh ? `fixture-refresh-expired-${subject}` : `fixture-refresh-ok-${subject}`,
      token_type: "bearer",
      scope: ["fixture.read"],
      expires_at: new Date(Date.now() + ttlMs).toISOString(),
      account_subject: {
        display: `${subject}@fixture.example`,
        provider_account_id: `fixture-acct-${subject}`,
        subscription_id: "",
        organization_id: "",
      },
    };
  }

  return {
    oauthConfigured: () => true,
    authorizeUrl({ state, redirectUri, loginHint }) {
      // No provider to visit: bounce straight back to the gateway callback with
      // a granting code so the full redirect loop is exercised locally.
      const url = new URL(redirectUri);
      url.searchParams.set("state", state);
      url.searchParams.set("code", loginHint || "fixture-grant-ok");
      return url.href;
    },
    async exchangeCode({ code }) {
      return grantFor(code);
    },
    supportsRefresh: () => true,
    async refresh({ refreshToken }) {
      const token = String(refreshToken || "");
      if (!token.startsWith("fixture-refresh-ok-")) {
        const error = new Error("fixture refresh token is expired");
        error.code = "invalid_grant";
        throw error;
      }
      const subject = token.slice("fixture-refresh-ok-".length);
      return {
        access_token: `fixture-access-${subject}-${Date.now().toString(36)}`,
        refresh_token: token,
        token_type: "bearer",
        scope: ["fixture.read"],
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        account_subject: {
          display: `${subject}@fixture.example`,
          provider_account_id: `fixture-acct-${subject}`,
          subscription_id: "",
          organization_id: "",
        },
      };
    },
    async revoke() {
      return { revoked: true };
    },
  };
}

module.exports = {
  CREDENTIAL_KINDS,
  loadProviderCatalog,
  providerById,
  oauthConfigFor,
  createProviderAdapters,
};
