import { sha256 } from "./surface-program-contract.js";

const MAX_SELECTOR_LENGTH = 500;
const MAX_TEXT_LENGTH = 16 * 1024;
const SENSITIVE_ACTION_TEXT = /\b(pay|purchase|buy|send|publish|post|delete|remove|transfer|password|sign\s*out|log\s*out)\b/i;

function boundedSelector(args) {
  const selector = String(args?.selector || "");
  if (!selector || selector.length > MAX_SELECTOR_LENGTH) throw new Error("invalid_selector");
  return selector;
}

function injectionValue(results) {
  if (!Array.isArray(results) || results.length !== 1 || !("result" in results[0])) throw new Error("page_injection_failed");
  return { value: results[0].result, documentId: results[0].documentId || "" };
}

function createChromeSurfaceProgramAdapter(chromeApi = chrome) {
  async function inject(tabId, func, args = []) {
    return injectionValue(await chromeApi.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: "ISOLATED", func, args }));
  }

  async function currentBinding(tabId) {
    const tab = await chromeApi.tabs.get(tabId);
    if (!tab || tab.id !== tabId || !Number.isInteger(tab.windowId)) throw new Error("bound_tab_missing");
    const observed = await inject(tabId, () => {
      const key = "__aggieSurfaceProgramDocumentIdV1";
      if (!globalThis[key]) Object.defineProperty(globalThis, key, { value: `doc_${crypto.randomUUID()}`, configurable: false, writable: false });
      return { origin: location.origin, url: location.href, title: document.title, pageEpoch: Math.round(performance.timeOrigin), documentId: globalThis[key] };
    });
    const state = { tab_id: tabId, window_id: tab.windowId, frame_id: 0, origin: observed.value.origin, document_id: observed.value.documentId, page_epoch: observed.value.pageEpoch };
    const observation = { origin: observed.value.origin, document_id: observed.value.documentId, page_epoch: observed.value.pageEpoch, title: String(observed.value.title || "").slice(0, 500) };
    return { ...state, observation_id: `obs_${observed.value.documentId}`, observation_sha256: await sha256(observation), state_sha256: await sha256(state) };
  }

  async function snapshot(tabId) {
    const { value } = await inject(tabId, (maxText) => ({
      title: document.title.slice(0, 500),
      url: location.href,
      text: String(document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, maxText),
    }), [MAX_TEXT_LENGTH]);
    return value;
  }

  async function queryElements(tabId, args) {
    const selector = boundedSelector(args);
    const requestedLimit = Number(args.limit ?? 25);
    if (!Number.isFinite(requestedLimit)) throw new Error("invalid_limit");
    const limit = Math.max(1, Math.min(100, Math.trunc(requestedLimit)));
    const { value } = await inject(tabId, (query, maximum) => {
      const clean = (value) => String(value || "").replace(/\s+/g, " ").trim().slice(0, 200);
      return [...document.querySelectorAll(query)].filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }).slice(0, maximum).map((element, index) => {
        const rect = element.getBoundingClientRect();
        const label = clean(element.getAttribute("aria-label") || element.innerText || element.getAttribute("placeholder") || element.getAttribute("name"));
        const fingerprint = { tag: element.tagName.toLowerCase(), type: element.getAttribute("type") || "", label, bounds: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)] };
        return { public: { tag: fingerprint.tag, type: fingerprint.type, label, bounds: fingerprint.bounds }, handle: { selector: query, index, fingerprint } };
      });
    }, [selector, limit]);
    return value;
  }

  async function getText(tabId, args) {
    const selector = boundedSelector(args);
    const { value } = await inject(tabId, (query, maximum) => {
      const element = document.querySelector(query);
      if (!element) throw new Error("element_not_found");
      if (element instanceof HTMLInputElement && element.type === "password") return "[redacted]";
      return String("value" in element ? element.value : element.textContent || "").slice(0, maximum);
    }, [selector, MAX_TEXT_LENGTH]);
    return value;
  }

  async function wait(tabId, args) {
    const selector = boundedSelector(args);
    const text = args.text == null ? null : String(args.text).slice(0, 500);
    const requestedTimeout = Number(args.timeout_ms ?? 1000);
    if (!Number.isFinite(requestedTimeout)) throw new Error("invalid_timeout");
    const timeout = Math.max(1, Math.min(5000, Math.trunc(requestedTimeout)));
    const { value } = await inject(tabId, async (query, expectedText, timeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() <= deadline) {
        const element = document.querySelector(query);
        const actual = String(element && ("value" in element ? element.value : element.textContent) || "");
        if (element && (expectedText == null || actual.includes(expectedText))) return { found: true };
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error("wait_timeout");
    }, [selector, text, timeout]);
    return value;
  }

  async function locateAndMutate(tabId, handle, operation, text = "") {
    const { value } = await inject(tabId, (bound, action, value) => {
      const clean = (item) => String(item || "").replace(/\s+/g, " ").trim().slice(0, 200);
      const elements = [...document.querySelectorAll(bound.selector)].filter((element) => {
        const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0;
      });
      const element = elements[bound.index];
      if (!element?.isConnected) throw new Error("element_handle_stale");
      const rect = element.getBoundingClientRect();
      const current = { tag: element.tagName.toLowerCase(), type: element.getAttribute("type") || "", label: clean(element.getAttribute("aria-label") || element.innerText || element.getAttribute("placeholder") || element.getAttribute("name")), bounds: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)] };
      const sameBounds = current.bounds.every((valueAtIndex, index) => Math.abs(valueAtIndex - bound.fingerprint.bounds[index]) <= 4);
      if (current.tag !== bound.fingerprint.tag || current.type !== bound.fingerprint.type || current.label !== bound.fingerprint.label || !sameBounds) throw new Error("element_handle_stale");
      if (action === "click") { element.click(); return { applied: true }; }
      if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element.isContentEditable)) throw new Error("element_not_editable");
      if (element instanceof HTMLInputElement && element.type === "password") throw new Error("password_input_requires_explicit_approval");
      if (element.isContentEditable) element.textContent = action === "fill" ? value : `${element.textContent || ""}${value}`;
      else {
        const nextValue = action === "fill" ? value : `${element.value || ""}${value}`;
        const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
        if (!setter) throw new Error("native_value_setter_unavailable");
        setter.call(element, nextValue);
      }
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return { applied: true };
    }, [handle, operation, String(text).slice(0, 4000)]);
    return value;
  }

  return Object.freeze({
    currentBinding,
    snapshot,
    queryElements,
    getText,
    wait,
    tabGet: async (tabId) => {
      const tab = await chromeApi.tabs.get(tabId);
      return { tab_id: tab.id, window_id: tab.windowId, title: String(tab.title || "").slice(0, 500), url: tab.url || "" };
    },
    click: (tabId, handle) => {
      if (SENSITIVE_ACTION_TEXT.test(handle.fingerprint?.label || "")) throw new Error("sensitive_click_requires_explicit_approval");
      return locateAndMutate(tabId, handle, "click");
    },
    fill: (tabId, handle, args) => locateAndMutate(tabId, handle, "fill", args.text),
    type: (tabId, handle, args) => locateAndMutate(tabId, handle, "type", args.text),
  });
}

export { MAX_SELECTOR_LENGTH, SENSITIVE_ACTION_TEXT, boundedSelector, createChromeSurfaceProgramAdapter, injectionValue };
