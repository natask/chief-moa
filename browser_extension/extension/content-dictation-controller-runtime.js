(function installContentDictationControllerRuntime(global) {
  "use strict";

  const TERMINAL_REASONS = Object.freeze({
    ALREADY_CONSUMED: "already_consumed",
    EMPTY_TRANSCRIPT: "empty_transcript",
    FOCUS_CHANGED: "focus_changed",
    INSERT_FAILED: "insert_failed",
    SENSITIVE_TARGET: "sensitive_target",
    STALE_CONTEXT: "stale_context",
    STALE_TARGET: "stale_target",
    UNSUPPORTED_TARGET: "unsupported_target",
  });

  function normalizedInputType(target) {
    return String(target?.type || "text").trim().toLowerCase();
  }

  function isSensitiveTarget(target) {
    if (!target || typeof target !== "object") return false;
    if (String(target.tagName || "").toUpperCase() === "INPUT") {
      if (normalizedInputType(target) === "password") return true;
      const autocomplete = String(target.autocomplete || target.getAttribute?.("autocomplete") || "").toLowerCase();
      if (autocomplete === "current-password" || autocomplete === "new-password") return true;
    }
    return Boolean(target.closest?.("[data-agee-sensitive], [data-moa-sensitive]"));
  }

  function classifyTarget(target) {
    if (!target || typeof target !== "object") return { ok: false, reason: TERMINAL_REASONS.UNSUPPORTED_TARGET };
    if (isSensitiveTarget(target)) return { ok: false, reason: TERMINAL_REASONS.SENSITIVE_TARGET };
    if (target.closest?.("#agee-root")) return { ok: false, reason: TERMINAL_REASONS.UNSUPPORTED_TARGET };
    if (target.disabled === true || target.readOnly === true || target.isConnected === false) {
      return { ok: false, reason: TERMINAL_REASONS.UNSUPPORTED_TARGET };
    }
    const tag = String(target.tagName || "").toUpperCase();
    if (tag === "TEXTAREA") return { ok: true, kind: "textarea", target };
    if (tag === "INPUT") {
      const type = normalizedInputType(target);
      if (["text", "search", "email", "url", "tel"].includes(type)) return { ok: true, kind: "input", target };
      return { ok: false, reason: TERMINAL_REASONS.UNSUPPORTED_TARGET };
    }
    if (target.isContentEditable === true || String(target.contentEditable || "").toLowerCase() === "plaintext-only") {
      return { ok: true, kind: "contenteditable", target };
    }
    return { ok: false, reason: TERMINAL_REASONS.UNSUPPORTED_TARGET };
  }

  function normalizeContext(context) {
    const source = context && typeof context === "object" ? context : {};
    return {
      tabId: Number.isInteger(source.tabId) ? source.tabId : null,
      frameId: Number.isInteger(source.frameId) ? source.frameId : null,
      documentId: typeof source.documentId === "string" && source.documentId ? source.documentId : null,
      documentToken: source.documentToken || null,
    };
  }

  function contextsMatch(expected, current) {
    const next = normalizeContext(current);
    for (const key of ["tabId", "frameId", "documentId", "documentToken"]) {
      if (expected[key] != null && expected[key] !== next[key]) return false;
    }
    return true;
  }

  function dispatchTextInput(target, text, inputType) {
    let before;
    try {
      before = new InputEvent("beforeinput", { bubbles: true, cancelable: true, data: text, inputType });
    } catch {
      before = new Event("beforeinput", { bubbles: true, cancelable: true });
      before.data = text;
      before.inputType = inputType;
    }
    if (target.dispatchEvent?.(before) === false || before.defaultPrevented) return false;
    return true;
  }

  function dispatchInput(target, text, inputType) {
    let event;
    try {
      event = new InputEvent("input", { bubbles: true, data: text, inputType });
    } catch {
      event = new Event("input", { bubbles: true });
      event.data = text;
      event.inputType = inputType;
    }
    target.dispatchEvent?.(event);
  }

  function insertDomText(target, kind, text, documentObject = global.document) {
    const inputType = "insertText";
    if (!dispatchTextInput(target, text, inputType)) return false;
    if (kind === "input" || kind === "textarea") {
      const value = String(target.value || "");
      const start = Number.isInteger(target.selectionStart) ? target.selectionStart : value.length;
      const end = Number.isInteger(target.selectionEnd) ? target.selectionEnd : start;
      if (typeof target.setRangeText === "function") target.setRangeText(text, start, end, "end");
      else {
        target.value = `${value.slice(0, start)}${text}${value.slice(end)}`;
        const cursor = start + text.length;
        target.selectionStart = cursor;
        target.selectionEnd = cursor;
      }
      dispatchInput(target, text, inputType);
      return true;
    }

    const selection = documentObject?.getSelection?.();
    if (!selection || selection.rangeCount !== 1) return false;
    const range = selection.getRangeAt(0);
    if (!target.contains?.(range.commonAncestorContainer)) return false;
    range.deleteContents();
    const node = documentObject.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    dispatchInput(target, text, inputType);
    return true;
  }

  function createController(options = {}) {
    const now = typeof options.now === "function" ? options.now : () => Date.now();
    const createId = typeof options.createId === "function"
      ? options.createId
      : () => `dictation_${now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const readActiveTarget = typeof options.readActiveTarget === "function"
      ? options.readActiveTarget
      : () => global.document?.activeElement || null;
    const readContext = typeof options.readContext === "function" ? options.readContext : () => ({});
    const insertText = typeof options.insertText === "function" ? options.insertText : insertDomText;
    const onReceipt = typeof options.onReceipt === "function" ? options.onReceipt : () => {};
    const watch = typeof options.watch === "function" ? options.watch : () => () => {};
    const bindings = new Map();

    function emit(binding, status, reason, chars = 0) {
      const receipt = Object.freeze({
        version: 1,
        id: binding?.id || createId(),
        status,
        reason,
        target_kind: binding?.kind || null,
        tab_id: binding?.context?.tabId ?? null,
        frame_id: binding?.context?.frameId ?? null,
        document_id: binding?.context?.documentId ?? null,
        character_count: chars,
        created_at: binding?.createdAt || now(),
        completed_at: now(),
      });
      onReceipt(receipt);
      return receipt;
    }

    function bind() {
      const classification = classifyTarget(readActiveTarget());
      if (!classification.ok) {
        return { ok: false, reason: classification.reason, receipt: emit(null, "refused", classification.reason) };
      }
      const binding = {
        id: createId(),
        target: classification.target,
        kind: classification.kind,
        context: normalizeContext(readContext()),
        createdAt: now(),
        terminal: false,
        invalidReason: null,
        unwatch: null,
      };
      binding.unwatch = watch(binding.target, (reason = TERMINAL_REASONS.FOCUS_CHANGED) => {
        binding.invalidReason ||= reason;
      });
      bindings.set(binding.id, binding);
      return { ok: true, id: binding.id, target_kind: binding.kind };
    }

    function attachContext(id, context) {
      const binding = bindings.get(id);
      if (!binding || binding.terminal || binding.invalidReason) return false;
      const next = normalizeContext(context);
      if (!contextsMatch(binding.context, next)) {
        binding.invalidReason = TERMINAL_REASONS.STALE_CONTEXT;
        return false;
      }
      binding.context = next;
      return true;
    }

    function invalidate(id, reason = TERMINAL_REASONS.FOCUS_CHANGED) {
      const binding = bindings.get(id);
      if (!binding || binding.terminal) return false;
      binding.invalidReason ||= reason;
      return true;
    }

    function insert(id, transcript) {
      const binding = bindings.get(id);
      if (!binding) return { ok: false, reason: TERMINAL_REASONS.STALE_TARGET };
      if (binding.terminal) return { ok: false, reason: TERMINAL_REASONS.ALREADY_CONSUMED };
      binding.terminal = true;
      binding.unwatch?.();
      const text = typeof transcript === "string" ? transcript : "";
      let reason = binding.invalidReason;
      if (!reason && !text) reason = TERMINAL_REASONS.EMPTY_TRANSCRIPT;
      if (!reason && !contextsMatch(binding.context, readContext())) reason = TERMINAL_REASONS.STALE_CONTEXT;
      if (!reason && binding.target !== readActiveTarget()) reason = TERMINAL_REASONS.FOCUS_CHANGED;
      const current = !reason ? classifyTarget(binding.target) : null;
      if (!reason && (!current?.ok || current.target !== binding.target || current.kind !== binding.kind)) {
        reason = current?.reason === TERMINAL_REASONS.SENSITIVE_TARGET
          ? TERMINAL_REASONS.SENSITIVE_TARGET
          : TERMINAL_REASONS.STALE_TARGET;
      }
      if (reason) return { ok: false, reason, receipt: emit(binding, "refused", reason) };
      let inserted = false;
      try {
        inserted = insertText(binding.target, binding.kind, text) === true;
      } catch {
        inserted = false;
      }
      if (!inserted) {
        return { ok: false, reason: TERMINAL_REASONS.INSERT_FAILED, receipt: emit(binding, "failed", TERMINAL_REASONS.INSERT_FAILED) };
      }
      return { ok: true, receipt: emit(binding, "inserted", "inserted", text.length) };
    }

    return Object.freeze({ attachContext, bind, insert, invalidate });
  }

  global.AgeeContentDictationControllerRuntime = Object.freeze({
    TERMINAL_REASONS,
    classifyTarget,
    contextsMatch,
    createController,
    insertDomText,
    isSensitiveTarget,
    normalizeContext,
  });
})(typeof globalThis !== "undefined" ? globalThis : this);
