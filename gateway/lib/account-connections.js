"use strict";

// Account connections: gateway-owned records linking one authenticated Moa user
// to one provider account, with credential lifecycle management.
//
// Contract: reference/openspec/changes/remote-hosted-gateway/
// account-connection-policy.md. The load-bearing rule is the trust boundary:
// raw provider credentials (OAuth tokens, API keys, PATs, service-account
// material) never leave this module unencrypted except into a provider adapter
// call. Connection records and every serializer expose only non-secret fields
// plus `credential_ref_kind`. Credentials live in a separate encrypted file
// that no API serializer reads.
//
// Storage is the gateway's local JSON projection (same durability model as
// work-graph.js: whole-file atomic temp+rename writes). schema.sql carries the
// matching Postgres tables for hosted mode; the pg-backed implementation of
// this same interface is a follow-on ticket.
//
// Encryption at rest: AES-256-GCM. Key from ACCOUNT_CREDENTIAL_KEY (32 bytes,
// hex or base64) or an auto-generated 0600 keyfile under DATA_DIR.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  loadProviderCatalog,
  providerById,
  createProviderAdapters,
} = require("./account-providers");

const STATUSES = [
  "pending_user_auth",
  "connected",
  "refreshing",
  "action_required",
  "expired",
  "invalid",
  "disabled",
  "revoked",
  "error",
];

const REFRESH_STATES = [
  "not_supported",
  "idle",
  "scheduled",
  "refreshing",
  "succeeded",
  "failed",
  "blocked",
];

const CREDENTIAL_REF_KINDS = [
  "encrypted_server_secret",
  "opaque_broker_handle",
  "provider_managed_session",
  "none",
];

const MANUAL_SECRET_KINDS = ["api_key", "personal_access_token", "service_account"];

// Field names that must never be accepted from clients on create/patch. The
// only allowed secret path into the gateway is the gateway-served secret form
// or the gateway-side OAuth callback.
const SECRET_FIELD_PATTERN = /(credential|secret|token|api[-_]?key|password|refresh|cookie|private[-_]?key)/i;

const REASON_MESSAGES = {
  refresh_token_expired: "needs you to sign in again.",
  refresh_failed: "could not refresh automatically and needs you to sign in again.",
  credential_expired: "credential expired and needs reauthorization.",
  credential_expiring: "credential is about to expire and cannot refresh itself.",
  refresh_not_supported: "cannot refresh automatically; rotate the credential.",
  provider_rejected: "rejected the stored credential.",
  user_requested: "reauthorization requested.",
};

function httpError(statusCode, message, extra = {}) {
  const error = new Error(message);
  error.statusCode = statusCode;
  Object.assign(error, extra);
  return error;
}

function createAccountConnectionStore(options = {}) {
  const env = options.env || process.env;
  const dataDir = path.resolve(options.dataDir || "./data");
  const storeDir = path.join(dataDir, "account-connections");
  const connectionsPath = path.join(storeDir, "connections.json");
  const credentialsPath = path.join(storeDir, "credentials.json");
  const actionsPath = path.join(storeDir, "actions.json");
  const notificationsPath = path.join(storeDir, "notifications.json");
  const eventsPath = path.join(storeDir, "events.jsonl");
  const keyPath = path.join(storeDir, "credential.key");

  const catalog = options.catalog || loadProviderCatalog(env);
  const adapters = options.adapters || createProviderAdapters({ env });
  const publicBaseUrl = stripTrailingSlash(options.publicBaseUrl || env.PUBLIC_BASE_URL || "http://localhost:8787");
  const refreshLeewayMs = numberOr(options.refreshLeewayMs, numberOr(env.ACCOUNT_REFRESH_LEEWAY_MS, 15 * 60 * 1000));
  const actionTtlMs = numberOr(options.actionTtlMs, numberOr(env.ACCOUNT_ACTION_TTL_MS, 10 * 60 * 1000));
  const now = options.now || (() => Date.now());
  // Optional bridge into the cross-device tool hub. The store stays decoupled
  // from the device-hub implementation: the gateway injects a hook that turns a
  // freshly queued credential notification into a /v1/tool/requests entry and
  // returns its id. A missing or failing hook never breaks refresh/health.
  const onUserActionNotification = typeof options.onUserActionNotification === "function"
    ? options.onUserActionNotification
    : null;

  fs.mkdirSync(storeDir, { recursive: true });
  const encryptionKey = loadEncryptionKey(env, keyPath);
  const encryptionKeySource = env.ACCOUNT_CREDENTIAL_KEY ? "env" : "keyfile";

  let connections = loadJsonMap(connectionsPath, "connections");
  let credentials = loadJsonMap(credentialsPath, "credentials");
  let actions = loadJsonMap(actionsPath, "actions");
  let notifications = loadJsonMap(notificationsPath, "notifications");

  // --- persistence ------------------------------------------------------------

  function flush(filePath, key, value) {
    const tmpPath = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify({ [key]: value }, null, 2), { mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
  }

  const flushConnections = () => flush(connectionsPath, "connections", connections);
  const flushCredentials = () => flush(credentialsPath, "credentials", credentials);
  const flushActions = () => flush(actionsPath, "actions", actions);
  const flushNotifications = () => flush(notificationsPath, "notifications", notifications);

  // --- events -------------------------------------------------------------------

  function emitEvent(connectionId, type, actor, payload = {}) {
    if (findSecretField(payload)) {
      throw new Error(`refusing to emit event ${type}: payload carries a secret-named field`);
    }
    const event = {
      id: `acctevt_${crypto.randomBytes(8).toString("hex")}`,
      stream_id: `account-connection:${connectionId}`,
      connection_id: connectionId,
      type,
      actor,
      payload,
      ts: nowIso(),
    };
    fs.appendFileSync(eventsPath, `${JSON.stringify(event)}\n`);
    return event;
  }

  function listEvents(connectionId, limit = 50) {
    if (!fs.existsSync(eventsPath)) {
      return [];
    }
    const wanted = `account-connection:${connectionId}`;
    return fs.readFileSync(eventsPath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((event) => event && event.stream_id === wanted)
      .slice(-clampLimit(limit, 50));
  }

  // --- credential boundary --------------------------------------------------------

  function storeCredential(connectionId, kind, secretPayload) {
    const record = {
      connection_id: connectionId,
      credential_kind: kind,
      credential_ref_kind: "encrypted_server_secret",
      enc: encryptJson(encryptionKey, secretPayload),
      created_at: credentials[connectionId]?.created_at || nowIso(),
      updated_at: nowIso(),
      retired: false,
    };
    credentials[connectionId] = record;
    flushCredentials();
  }

  function readCredential(connectionId) {
    const record = credentials[connectionId];
    if (!record || record.retired || !record.enc) {
      return null;
    }
    return decryptJson(encryptionKey, record.enc);
  }

  function retireCredential(connectionId) {
    const record = credentials[connectionId];
    if (!record) {
      return false;
    }
    credentials[connectionId] = {
      connection_id: connectionId,
      credential_kind: record.credential_kind,
      credential_ref_kind: "none",
      enc: null,
      created_at: record.created_at,
      updated_at: nowIso(),
      retired: true,
    };
    flushCredentials();
    return true;
  }

  function credentialRefKind(connectionId) {
    const record = credentials[connectionId];
    if (!record || record.retired || !record.enc) {
      return "none";
    }
    return record.credential_ref_kind || "encrypted_server_secret";
  }

  // --- short-lived user actions (oauth state / secret form tokens) -----------------

  function createAction(kind, connection, extra = {}) {
    pruneActions();
    const token = crypto.randomBytes(24).toString("hex");
    actions[token] = {
      token,
      kind,
      connection_id: connection.id,
      user_id: connection.user_id,
      created_at: nowIso(),
      expires_at: new Date(now() + actionTtlMs).toISOString(),
      used: false,
      ...extra,
    };
    flushActions();
    return actions[token];
  }

  function takeAction(token, kind) {
    pruneActions();
    const action = actions[String(token || "")];
    if (!action || action.kind !== kind) {
      throw httpError(404, "unknown or expired action token");
    }
    if (action.used) {
      throw httpError(410, "action token was already used");
    }
    if (Date.parse(action.expires_at) <= now()) {
      throw httpError(410, "action token expired");
    }
    return action;
  }

  function markActionUsed(token) {
    if (actions[token]) {
      actions[token].used = true;
      flushActions();
    }
  }

  function pruneActions() {
    let changed = false;
    for (const [token, action] of Object.entries(actions)) {
      if (Date.parse(action.expires_at) <= now() - actionTtlMs) {
        delete actions[token];
        changed = true;
      }
    }
    if (changed) {
      flushActions();
    }
  }

  // --- record helpers -----------------------------------------------------------

  function ownedConnection(userId, connectionId) {
    const record = connections[String(connectionId || "")];
    if (!record || record.user_id !== userId) {
      throw httpError(404, "account connection not found");
    }
    return record;
  }

  function touch(record) {
    record.audit.updated_at = nowIso();
  }

  function setStatus(record, status, reason, actor) {
    if (!STATUSES.includes(status)) {
      throw new Error(`invalid status: ${status}`);
    }
    const previous = record.status;
    record.status = status;
    record.status_reason = String(reason || "");
    if (previous !== status) {
      record.audit.status_changed_at = nowIso();
      emitEvent(record.id, "account.connection.status.changed", actor, {
        provider: record.provider,
        old_status: previous,
        new_status: status,
        reason: record.status_reason,
      });
    }
    touch(record);
  }

  function refreshSupported(record) {
    if (record.credential_kind !== "oauth2_authorization_code") {
      return false;
    }
    const provider = providerById(catalog, record.provider);
    if (!provider || !provider.supports_refresh) {
      return false;
    }
    const secret = readCredential(record.id);
    return Boolean(secret && secret.refresh_token);
  }

  function setUserAction(record, reason, actionType) {
    const provider = providerById(catalog, record.provider);
    record.needs_user_action = true;
    record.user_action = {
      reason,
      message: `${provider?.label || record.provider} (${record.label}) ${REASON_MESSAGES[reason] || "needs your attention."}`,
      since: nowIso(),
      reauth_endpoint: `/v1/account-connections/${record.id}/reauth`,
      action_type: actionType,
      expires_at: "",
    };
    emitEvent(record.id, "account.connection.user_action_requested", gatewayActor(), {
      provider: record.provider,
      reason,
      action_type: actionType,
    });
  }

  function clearUserAction(record) {
    record.needs_user_action = false;
    record.user_action = null;
  }

  function defaultActionType(record) {
    return record.credential_kind === "oauth2_authorization_code" ? "open_url" : "gateway_secret_form";
  }

  // --- notifications --------------------------------------------------------------

  function queueUserActionNotification(record, reason) {
    const target = record.device_notification_target;
    const provider = providerById(catalog, record.provider);
    if (!target || target.enabled !== true || !target.device_id) {
      emitEvent(record.id, "account.connection.notification.skipped", gatewayActor(), {
        provider: record.provider,
        reason,
        skip_reason: "no_enabled_device_target",
      });
      return null;
    }
    const duplicate = Object.values(notifications).find((notification) =>
      notification.connection_id === record.id &&
      notification.reason === reason &&
      notification.status === "queued");
    if (duplicate) {
      emitEvent(record.id, "account.connection.notification.skipped", gatewayActor(), {
        provider: record.provider,
        reason,
        skip_reason: "already_queued",
        notification_id: duplicate.id,
      });
      return duplicate;
    }
    // Tool-input shape per policy: only connection id, labels, reason, and the
    // reauth endpoint. Never a credential, URL with embedded secrets, or code.
    const notification = {
      id: `acctnotif_${crypto.randomBytes(8).toString("hex")}`,
      user_id: record.user_id,
      connection_id: record.id,
      device_id: target.device_id,
      surface_type: target.surface_type || "android",
      channel: target.channel || "credential_health",
      tool: "notification.account_connection",
      input: {
        connection_id: record.id,
        provider_label: provider?.label || record.provider,
        connection_label: record.label,
        reason,
        reauth_endpoint: `/v1/account-connections/${record.id}/reauth`,
      },
      status: "queued",
      tool_request_id: "",
      created_at: nowIso(),
      receipt: null,
    };
    // Bridge to the cross-device tool hub so the target device actually learns
    // it must reauthorize. Failure or absence of the bridge must not break the
    // health/refresh path; the internal notification stays the durable record.
    if (onUserActionNotification) {
      try {
        const bridged = onUserActionNotification(clone(notification));
        if (bridged && bridged.tool_request_id) {
          notification.tool_request_id = String(bridged.tool_request_id);
        }
      } catch {
        // swallow: notification stays queued without a device-hub link
      }
    }
    notifications[notification.id] = notification;
    flushNotifications();
    emitEvent(record.id, "account.connection.notification.queued", gatewayActor(), {
      provider: record.provider,
      reason,
      notification_id: notification.id,
      device_id: target.device_id,
      channel: notification.channel,
      tool_request_id: notification.tool_request_id,
    });
    return notification;
  }

  function listNotifications({ userId, deviceId = "", status = "" } = {}) {
    return Object.values(notifications)
      .filter((notification) => notification.user_id === userId)
      .filter((notification) => (deviceId ? notification.device_id === deviceId : true))
      .filter((notification) => (status ? notification.status === status : true))
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
      .map(clone);
  }

  function recordNotificationReceipt(userId, notificationId, body = {}) {
    const notification = notifications[String(notificationId || "")];
    if (!notification || notification.user_id !== userId) {
      throw httpError(404, "notification not found");
    }
    notification.status = "received";
    notification.receipt = {
      at: nowIso(),
      device_id: String(body.device_id || notification.device_id),
      displayed: body.displayed !== false,
      note: String(body.note || "").slice(0, 500),
    };
    flushNotifications();
    emitEvent(notification.connection_id, "account.connection.notification.receipt", {
      kind: "device",
      id: notification.receipt.device_id,
    }, {
      notification_id: notification.id,
      displayed: notification.receipt.displayed,
    });
    return clone(notification);
  }

  // --- serialization ----------------------------------------------------------------

  function serializeConnection(record, { includeDiagnostics = false } = {}) {
    const provider = providerById(catalog, record.provider);
    const payload = {
      id: record.id,
      user_id: record.user_id,
      provider: record.provider,
      provider_label: provider?.label || record.provider,
      label: record.label,
      account_subject: clone(record.account_subject),
      credential_kind: record.credential_kind,
      credential_ref_kind: credentialRefKind(record.id),
      status: record.status,
      status_reason: record.status_reason,
      expires_at: record.expires_at,
      scopes_granted: [...record.scopes_granted],
      refresh: clone(record.refresh),
      needs_user_action: record.needs_user_action,
      user_action: record.user_action ? clone(record.user_action) : null,
      device_notification_target: record.device_notification_target ? clone(record.device_notification_target) : null,
      audit: clone(record.audit),
    };
    if (includeDiagnostics) {
      payload.recent_events = listEvents(record.id, 25).map((event) => ({
        type: event.type,
        actor: event.actor,
        payload: event.payload,
        ts: event.ts,
      }));
    }
    const leaked = findSecretValue(payload, secretValuesFor(record.id));
    if (leaked) {
      throw new Error("serializer invariant violation: connection payload contains credential material");
    }
    return payload;
  }

  // Every raw secret currently stored for a connection, used as a serializer
  // tripwire: no serialized payload may contain any of these strings.
  function secretValuesFor(connectionId) {
    const secret = readCredential(connectionId);
    if (!secret) {
      return [];
    }
    return ["access_token", "refresh_token", "secret"]
      .map((key) => secret[key])
      .filter((value) => typeof value === "string" && value.length >= 8);
  }

  function serializeProviders() {
    return catalog.map((provider) => clone(provider));
  }

  // --- create / list / patch --------------------------------------------------------

  function create(userId, body = {}) {
    const secretField = findSecretField(body);
    if (secretField) {
      throw httpError(400, `field "${secretField}" is not accepted here; credentials enter only through the gateway secret form or the OAuth callback`);
    }
    const providerId = String(body.provider || "").trim();
    const provider = providerById(catalog, providerId);
    if (!provider) {
      throw httpError(400, `unknown provider: ${providerId || "(empty)"}`);
    }
    const credentialKind = String(body.credential_kind || "").trim();
    if (!provider.credential_kinds.includes(credentialKind)) {
      throw httpError(400, `provider ${providerId} does not support credential_kind ${credentialKind || "(empty)"}`);
    }
    if (credentialKind === "oauth2_authorization_code") {
      const adapter = adapters.get(providerId);
      if (!adapter.oauthConfigured()) {
        throw httpError(400, `provider ${providerId} OAuth client is not configured on this gateway; set ACCOUNT_OAUTH_${providerId.toUpperCase()}_CLIENT_ID/_CLIENT_SECRET`);
      }
    }
    const label = String(body.label || "").trim().slice(0, 120) || `${provider.label} connection`;
    const scopes = Array.isArray(body.scopes) ? body.scopes.map((scope) => String(scope).slice(0, 120)).filter(Boolean) : [];
    const target = normalizeNotificationTarget(body.device_notification_target);
    const returnUrl = sanitizeReturnUrl(body.return_url);

    const createdAt = nowIso();
    const record = {
      id: `acctconn_${crypto.randomBytes(8).toString("hex")}`,
      user_id: userId,
      provider: providerId,
      label,
      account_subject: { display: "", provider_account_id: "", subscription_id: "", organization_id: "" },
      credential_kind: credentialKind,
      status: "pending_user_auth",
      status_reason: "awaiting user authorization",
      expires_at: "",
      scopes_granted: [],
      requested_scopes: scopes,
      refresh: emptyRefreshState(credentialKind === "oauth2_authorization_code" && provider.supports_refresh),
      needs_user_action: false,
      user_action: null,
      device_notification_target: target,
      audit: {
        created_at: createdAt,
        updated_at: createdAt,
        status_changed_at: createdAt,
        last_health_check_at: "",
        last_used_at: "",
        created_by: { kind: "user", id: userId },
        updated_by: { kind: "user", id: userId },
      },
    };
    connections[record.id] = record;
    flushConnections();
    emitEvent(record.id, "account.connection.created", userActor(userId), {
      provider: providerId,
      label,
      credential_kind: credentialKind,
    });

    const reauthAction = startAuthAction(record, "connect");
    return { statusCode: 202, connection: serializeConnection(record), reauth_action: reauthAction };
  }

  // Builds the short-lived user action for connecting or reauthorizing, and
  // emits auth.started/reauth.started. Returns the non-secret action payload.
  function startAuthAction(record, mode) {
    const provider = providerById(catalog, record.provider);
    let action;
    if (record.credential_kind === "oauth2_authorization_code") {
      const state = createAction("oauth_state", record, { mode });
      action = {
        type: "open_url",
        url: `${publicBaseUrl}/v1/account-connections/oauth/start?state=${state.token}`,
        expires_at: state.expires_at,
        message: `Sign in to ${provider?.label || record.provider} for "${record.label}".`,
      };
    } else if (MANUAL_SECRET_KINDS.includes(record.credential_kind)) {
      const form = createAction("secret_form", record, { mode });
      action = {
        type: "gateway_secret_form",
        url: `${publicBaseUrl}/v1/account-connections/secret-form?token=${form.token}`,
        expires_at: form.expires_at,
        message: `Enter a ${credentialKindLabel(record.credential_kind)} for ${provider?.label || record.provider} ("${record.label}") on the gateway form.`,
      };
    } else {
      throw httpError(400, `credential_kind ${record.credential_kind} has no supported connect flow yet`);
    }
    const eventType = mode === "reauth" ? "account.connection.reauth.started" : "account.connection.auth.started";
    emitEvent(record.id, eventType, userActor(record.user_id), {
      provider: record.provider,
      action_type: action.type,
      expires_at: action.expires_at,
    });
    touch(record);
    flushConnections();
    return action;
  }

  function list(userId) {
    return Object.values(connections)
      .filter((record) => record.user_id === userId)
      .sort((a, b) => String(a.audit.created_at).localeCompare(String(b.audit.created_at)))
      .map((record) => serializeConnection(record));
  }

  function get(userId, connectionId) {
    return serializeConnection(ownedConnection(userId, connectionId), { includeDiagnostics: true });
  }

  function patch(userId, connectionId, body = {}) {
    const secretField = findSecretField(body);
    if (secretField) {
      throw httpError(400, `field "${secretField}" cannot be set through PATCH; credentials enter only through the gateway secret form or the OAuth callback`);
    }
    const record = ownedConnection(userId, connectionId);
    const changed = [];
    if (typeof body.label === "string" && body.label.trim()) {
      const label = body.label.trim().slice(0, 120);
      if (label !== record.label) {
        changed.push({ field: "label", from: record.label, to: label });
        record.label = label;
      }
    }
    if (body.device_notification_target !== undefined) {
      record.device_notification_target = normalizeNotificationTarget(body.device_notification_target);
      changed.push({ field: "device_notification_target" });
    }
    if (body.enabled === true && record.status === "disabled") {
      const hasCredential = credentialRefKind(record.id) !== "none";
      setStatus(record, hasCredential ? "connected" : "action_required", "re-enabled by user", userActor(userId));
      changed.push({ field: "enabled", to: true });
    }
    if (changed.length) {
      record.audit.updated_by = { kind: "user", id: userId };
      touch(record);
      flushConnections();
      emitEvent(record.id, "account.connection.updated", userActor(userId), { changed });
    }
    return serializeConnection(record);
  }

  // --- oauth + secret form flows ------------------------------------------------------

  function oauthStartRedirect(stateToken) {
    const action = takeAction(stateToken, "oauth_state");
    const record = connections[action.connection_id];
    if (!record) {
      throw httpError(404, "connection for this action no longer exists");
    }
    const adapter = adapters.get(record.provider);
    return adapter.authorizeUrl({
      state: action.token,
      redirectUri: `${publicBaseUrl}/v1/account-connections/oauth/callback`,
      scopes: record.requested_scopes,
    });
  }

  async function completeOauthCallback({ state, code, error }) {
    const action = takeAction(state, "oauth_state");
    markActionUsed(action.token);
    const record = connections[action.connection_id];
    if (!record) {
      throw httpError(404, "connection for this action no longer exists");
    }
    if (error) {
      setStatus(record, "action_required", `provider returned ${String(error).slice(0, 100)}`, gatewayActor());
      setUserAction(record, "provider_rejected", defaultActionType(record));
      flushConnections();
      throw httpError(400, `provider authorization failed: ${String(error).slice(0, 100)}`);
    }
    const adapter = adapters.get(record.provider);
    let grant;
    try {
      grant = await adapter.exchangeCode({
        code: String(code || ""),
        redirectUri: `${publicBaseUrl}/v1/account-connections/oauth/callback`,
      });
    } catch (exchangeError) {
      setStatus(record, "error", `code exchange failed: ${exchangeError.code || "unknown"}`, gatewayActor());
      flushConnections();
      throw httpError(502, `provider code exchange failed: ${exchangeError.code || exchangeError.message}`);
    }
    applyGrant(record, grant, action.mode === "reauth" ? "reauth" : "auth");
    return { connection: serializeConnection(record) };
  }

  function secretFormInfo(token) {
    const action = takeAction(token, "secret_form");
    const record = connections[action.connection_id];
    if (!record) {
      throw httpError(404, "connection for this action no longer exists");
    }
    const provider = providerById(catalog, record.provider);
    return {
      token: action.token,
      provider: record.provider,
      provider_label: provider?.label || record.provider,
      connection_label: record.label,
      credential_kind: record.credential_kind,
      credential_kind_label: credentialKindLabel(record.credential_kind),
      expires_at: action.expires_at,
    };
  }

  function submitSecretForm(token, fields = {}) {
    const action = takeAction(token, "secret_form");
    const record = connections[action.connection_id];
    if (!record) {
      throw httpError(404, "connection for this action no longer exists");
    }
    const secret = String(fields.secret || "").trim();
    if (!secret) {
      throw httpError(400, "secret value is required");
    }
    markActionUsed(action.token);
    storeCredential(record.id, record.credential_kind, {
      secret,
      kind: record.credential_kind,
      stored_at: nowIso(),
    });
    const displayHint = String(fields.account_display || "").trim().slice(0, 120);
    if (displayHint) {
      record.account_subject.display = displayHint;
    }
    record.expires_at = sanitizeIsoDate(fields.expires_at) || "";
    record.refresh = emptyRefreshState(false);
    clearUserAction(record);
    record.audit.updated_by = gatewayActor();
    emitEvent(record.id, "account.connection.secret.stored", gatewayActor(), {
      provider: record.provider,
      credential_kind: record.credential_kind,
      credential_ref_kind: "encrypted_server_secret",
    });
    const wasReauth = action.mode === "reauth";
    emitEvent(record.id, wasReauth ? "account.connection.reauth.completed" : "account.connection.auth.completed", gatewayActor(), {
      provider: record.provider,
      flow: "gateway_secret_form",
    });
    setStatus(record, "connected", "", gatewayActor());
    flushConnections();
    resolveNotificationsFor(record.id);
    return { connection: serializeConnection(record) };
  }

  // Store a fresh grant from an OAuth code exchange or refresh, enforce the
  // duplicate-subject rule, and move the connection to connected.
  function applyGrant(record, grant, flow) {
    const subject = grant.account_subject || {};
    if (subject.provider_account_id) {
      const duplicate = Object.values(connections).find((other) =>
        other.id !== record.id &&
        other.user_id === record.user_id &&
        other.provider === record.provider &&
        !["revoked", "disabled"].includes(other.status) &&
        other.account_subject.provider_account_id === subject.provider_account_id &&
        (other.account_subject.subscription_id || "") === (subject.subscription_id || ""));
      if (duplicate) {
        setStatus(record, "error", `duplicate provider subject: already connected as ${duplicate.id}`, gatewayActor());
        flushConnections();
        throw httpError(409, `this provider account is already connected (${duplicate.id}); use that connection or disconnect it first`);
      }
      record.account_subject = {
        display: String(subject.display || ""),
        provider_account_id: String(subject.provider_account_id || ""),
        subscription_id: String(subject.subscription_id || ""),
        organization_id: String(subject.organization_id || ""),
      };
    }
    storeCredential(record.id, record.credential_kind, {
      access_token: grant.access_token || "",
      refresh_token: grant.refresh_token || "",
      token_type: grant.token_type || "bearer",
      stored_at: nowIso(),
    });
    record.expires_at = grant.expires_at || "";
    record.scopes_granted = Array.isArray(grant.scope) ? grant.scope : [];
    const supported = refreshSupported(record);
    const priorRefresh = record.refresh || emptyRefreshState(false);
    record.refresh = {
      ...emptyRefreshState(supported),
      last_attempt_at: priorRefresh.last_attempt_at || "",
      last_success_at: priorRefresh.last_success_at || "",
      next_attempt_at: supported && record.expires_at
        ? new Date(Date.parse(record.expires_at) - refreshLeewayMs).toISOString()
        : "",
    };
    clearUserAction(record);
    record.audit.updated_by = gatewayActor();
    emitEvent(record.id, "account.connection.secret.stored", gatewayActor(), {
      provider: record.provider,
      credential_kind: record.credential_kind,
      credential_ref_kind: "encrypted_server_secret",
      expires_at: record.expires_at,
    });
    if (flow !== "refresh") {
      emitEvent(record.id, flow === "reauth" ? "account.connection.reauth.completed" : "account.connection.auth.completed", gatewayActor(), {
        provider: record.provider,
        flow: "oauth2_authorization_code",
        expires_at: record.expires_at,
      });
    }
    setStatus(record, "connected", "", gatewayActor());
    flushConnections();
    resolveNotificationsFor(record.id);
  }

  // A completed auth/reauth resolves any still-queued credential notifications
  // for the connection so devices stop nagging about fixed problems.
  function resolveNotificationsFor(connectionId) {
    let changed = false;
    for (const notification of Object.values(notifications)) {
      if (notification.connection_id === connectionId && notification.status === "queued") {
        notification.status = "resolved";
        notification.resolved_at = nowIso();
        changed = true;
      }
    }
    if (changed) {
      flushNotifications();
    }
  }

  // --- refresh + health ------------------------------------------------------------

  async function requestRefresh(userId, connectionId) {
    const record = ownedConnection(userId, connectionId);
    if (["disabled", "revoked"].includes(record.status)) {
      throw httpError(409, `connection is ${record.status}; enable or reconnect it first`);
    }
    if (!refreshSupported(record)) {
      setUserAction(record, "refresh_not_supported", defaultActionType(record));
      if (record.status === "connected" && record.expires_at && Date.parse(record.expires_at) <= now()) {
        setStatus(record, "expired", "credential expired and cannot self-refresh", userActor(userId));
      }
      touch(record);
      flushConnections();
      queueUserActionNotification(record, "refresh_not_supported");
      throw httpError(409, "refresh is not supported for this connection; manual reauthorization is required", {
        payload: { needs_user_action: true, connection: serializeConnection(record) },
      });
    }
    await attemptRefresh(record, userActor(userId));
    return { statusCode: 202, connection: serializeConnection(record) };
  }

  async function attemptRefresh(record, actor) {
    const secret = readCredential(record.id);
    const adapter = adapters.get(record.provider);
    record.refresh.state = "refreshing";
    record.refresh.last_attempt_at = nowIso();
    record.refresh.attempt_count = Number(record.refresh.attempt_count || 0) + 1;
    setStatus(record, "refreshing", "provider refresh in progress", actor);
    flushConnections();
    emitEvent(record.id, "account.connection.refresh.started", actor, {
      provider: record.provider,
      attempt: record.refresh.attempt_count,
    });
    try {
      const grant = await adapter.refresh({ refreshToken: secret.refresh_token });
      // Providers may rotate the refresh token; keep the old one when they do not.
      if (!grant.refresh_token) {
        grant.refresh_token = secret.refresh_token;
      }
      record.refresh.state = "succeeded";
      record.refresh.last_success_at = nowIso();
      record.refresh.failure_code = "";
      record.refresh.failure_message = "";
      record.refresh.attempt_count = 0;
      emitEvent(record.id, "account.connection.refresh.succeeded", gatewayActor(), {
        provider: record.provider,
        expires_at: grant.expires_at || "",
      });
      emitEvent(record.id, "account.connection.secret.rotated", gatewayActor(), {
        provider: record.provider,
        credential_ref_kind: "encrypted_server_secret",
      });
      applyGrant(record, { ...grant, account_subject: record.account_subject }, "refresh");
      record.refresh.state = "succeeded";
      flushConnections();
      return true;
    } catch (refreshError) {
      // Never delete the last known credential on failure; move status on
      // provider evidence and keep audit history.
      const code = String(refreshError.code || "refresh_failed");
      record.refresh.state = "failed";
      record.refresh.failure_code = code;
      record.refresh.failure_message = cleanMessage(refreshError.message);
      emitEvent(record.id, "account.connection.refresh.failed", gatewayActor(), {
        provider: record.provider,
        failure_code: code,
        attempt: record.refresh.attempt_count,
      });
      const invalidGrant = ["invalid_grant", "invalid_token", "access_denied", "unauthorized_client"].includes(code);
      if (invalidGrant) {
        setStatus(record, "action_required", `provider refresh rejected: ${code}`, gatewayActor());
        setUserAction(record, "refresh_token_expired", defaultActionType(record));
        queueUserActionNotification(record, "refresh_token_expired");
      } else if (record.expires_at && Date.parse(record.expires_at) <= now()) {
        setStatus(record, "expired", `credential expired; refresh failing: ${code}`, gatewayActor());
        setUserAction(record, "refresh_failed", defaultActionType(record));
        queueUserActionNotification(record, "refresh_failed");
      } else {
        // Ambiguous evidence (network error, provider 5xx): keep the credential
        // and mark the connection for retry/inspection.
        setStatus(record, "error", `refresh failed: ${code}`, gatewayActor());
      }
      flushConnections();
      return false;
    }
  }

  // The periodic credential-health pass. Runs on an interval from server.js and
  // on demand via POST /v1/account-connections/health/run. For each active
  // connection: refresh ahead of expiry when the provider supports it,
  // otherwise flag the user and queue a device notification.
  async function runHealthChecks() {
    const summary = { checked: 0, refreshed: 0, refresh_failed: 0, action_required: 0, expired: 0, notifications_queued: 0 };
    const nowMs = now();
    for (const record of Object.values(connections)) {
      if (!["connected", "expired", "error", "refreshing"].includes(record.status)) {
        continue;
      }
      summary.checked += 1;
      record.audit.last_health_check_at = nowIso();
      emitEvent(record.id, "account.connection.health.checked", gatewayActor("credential-health"), {
        provider: record.provider,
        status: record.status,
        expires_at: record.expires_at,
      });
      const expiresMs = record.expires_at ? Date.parse(record.expires_at) : NaN;
      const nearExpiry = Number.isFinite(expiresMs) && expiresMs - nowMs <= refreshLeewayMs;
      const pastExpiry = Number.isFinite(expiresMs) && expiresMs <= nowMs;
      if (!nearExpiry && record.status === "connected") {
        touch(record);
        continue;
      }
      if (refreshSupported(record) && (nearExpiry || record.status === "expired" || record.status === "error")) {
        const before = Object.values(notifications).length;
        const ok = await attemptRefresh(record, gatewayActor("credential-health"));
        if (ok) {
          summary.refreshed += 1;
        } else {
          summary.refresh_failed += 1;
          summary.notifications_queued += Object.values(notifications).length - before;
        }
        continue;
      }
      if (pastExpiry && record.status !== "expired") {
        setStatus(record, "expired", "credential reached expires_at without a refresh path", gatewayActor("credential-health"));
        setUserAction(record, "credential_expired", defaultActionType(record));
        summary.expired += 1;
        const notification = queueUserActionNotification(record, "credential_expired");
        if (notification && notification.status === "queued") {
          summary.notifications_queued += 1;
        }
      } else if (nearExpiry && !record.needs_user_action) {
        setUserAction(record, "credential_expiring", defaultActionType(record));
        setStatus(record, "action_required", "credential is expiring and cannot self-refresh", gatewayActor("credential-health"));
        summary.action_required += 1;
        const notification = queueUserActionNotification(record, "credential_expiring");
        if (notification && notification.status === "queued") {
          summary.notifications_queued += 1;
        }
      }
    }
    flushConnections();
    return summary;
  }

  // --- reauth / disable / disconnect ------------------------------------------------

  function requestReauth(userId, connectionId) {
    const record = ownedConnection(userId, connectionId);
    if (record.status === "revoked") {
      throw httpError(409, "connection is revoked; create a new connection instead");
    }
    const provider = providerById(catalog, record.provider);
    const action = startAuthAction(record, "reauth");
    return {
      connection_id: record.id,
      provider: record.provider,
      provider_label: provider?.label || record.provider,
      connection_label: record.label,
      reauth_action: action,
    };
  }

  function disable(userId, connectionId) {
    const record = ownedConnection(userId, connectionId);
    if (record.status === "revoked") {
      throw httpError(409, "connection is revoked and cannot be disabled");
    }
    emitEvent(record.id, "account.connection.disabled", userActor(userId), { provider: record.provider });
    clearUserAction(record);
    setStatus(record, "disabled", "disabled by user", userActor(userId));
    record.audit.updated_by = { kind: "user", id: userId };
    flushConnections();
    return serializeConnection(record);
  }

  async function disconnect(userId, connectionId) {
    const record = ownedConnection(userId, connectionId);
    const adapter = adapters.get(record.provider);
    let revoked = false;
    let revokeError = "";
    const secret = readCredential(record.id);
    if (secret && typeof adapter.revoke === "function") {
      try {
        const result = await adapter.revoke({ secret });
        revoked = Boolean(result?.revoked);
      } catch (error) {
        revokeError = cleanMessage(error.message);
      }
    }
    retireCredential(record.id);
    emitEvent(record.id, "account.connection.disconnected", userActor(userId), {
      provider: record.provider,
      provider_revoked: revoked,
      revoke_error: revokeError,
    });
    if (revoked) {
      emitEvent(record.id, "account.connection.revoked", gatewayActor(), { provider: record.provider });
    }
    clearUserAction(record);
    record.expires_at = "";
    record.refresh = emptyRefreshState(false);
    setStatus(record, "revoked", revoked ? "revoked at provider and disconnected" : "disconnected; server-side credential retired", userActor(userId));
    record.audit.updated_by = { kind: "user", id: userId };
    flushConnections();
    resolveNotificationsFor(record.id);
    return serializeConnection(record);
  }

  // --- status ------------------------------------------------------------------------

  function status() {
    const byStatus = {};
    let needsAction = 0;
    for (const record of Object.values(connections)) {
      byStatus[record.status] = (byStatus[record.status] || 0) + 1;
      if (record.needs_user_action) {
        needsAction += 1;
      }
    }
    return {
      providers: catalog.length,
      connections: Object.keys(connections).length,
      by_status: byStatus,
      needs_user_action: needsAction,
      notifications_queued: Object.values(notifications).filter((notification) => notification.status === "queued").length,
      credential_encryption: { algorithm: "aes-256-gcm", key_source: encryptionKeySource },
      refresh_leeway_ms: refreshLeewayMs,
      store: "local_json",
      store_dir: storeDir,
    };
  }

  return {
    storeDir,
    catalog: serializeProviders,
    create,
    list,
    get,
    patch,
    requestRefresh,
    requestReauth,
    disable,
    disconnect,
    oauthStartRedirect,
    completeOauthCallback,
    secretFormInfo,
    submitSecretForm,
    listNotifications,
    recordNotificationReceipt,
    runHealthChecks,
    listEvents,
    status,
  };
}

// --- pure helpers ---------------------------------------------------------------------

function emptyRefreshState(supported) {
  return {
    supported: Boolean(supported),
    state: supported ? "idle" : "not_supported",
    last_attempt_at: "",
    last_success_at: "",
    next_attempt_at: "",
    failure_code: "",
    failure_message: "",
    attempt_count: 0,
  };
}

function normalizeNotificationTarget(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const deviceId = String(value.device_id || "").trim().slice(0, 120);
  if (!deviceId) {
    return null;
  }
  return {
    device_id: deviceId,
    surface_type: String(value.surface_type || "android").slice(0, 40),
    channel: String(value.channel || "credential_health").slice(0, 60),
    enabled: value.enabled !== false,
  };
}

// Reject any client-supplied field whose name looks like credential material.
// Walks nested objects; returns the offending key or null.
const NON_SECRET_FIELD_ALLOWLIST = new Set([
  "credential_kind",
  "credential_ref_kind",
  "device_notification_target",
  "reauth_endpoint",
]);

function findSecretField(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 4) {
    return null;
  }
  for (const [key, child] of Object.entries(value)) {
    if (!NON_SECRET_FIELD_ALLOWLIST.has(key) && SECRET_FIELD_PATTERN.test(key)) {
      return key;
    }
    const nested = findSecretField(child, depth + 1);
    if (nested) {
      return nested;
    }
  }
  return null;
}

function findSecretValue(payload, secretValues) {
  if (!secretValues.length) {
    return false;
  }
  const text = JSON.stringify(payload);
  return secretValues.some((secret) => text.includes(secret));
}

function credentialKindLabel(kind) {
  if (kind === "api_key") return "API key";
  if (kind === "personal_access_token") return "personal access token";
  if (kind === "service_account") return "service account credential";
  return kind;
}

function loadEncryptionKey(env, keyPath) {
  const raw = String(env.ACCOUNT_CREDENTIAL_KEY || "").trim();
  if (raw) {
    const key = decodeKey(raw);
    if (!key) {
      throw new Error("ACCOUNT_CREDENTIAL_KEY must be 32 bytes, hex or base64 encoded");
    }
    return key;
  }
  if (fs.existsSync(keyPath)) {
    const key = decodeKey(fs.readFileSync(keyPath, "utf8").trim());
    if (key) {
      return key;
    }
  }
  const key = crypto.randomBytes(32);
  fs.writeFileSync(keyPath, key.toString("hex"), { mode: 0o600 });
  return key;
}

function decodeKey(raw) {
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, "hex");
  }
  try {
    const decoded = Buffer.from(raw, "base64");
    if (decoded.length === 32) {
      return decoded;
    }
  } catch {
    // fall through
  }
  return null;
}

function encryptJson(key, value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return {
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}

function decryptJson(key, enc) {
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(enc.iv, "base64"));
  decipher.setAuthTag(Buffer.from(enc.tag, "base64"));
  const plain = Buffer.concat([decipher.update(Buffer.from(enc.data, "base64")), decipher.final()]);
  return JSON.parse(plain.toString("utf8"));
}

function loadJsonMap(filePath, key) {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return raw && typeof raw === "object" && raw[key] && typeof raw[key] === "object" ? raw[key] : {};
  } catch {
    return {};
  }
}

function sanitizeReturnUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

function sanitizeIsoDate(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
}

function userActor(userId) {
  return { kind: "user", id: userId };
}

function gatewayActor(id = "gateway") {
  return { kind: "gateway", id };
}

function numberOr(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback;
}

function clampLimit(value, fallback) {
  const numeric = Number(value || fallback);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(1, Math.min(Math.trunc(numeric), 500));
}

function cleanMessage(message) {
  return String(message || "").replace(/[\r\n]+/g, " ").slice(0, 300);
}

function nowIso() {
  return new Date().toISOString();
}

function stripTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

module.exports = {
  createAccountConnectionStore,
  STATUSES,
  REFRESH_STATES,
  CREDENTIAL_REF_KINDS,
  httpError,
};
