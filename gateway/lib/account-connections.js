"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const PROVIDERS = [
  { id: "openai", label: "OpenAI", credential_kinds: ["oauth2_authorization_code", "api_key"], supports_refresh: true, supports_manual_reauth: true, supports_multiple_connections: true, scopes: ["models.read", "responses.write"], docs_url: "https://platform.openai.com/account" },
  { id: "anthropic", label: "Anthropic", credential_kinds: ["api_key"], supports_refresh: false, supports_manual_reauth: true, supports_multiple_connections: true, scopes: ["messages.write"], docs_url: "https://console.anthropic.com/settings/keys" },
  { id: "google", label: "Google", credential_kinds: ["oauth2_authorization_code", "service_account", "external_handle"], supports_refresh: true, supports_manual_reauth: true, supports_multiple_connections: true, scopes: ["cloud-platform"], docs_url: "https://console.cloud.google.com/apis/credentials" },
  { id: "github", label: "GitHub", credential_kinds: ["oauth2_authorization_code", "personal_access_token"], supports_refresh: true, supports_manual_reauth: true, supports_multiple_connections: true, scopes: ["repo.read", "repo.write"], docs_url: "https://github.com/settings/tokens" },
];

const CREDENTIAL_KINDS = new Set(["oauth2_authorization_code", "oauth2_device_code", "api_key", "personal_access_token", "service_account", "external_handle", "none"]);
const REF_KINDS = new Set(["encrypted_server_secret", "opaque_broker_handle", "provider_managed_session", "none"]);
const STATUSES = new Set(["pending_user_auth", "connected", "refreshing", "action_required", "expired", "invalid", "disabled", "revoked", "error"]);
const ALLOWED_SECRET_KEYS = new Set(["credential_kind", "credential_ref_kind", "credential_kinds"]);
const SECRET_KEY = /(^|[_-])(secret|token|password|passphrase|private[_-]?key|api[_-]?key|refresh[_-]?token|access[_-]?token|client[_-]?secret|cookie|session[_-]?cookie|pat|service[_-]?account|credential|credentials)([_-]|$)/i;
const SECRET_VALUES = [/\bsk-[A-Za-z0-9_-]{12,}/, /\bgh[pousr]_[A-Za-z0-9_]{20,}/, /\bxox[baprs]-[A-Za-z0-9-]{20,}/, /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/];

function createAccountConnectionStore(options = {}) {
  const dataDir = path.resolve(options.dataDir || "./data");
  const connectionsPath = path.join(dataDir, "account-connections.json");
  const eventsPath = path.join(dataDir, "account-connection-events.jsonl");
  const ownerUserId = sanitizeId(options.ownerUserId || process.env.MOA_OWNER_USER_ID || "usr_owner", "usr_owner");
  const recordEvent = typeof options.recordEvent === "function" ? options.recordEvent : null;
  fs.mkdirSync(dataDir, { recursive: true });

  function providerCatalog() {
    return PROVIDERS.map((provider) => ({
      ...provider,
      credential_kinds: [...provider.credential_kinds],
      scopes: [...provider.scopes],
    }));
  }

  function list(filter = {}) {
    const userId = sanitizeId(filter.userId || ownerUserId, ownerUserId);
    return rows()
      .filter((connection) => connection.user_id === userId)
      .sort((a, b) => String(b.audit?.updated_at || "").localeCompare(String(a.audit?.updated_at || "")))
      .map(summary);
  }

  function get(id, filter = {}) {
    const userId = sanitizeId(filter.userId || ownerUserId, ownerUserId);
    const connection = rows().find((row) => row.id === sanitizeId(id, "") && row.user_id === userId);
    return connection ? summary(connection) : null;
  }

  function create(body = {}, actor = ownerActor(ownerUserId)) {
    assertNoSecretMaterial(body);
    const provider = providerFor(body.provider);
    const credentialKind = credentialKindFor(body.credential_kind || body.credentialKind || "none");
    const status = body.status ? statusFor(body.status) : (credentialKind === "none" || credentialKind === "external_handle" ? "connected" : "pending_user_auth");
    const now = new Date().toISOString();
    const connection = {
      id: randomId("acctconn"),
      user_id: sanitizeId(body.user_id || body.userId || ownerUserId, ownerUserId),
      provider: provider.id,
      provider_label: provider.label,
      label: labelFor(body.label || provider.label),
      account_subject: accountSubject(body.account_subject || body.accountSubject || {}),
      credential_kind: credentialKind,
      credential_ref_kind: refKindFor(body.credential_ref_kind || body.credentialRefKind || defaultRefKind(credentialKind)),
      status,
      status_reason: truncate(body.status_reason || body.statusReason || "", 500),
      expires_at: isoDate(body.expires_at || body.expiresAt || ""),
      scopes_granted: scopes(body.scopes_granted || body.scopesGranted || body.scopes || []),
      refresh: refreshState(body.refresh, provider.supports_refresh),
      needs_user_action: ["pending_user_auth", "action_required", "expired"].includes(status),
      user_action: null,
      device_notification_target: notificationTarget(body.device_notification_target || body.deviceNotificationTarget || null),
      audit: {
        created_at: now,
        updated_at: now,
        status_changed_at: now,
        last_health_check_at: "",
        last_used_at: "",
        created_by: actor,
        updated_by: actor,
      },
    };
    connection.user_action = connection.needs_user_action ? userAction(connection, "initial_authorization_required", now) : null;
    const all = rows();
    all.push(connection);
    writeRows(all);
    audit(connection, "account.connection.created", actor, { status });
    if (connection.needs_user_action) audit(connection, "account.connection.user_action_requested", actor, { reason: connection.user_action.reason });
    return summary(connection);
  }

  function patch(id, body = {}, actor = ownerActor(ownerUserId)) {
    assertNoSecretMaterial(body);
    const all = rows();
    const index = all.findIndex((row) => row.id === sanitizeId(id, "") && row.user_id === ownerUserId);
    if (index < 0) return null;
    const now = new Date().toISOString();
    const before = all[index].status;
    const next = { ...all[index] };
    if (Object.prototype.hasOwnProperty.call(body, "label")) next.label = labelFor(body.label);
    if (Object.prototype.hasOwnProperty.call(body, "device_notification_target") || Object.prototype.hasOwnProperty.call(body, "deviceNotificationTarget")) {
      next.device_notification_target = notificationTarget(body.device_notification_target || body.deviceNotificationTarget || null);
    }
    if (Object.prototype.hasOwnProperty.call(body, "status")) {
      next.status = statusFor(body.status);
      next.status_reason = truncate(body.status_reason || body.statusReason || "", 500);
      next.needs_user_action = ["pending_user_auth", "action_required", "expired"].includes(next.status);
      next.user_action = next.needs_user_action ? userAction(next, body.reason || "status_update", now) : null;
      next.audit.status_changed_at = before === next.status ? next.audit.status_changed_at : now;
    }
    if (Object.prototype.hasOwnProperty.call(body, "refresh")) {
      next.refresh = refreshState(body.refresh, providerFor(next.provider).supports_refresh);
    }
    next.audit = { ...next.audit, updated_at: now, updated_by: actor };
    all[index] = next;
    writeRows(all);
    if (before !== next.status) audit(next, "account.connection.status.changed", actor, { old_status: before, new_status: next.status });
    return summary(next);
  }

  function reauth(id, body = {}, actor = ownerActor(ownerUserId)) {
    assertNoSecretMaterial(body);
    const current = get(id);
    if (!current) return null;
    const action = reauthAction(current);
    const connection = patch(id, { status: current.status === "connected" ? "action_required" : current.status, status_reason: body.reason || "manual_reauth_requested" }, actor);
    audit(connection, "account.connection.reauth.started", actor, { action_type: action.type });
    return { connection_id: current.id, provider: current.provider, reauth_action: action, connection };
  }

  function refresh(id, actor = ownerActor(ownerUserId)) {
    const current = get(id);
    if (!current) return null;
    if (!providerFor(current.provider).supports_refresh) {
      const action = reauth(id, { reason: "refresh_not_supported" }, actor);
      return { status: 409, body: { connection: action.connection, needs_user_action: true, reauth_action: action.reauth_action } };
    }
    const connection = patch(id, {
      status: "action_required",
      status_reason: "refresh_scheduler_not_implemented",
      refresh: { state: "blocked", failure_code: "not_implemented", failure_message: "manual reauth is required in this slice" },
    }, actor);
    audit(connection, "account.connection.refresh.failed", actor, { failure_code: "not_implemented" });
    return { status: 202, body: { connection, refresh: connection.refresh } };
  }

  function disable(id, actor = ownerActor(ownerUserId)) {
    const connection = patch(id, { status: "disabled", status_reason: "disabled_by_user" }, actor);
    if (connection) audit(connection, "account.connection.disabled", actor, {});
    return connection;
  }

  function disconnect(id, actor = ownerActor(ownerUserId)) {
    const connection = patch(id, { status: "revoked", status_reason: "disconnected_by_user" }, actor);
    if (connection) audit(connection, "account.connection.revoked", actor, {});
    return connection;
  }

  function storageInfo() {
    return { mode: "json-file", path: connectionsPath, count: rows().length };
  }

  function rows() {
    try {
      const parsed = JSON.parse(fs.readFileSync(connectionsPath, "utf8"));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function writeRows(value) {
    const tmpPath = `${connectionsPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2));
    fs.renameSync(tmpPath, connectionsPath);
  }

  function audit(connection, type, actor, payload = {}) {
    if (!connection) return;
    const event = { id: randomId("acctevt"), ts: new Date().toISOString(), type, connection_id: connection.id, provider: connection.provider, actor, payload };
    fs.appendFileSync(eventsPath, `${JSON.stringify(event)}\n`);
    if (recordEvent) {
      recordEvent({
        event_type: type,
        stream_id: `account-connection:${connection.id}`,
        idempotency_key: `account-connection:${connection.id}:${event.id}`,
        occurred_at: event.ts,
        actor,
        correlation_id: connection.id,
        payload: {
          connection_id: connection.id,
          provider: connection.provider,
          label: connection.label,
          credential_kind: connection.credential_kind,
          status: connection.status,
          old_status: payload.old_status || "",
          new_status: payload.new_status || connection.status,
          refresh_state: connection.refresh?.state || "",
          needs_user_action: Boolean(connection.needs_user_action),
          reason: payload.reason || payload.failure_code || "",
        },
      });
    }
  }

  return { providerCatalog, list, get, create, patch, reauth, refresh, disable, disconnect, storageInfo, assertNoSecretMaterial };
}

function summary(connection) {
  return {
    id: connection.id,
    user_id: connection.user_id,
    provider: connection.provider,
    provider_label: connection.provider_label,
    label: connection.label,
    account_subject: accountSubject(connection.account_subject || {}),
    credential_kind: connection.credential_kind,
    credential_ref_kind: connection.credential_ref_kind,
    status: connection.status,
    status_reason: connection.status_reason || "",
    expires_at: connection.expires_at || "",
    scopes_granted: scopes(connection.scopes_granted || []),
    refresh: refreshState(connection.refresh, providerFor(connection.provider).supports_refresh),
    needs_user_action: Boolean(connection.needs_user_action),
    user_action: connection.user_action || null,
    device_notification_target: notificationTarget(connection.device_notification_target || null),
    audit: {
      created_at: connection.audit?.created_at || "",
      updated_at: connection.audit?.updated_at || "",
      status_changed_at: connection.audit?.status_changed_at || "",
      last_health_check_at: connection.audit?.last_health_check_at || "",
      last_used_at: connection.audit?.last_used_at || "",
      created_by: actor(connection.audit?.created_by || ownerActor(connection.user_id)),
      updated_by: actor(connection.audit?.updated_by || ownerActor(connection.user_id)),
    },
  };
}

function assertNoSecretMaterial(value, parts = []) {
  if (value == null) return;
  if (typeof value === "string") {
    for (const pattern of SECRET_VALUES) {
      if (pattern.test(value)) throw new Error(`secret-looking value is not accepted at ${parts.join(".") || "body"}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecretMaterial(item, parts.concat(String(index))));
    return;
  }
  if (typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    const lower = String(key).toLowerCase();
    if (!ALLOWED_SECRET_KEYS.has(lower) && SECRET_KEY.test(lower)) {
      throw new Error(`secret-looking field is not accepted: ${parts.concat(key).join(".")}`);
    }
    assertNoSecretMaterial(item, parts.concat(key));
  }
}

function providerFor(value) {
  const id = String(value || "").trim().toLowerCase().replace(/[^a-z0-9_.:-]/g, "");
  const provider = PROVIDERS.find((item) => item.id === id);
  if (!provider) throw new Error(`provider must be one of: ${PROVIDERS.map((item) => item.id).join(", ")}`);
  return provider;
}

function credentialKindFor(value) {
  const safe = String(value || "none").trim().toLowerCase();
  if (!CREDENTIAL_KINDS.has(safe)) throw new Error(`credential_kind must be one of: ${Array.from(CREDENTIAL_KINDS).join(", ")}`);
  return safe;
}

function refKindFor(value) {
  const safe = String(value || "none").trim().toLowerCase();
  if (!REF_KINDS.has(safe)) throw new Error(`credential_ref_kind must be one of: ${Array.from(REF_KINDS).join(", ")}`);
  return safe;
}

function statusFor(value) {
  const safe = String(value || "").trim().toLowerCase();
  if (!STATUSES.has(safe)) throw new Error(`status must be one of: ${Array.from(STATUSES).join(", ")}`);
  return safe;
}

function defaultRefKind(kind) {
  if (kind === "external_handle") return "opaque_broker_handle";
  return "none";
}

function refreshState(value, supported) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    supported: Boolean(supported),
    state: supported ? String(input.state || "idle").slice(0, 40) : "not_supported",
    last_attempt_at: isoDate(input.last_attempt_at || input.lastAttemptAt || ""),
    last_success_at: isoDate(input.last_success_at || input.lastSuccessAt || ""),
    next_attempt_at: isoDate(input.next_attempt_at || input.nextAttemptAt || ""),
    failure_code: truncate(input.failure_code || input.failureCode || "", 120),
    failure_message: truncate(input.failure_message || input.failureMessage || "", 500),
    attempt_count: Math.max(0, Math.min(1000, Number(input.attempt_count || input.attemptCount || 0) || 0)),
  };
}

function userAction(connection, reason, now) {
  return {
    reason: String(reason || "reauth_required").slice(0, 120),
    message: `${connection.provider_label || connection.provider} needs authorization.`,
    since: now,
    reauth_endpoint: `/v1/account-connections/${connection.id}/reauth`,
    action_type: "open_url",
    expires_at: "",
  };
}

function reauthAction(connection) {
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  if (connection.credential_kind === "oauth2_device_code") {
    return { type: "enter_device_code", verification_uri: `/v1/account-connections/${connection.id}/reauth/device`, user_code: `MOA-${crypto.randomBytes(3).toString("hex").toUpperCase()}`, expires_at: expiresAt, message: `Authorize ${connection.provider_label}.` };
  }
  if (["api_key", "personal_access_token", "service_account"].includes(connection.credential_kind)) {
    return { type: "gateway_secret_form", url: `/v1/account-connections/${connection.id}/reauth/form`, expires_at: expiresAt, message: `Enter the new ${connection.provider_label} credential in the gateway form.` };
  }
  return { type: "open_url", url: `/v1/account-connections/${connection.id}/reauth/start`, expires_at: expiresAt, message: `Sign in to ${connection.provider_label} again.` };
}

function accountSubject(value) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    display: truncate(input.display || "", 240),
    provider_account_id: looseId(input.provider_account_id || input.providerAccountId || ""),
    subscription_id: looseId(input.subscription_id || input.subscriptionId || ""),
    organization_id: looseId(input.organization_id || input.organizationId || ""),
  };
}

function notificationTarget(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    device_id: looseId(value.device_id || value.deviceId || ""),
    surface_type: truncate(value.surface_type || value.surfaceType || "", 80),
    channel: truncate(value.channel || "credential_health", 120),
    enabled: value.enabled !== false,
  };
}

function scopes(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.slice(0, 80).map((item) => String(item || "").trim().replace(/[^a-zA-Z0-9_.:-]/g, "").slice(0, 120)).filter(Boolean))];
}

function actor(value) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return { kind: truncate(input.kind || "user", 40), id: sanitizeId(input.id || "usr_owner", "usr_owner") };
}

function ownerActor(id) {
  return { kind: "user", id: sanitizeId(id || "usr_owner", "usr_owner") };
}

function labelFor(value) {
  const label = String(value || "").trim().replace(/\s+/g, " ").slice(0, 120);
  if (!label) throw new Error("label is required");
  return label;
}

function isoDate(value) {
  const ms = Date.parse(String(value || ""));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : "";
}

function sanitizeId(value, fallback) {
  return String(value || "").trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 120) || fallback;
}

function looseId(value) {
  return String(value || "").trim().replace(/[^a-zA-Z0-9_.:@-]/g, "").slice(0, 240);
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

function truncate(value, max) {
  const text = String(value || "");
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

module.exports = { createAccountConnectionStore };
