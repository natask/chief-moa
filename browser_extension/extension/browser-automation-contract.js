const MAX_SEARCH_QUERY_CHARS = 500;
const MAX_QUERY_RESULTS = 100;
const MAX_WAIT_MS = 30_000;

const BROWSER_AUTOMATION_TOOLS = Object.freeze([
  { tool: "browser.navigate", risk: "navigation", approval: "implicit_user_command" },
  { tool: "browser.search.open", risk: "navigation", approval: "implicit_user_command" },
  { tool: "browser.page.snapshot", risk: "read_only", approval: "none" },
  { tool: "browser.page.query_elements", risk: "read_only", approval: "none" },
  { tool: "browser.page.get_text", risk: "read_only", approval: "none" },
  { tool: "browser.page.wait", risk: "read_only", approval: "none" },
  { tool: "browser.page.screenshot", risk: "browser_local_capture", approval: "implicit_user_command" },
  { tool: "browser.page.click", risk: "browser_local_action", approval: "target_app_confirmation" },
  { tool: "browser.page.fill", risk: "browser_local_action", approval: "implicit_user_command" },
  { tool: "browser.page.type", risk: "browser_local_action", approval: "implicit_user_command" },
]);

function browserAutomationToolManifest() {
  return BROWSER_AUTOMATION_TOOLS.map((entry) => ({ ...entry }));
}

function browserLocalToolManifest() {
  return [
    ...browserAutomationToolManifest(),
    { tool: "browser.tab.list", risk: "read_only", approval: "none" },
    { tool: "browser.tab.open", risk: "navigation", approval: "implicit_user_command" },
    { tool: "browser.tab.activate", risk: "navigation", approval: "implicit_user_command" },
    { tool: "browser.tab.close", risk: "destructive_browser_local", approval: "implicit_user_command" },
    { tool: "browser.tab.reload", risk: "navigation", approval: "implicit_user_command" },
    { tool: "browser.cdp.execute", risk: "browser_local_debugger", approval: "implicit_user_command", authority_profiles: ["semantic", "automation", "debug"], target_scope: "agent_owned_inactive_tab" },
    { tool: "browser.task.claim", risk: "browser_local", approval: "none" },
    { tool: "page.snapshot", risk: "read_only", approval: "none" },
  ];
}

function boundedTabId(value) {
  if (value == null || value === "") return null;
  const tabId = Number(value);
  return Number.isInteger(tabId) && tabId >= 0 ? tabId : null;
}

function boundedElementIndex(value, required = true) {
  if (value == null && !required) return null;
  const index = Number(value);
  if (!Number.isInteger(index) || index < 0 || index >= 100) throw new Error("element index must be an integer from 0 to 99");
  return index;
}

function boundedLocator(input = {}) {
  const locator = {};
  for (const key of ["query", "role", "name", "label", "placeholder", "testId", "tag", "type"]) {
    const source = key === "testId" ? (input.test_id ?? input.testId) : input[key];
    const value = String(source || "").trim().slice(0, 200);
    if (value) locator[key] = value.toLowerCase();
  }
  return Object.keys(locator).length ? locator : null;
}

function actionTarget(input = {}) {
  const index = boundedElementIndex(input.index, false);
  if (index != null) return { index };
  const locator = boundedLocator(input);
  if (!locator) throw new Error("page action requires an element index or semantic locator");
  return { index: null, locator };
}

function normalizeSearchRequest(input = {}) {
  const query = String(input.query || input.text || "").trim().slice(0, MAX_SEARCH_QUERY_CHARS);
  if (!query) throw new Error("browser.search.open requires a query");
  const provider = String(input.provider || input.site || "google").trim().toLowerCase();
  let url;
  if (provider === "amazon" || provider === "amazon.com") {
    url = new URL("https://www.amazon.com/s");
    url.searchParams.set("k", query);
  } else if (provider === "google" || provider === "web") {
    url = new URL("https://www.google.com/search");
    url.searchParams.set("q", query);
  } else {
    throw new Error(`unsupported search provider: ${provider}`);
  }
  return {
    query,
    provider: provider.startsWith("amazon") ? "amazon" : "google",
    url: url.href,
    active: input.active !== false,
  };
}

function normalizePageToolRequest(tool, input = {}) {
  const tabId = boundedTabId(input.tab_id ?? input.tabId);
  if (tool === "browser.page.click") {
    return { tabId, ...actionTarget(input), action: "click" };
  }
  if (tool === "browser.page.fill" || tool === "browser.page.type") {
    const text = String(input.value ?? input.text ?? "");
    if (text.length > 2000) throw new Error(`${tool} text exceeds 2000 characters`);
    return { tabId, ...actionTarget(input), action: "type", text };
  }
  if (tool === "browser.page.query_elements") {
    const locator = boundedLocator({ ...input, query: input.query || input.text });
    const limitValue = Number(input.limit);
    const limit = Number.isInteger(limitValue) && limitValue > 0 ? Math.min(limitValue, MAX_QUERY_RESULTS) : 25;
    return { tabId, locator, limit };
  }
  if (tool === "browser.page.get_text") {
    return { tabId, index: boundedElementIndex(input.index, false), locator: boundedLocator(input) };
  }
  if (tool === "browser.page.wait") {
    const locator = boundedLocator({ ...input, query: input.query || input.text });
    if (!locator) throw new Error("browser.page.wait requires query text or a semantic locator");
    const timeoutValue = Number(input.timeout_ms ?? input.timeout);
    const timeoutMs = Number.isFinite(timeoutValue) && timeoutValue > 0 ? Math.min(Math.floor(timeoutValue), MAX_WAIT_MS) : 10_000;
    return { tabId, locator, timeoutMs };
  }
  return { tabId };
}

function filterSnapshotElements(snapshot, requestedLocator, limit) {
  const elements = Array.isArray(snapshot?.elements) ? snapshot.elements : [];
  const locator = typeof requestedLocator === "string"
    ? boundedLocator({ query: requestedLocator })
    : requestedLocator;
  if (!locator) return elements.slice(0, limit);
  return elements.filter((element) => {
    const normalized = {
      tag: String(element?.tag || "").toLowerCase(),
      type: String(element?.type || "").toLowerCase(),
      role: String(element?.role || "").toLowerCase(),
      name: String(element?.name || "").toLowerCase(),
      label: String(element?.label || "").toLowerCase(),
      placeholder: String(element?.placeholder || "").toLowerCase(),
      testId: String(element?.test_id || element?.testId || "").toLowerCase(),
    };
    const haystack = Object.values(normalized).join(" ");
    return Object.entries(locator).every(([key, value]) =>
      key === "query" ? haystack.includes(value) : normalized[key]?.includes(value)
    );
  }).slice(0, limit);
}

export {
  browserAutomationToolManifest,
  browserLocalToolManifest,
  boundedTabId,
  filterSnapshotElements,
  normalizePageToolRequest,
  normalizeSearchRequest,
};
