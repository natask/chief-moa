const OWNED_TABS_KEY = "agee.browser.owned_tabs.v1";
const MAX_OWNED_TABS = 100;
const OWNERSHIP_LEASE_MS = 30 * 60 * 1000;

function tabOrigin(url) {
  try { return new URL(String(url || "")).origin; } catch { return ""; }
}

function createBrowserTabRuntime({
  chromeApi, storage = chromeApi?.storage?.local,
  now = () => new Date().toISOString(), nowMs = () => Date.now(),
  nonce = () => crypto.randomUUID(), leaseMs = OWNERSHIP_LEASE_MS,
} = {}) {
  async function records() {
    const stored = await storage.get({ [OWNED_TABS_KEY]: [] });
    return Array.isArray(stored[OWNED_TABS_KEY]) ? stored[OWNED_TABS_KEY] : [];
  }

  async function remember(tab, requestId = null) {
    if (!Number.isInteger(tab?.id)) throw new Error("created browser tab has no id");
    const current = (await records()).filter((item) => item?.tab_id !== tab.id);
    const createdAtMs = nowMs();
    const record = {
      tab_id: tab.id, request_id: requestId || null, ownership_nonce: nonce(),
      created_url: String(tab.url || ""), created_origin: tabOrigin(tab.url),
      created_at: now(), expires_at_ms: createdAtMs + leaseMs,
    };
    await storage.set({ [OWNED_TABS_KEY]: [...current, record].slice(-MAX_OWNED_TABS) });
    return record;
  }

  async function isOwned(tabId) {
    return (await validate(tabId)).ok;
  }

  async function forget(tabId) {
    await storage.set({ [OWNED_TABS_KEY]: (await records()).filter((item) => item?.tab_id !== tabId) });
  }

  async function validate(tabId, ownershipNonce = null) {
    const record = (await records()).find((item) => item?.tab_id === tabId);
    if (!record) return { ok: false, code: "not_owned", error: "tab has no agent ownership lease" };
    if (!record.ownership_nonce || Number(record.expires_at_ms) <= nowMs()) {
      await forget(tabId);
      return { ok: false, code: "lease_expired", error: "tab ownership lease expired" };
    }
    if (ownershipNonce != null && ownershipNonce !== record.ownership_nonce) {
      return { ok: false, code: "identity_mismatch", error: "tab ownership nonce does not match" };
    }
    let tab;
    try { tab = await chromeApi.tabs.get(tabId); } catch {
      await forget(tabId);
      return { ok: false, code: "tab_missing", error: "owned tab no longer exists" };
    }
    const liveOrigin = tabOrigin(tab?.url);
    if (String(tab?.url || "") !== record.created_url || liveOrigin !== record.created_origin) {
      await forget(tabId);
      return { ok: false, code: "tab_identity_changed", error: "live tab URL or origin no longer matches its ownership lease" };
    }
    return { ok: true, tab, ownership: record };
  }

  async function updateBinding(tabId, ownershipNonce, url) {
    const record = (await records()).find((item) => item?.tab_id === tabId);
    if (!record || record.ownership_nonce !== ownershipNonce) return { ok: false, code: "identity_mismatch", error: "tab ownership nonce does not match" };
    if (Number(record.expires_at_ms) <= nowMs()) return (await forget(tabId), { ok: false, code: "lease_expired", error: "tab ownership lease expired" });
    try { await chromeApi.tabs.get(tabId); } catch { return (await forget(tabId), { ok: false, code: "tab_missing", error: "owned tab no longer exists" }); }
    const updated = { ...record, created_url: String(url || ""), created_origin: tabOrigin(url) };
    await storage.set({ [OWNED_TABS_KEY]: (await records()).map((item) => item?.tab_id === tabId ? updated : item) });
    return { ok: true, ownership: updated };
  }

  async function open({ url, background = false, requestId = null } = {}) {
    const tab = await chromeApi.tabs.create({ url, active: background !== true });
    const ownership = await remember({ ...tab, url: String(url || tab.url || "") }, requestId);
    return { tab, ownership };
  }

  async function close(tabId, ownershipNonce = null) {
    if (!Number.isInteger(tabId)) return { ok: false, code: "invalid_tab_id", error: "browser.tab.close requires an integer tab id" };
    if (!ownershipNonce) return { ok: false, code: "identity_required", error: "browser.tab.close requires the ownership nonce" };
    const validated = await validate(tabId, ownershipNonce);
    if (!validated.ok) return { ok: false, code: validated.code, error: `browser.tab.close denied: ${validated.error}` };
    await chromeApi.tabs.remove(tabId);
    await forget(tabId);
    return { ok: true, tab_id: tabId, ownership_nonce: validated.ownership.ownership_nonce };
  }

  return Object.freeze({ close, isOwned, open, remember, updateBinding, validate });
}

export { createBrowserTabRuntime, OWNED_TABS_KEY, OWNERSHIP_LEASE_MS };
