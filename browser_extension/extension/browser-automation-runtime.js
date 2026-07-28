import { filterSnapshotElements, normalizePageToolRequest, normalizeSearchRequest } from "./browser-automation-contract.js";

const PAGE_TOOLS = new Set([
  "browser.page.snapshot", "browser.page.query_elements", "browser.page.get_text", "browser.page.wait",
  "browser.page.screenshot", "browser.page.click", "browser.page.fill", "browser.page.type",
]);

function createBrowserAutomationRuntime({
  chromeApi, allowedUrl, activeTab, snapshot, captureScreenshot, act, screenFromSnapshot,
  maxScreenshotChars, tabOwnership = null, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  async function execute(request) {
    const tool = String(request?.tool || "");
    const input = request?.input && typeof request.input === "object" ? request.input : {};
    if (tool === "browser.navigate") return navigate(tool, input);
    if (tool === "browser.search.open") return openSearch(tool, input);
    if (!PAGE_TOOLS.has(tool)) return null;
    return executePageTool(tool, input);
  }

  async function navigate(tool, input) {
    const url = allowedUrl(input.url || input.href || input.target);
    if (!url) return failure(tool, "blocked or invalid browser.navigate URL", "Browser navigation request was blocked.");
    const requestedTabId = Number(input.tab_id ?? input.tabId);
    let tab;
    if (input.new_tab === true || input.newTab === true) {
      tab = await chromeApi.tabs.create({ url, active: input.active !== false });
      const ownership = await tabOwnership?.remember({ ...tab, url }, input.request_id || null);
      tab.ownership = ownership;
    } else {
      const target = Number.isInteger(requestedTabId) && requestedTabId >= 0
        ? await chromeApi.tabs.get(requestedTabId)
        : await activeTab();
      if (!target?.id) return failure(tool, "no target tab", "No browser tab was available for navigation.");
      tab = await chromeApi.tabs.update(target.id, { url });
    }
    return success(tool, `Navigated browser to ${url}.`, { tab_id: tab?.id || null, url: tab?.url || url, active: tab?.active === true, ...(tab?.ownership ? { ownership_nonce: tab.ownership.ownership_nonce, ownership_expires_at_ms: tab.ownership.expires_at_ms } : {}) });
  }

  async function openSearch(tool, input) {
    const search = normalizeSearchRequest(input);
    const tab = await chromeApi.tabs.create({ url: search.url, active: search.active });
    const ownership = await tabOwnership?.remember({ ...tab, url: search.url }, input.request_id || null);
    return success(tool, `Opened ${search.provider} results for ${search.query}.`, {
      tab_id: tab?.id || null, url: tab?.url || search.url, provider: search.provider, query: search.query,
      ...(ownership ? { ownership_nonce: ownership.ownership_nonce, ownership_expires_at_ms: ownership.expires_at_ms } : {}),
    });
  }

  async function executePageTool(tool, input) {
    const normalized = normalizePageToolRequest(tool, input);
    const tab = normalized.tabId == null ? await activeTab() : await chromeApi.tabs.get(normalized.tabId);
    if (!tab?.id) return failure(tool, "no target tab", "No browser tab was available for the page tool.");
    if (tool === "browser.page.screenshot") return takeScreenshot(tool, tab);
    if (tool === "browser.page.wait") return waitForTarget(tool, tab, normalized);
    const page = await snapshot(tab.id);
    if (tool === "browser.page.snapshot") {
      return success(tool, `Captured page snapshot for ${page.title || tab.title || "browser tab"}.`, {
        tab_id: tab.id, screen: screenFromSnapshot(page), snapshot_id: page.snapshotId || null,
      });
    }
    if (tool === "browser.page.query_elements") {
      const elements = filterSnapshotElements(page, normalized.locator, normalized.limit);
      return success(tool, `Matched ${elements.length} page element${elements.length === 1 ? "" : "s"}.`, { tab_id: tab.id, elements });
    }
    if (tool === "browser.page.get_text") return readText(tool, tab, page, normalized);
    return pageAction(tool, tab, page, normalized);
  }

  async function takeScreenshot(tool, tab) {
    const data = String(await captureScreenshot(tab.id) || "");
    const image = data && data.length <= maxScreenshotChars
      ? { encoding: "base64_jpeg", data }
      : { encoding: "omitted", reason: data ? "screenshot exceeds the bounded tool payload" : "screenshot capture failed" };
    return image.encoding === "omitted"
      ? { ...failure(tool, image.reason, image.reason), result: { tab_id: tab.id, screenshot: image } }
      : success(tool, `Captured browser tab ${tab.id}.`, { tab_id: tab.id, screenshot: image });
  }

  async function waitForTarget(tool, tab, normalized) {
    const deadline = Date.now() + normalized.timeoutMs;
    while (Date.now() <= deadline) {
      const page = await snapshot(tab.id);
      const matches = filterSnapshotElements(page, normalized.locator, 1);
      const pageQuery = normalized.locator?.query || "";
      if (matches.length || (pageQuery && String(page.pageText || "").toLowerCase().includes(pageQuery))) {
        return success(tool, `Found the requested page target in browser tab ${tab.id}.`, { tab_id: tab.id, element: matches[0] || null });
      }
      await sleep(250);
    }
    return failure(tool, "timed out waiting for the requested page target", "Timed out waiting for the requested page target.");
  }

  function readText(tool, tab, page, normalized) {
    const element = normalized.index != null
      ? page.elements?.find((item) => item.i === normalized.index)
      : filterSnapshotElements(page, normalized.locator, 1)[0] || null;
    const targeted = normalized.index != null || normalized.locator != null;
    if (targeted && !element) {
      return failure(tool, "page target not found", "The requested page target was not found.", { tab_id: tab.id, retryable: true });
    }
    return success(tool, element ? `Read page element ${element.i}.` : `Read visible text from ${page.title || "browser tab"}.`, {
      tab_id: tab.id, text: element ? element.label || "" : page.pageText || "", element: element || null,
    });
  }

  async function pageAction(tool, tab, page, normalized) {
    const target = normalized.index != null
      ? page.elements?.find((item) => item.i === normalized.index)
      : filterSnapshotElements(page, normalized.locator, 1)[0] || null;
    if (!target) {
      return failure(tool, "page target not found", "The requested page target was not found; capture a fresh snapshot and retry with a stable locator.", {
        tab_id: tab.id, retryable: true,
      });
    }
    const background = await tabOwnership?.isOwned(tab.id) === true && tab.active !== true;
    const response = await act(tab.id, { action: normalized.action, index: target.i, text: normalized.text, background });
    const result = String(response?.result || "");
    const ok = !/^error:|^no element|^user cancelled/i.test(result);
    return ok
      ? success(tool, result || `${tool} completed.`, { tab_id: tab.id, action_result: result })
      : failure(tool, result || `${tool} failed.`, result || `${tool} failed.`, { tab_id: tab.id, action_result: result });
  }

  return Object.freeze({ execute });
}

function success(tool, summary, result) {
  return { ok: true, summary, result, local_receipt: { tool, success: true } };
}

function failure(tool, error, summary, result) {
  return { ok: false, error, summary, ...(result ? { result } : {}), local_receipt: { tool, success: false } };
}

export { createBrowserAutomationRuntime };
