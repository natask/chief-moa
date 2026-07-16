(function installContentExtensionApiRuntime(global) {
  "use strict";

  const root = global || globalThis;

  function createContentExtensionApiRuntime(options = {}) {
    const getChrome = options.getChrome || (() => root.chrome);
    const decodeBase64 = options.decodeBase64 || ((value) => root.atob(value));
    const ByteArray = options.ByteArray || root.Uint8Array;
    let contextInvalidated = false;

    function markExtensionContextInvalidated(error) {
      const message = String(error?.message || error || "");
      if (!/extension context invalidated|context invalidated/i.test(message)) return false;
      contextInvalidated = true;
      return true;
    }

    function isExtensionContextInvalidated() {
      return contextInvalidated;
    }

    function canCallExtensionApi() {
      if (contextInvalidated) return false;
      try {
        const chromeApi = getChrome();
        if (!chromeApi?.runtime?.id) {
          contextInvalidated = true;
          return false;
        }
        return true;
      } catch (error) {
        markExtensionContextInvalidated(error);
        return false;
      }
    }

    function safeExtensionCall(fallback, operation) {
      if (!canCallExtensionApi()) return Promise.resolve(fallback);
      try {
        return Promise.resolve(operation()).catch((error) => {
          if (markExtensionContextInvalidated(error)) return fallback;
          throw error;
        });
      } catch (error) {
        if (markExtensionContextInvalidated(error)) return Promise.resolve(fallback);
        return Promise.reject(error);
      }
    }

    function safeRuntimeSendMessage(message) {
      return safeExtensionCall(null, () => {
        const runtime = getChrome()?.runtime;
        return runtime?.sendMessage ? runtime.sendMessage(message) : null;
      });
    }

    function safeStorageLocalGet(defaults) {
      return safeExtensionCall(defaults, () => {
        const local = getChrome()?.storage?.local;
        return local?.get ? local.get(defaults) : defaults;
      });
    }

    function safeStorageLocalSet(items) {
      return safeExtensionCall(null, () => {
        const local = getChrome()?.storage?.local;
        return local?.set ? local.set(items) : null;
      });
    }

    function base64ToBuffer(value) {
      const binary = decodeBase64(String(value || ""));
      const bytes = new ByteArray(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      return bytes.buffer;
    }

    return Object.freeze({
      base64ToBuffer,
      canCallExtensionApi,
      isExtensionContextInvalidated,
      markExtensionContextInvalidated,
      safeRuntimeSendMessage,
      safeStorageLocalGet,
      safeStorageLocalSet,
    });
  }

  root.AgeeContentExtensionApiRuntime = Object.freeze({ createContentExtensionApiRuntime });
})(typeof globalThis !== "undefined" ? globalThis : this);
