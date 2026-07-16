(function installContentProactiveControllerRuntime(global) {
  "use strict";

  const root = global || globalThis;

  function createContentProactiveControllerRuntime(options) {
    const documentRef = options.document;
    const windowRef = options.window;
    const sendMessage = options.sendMessage;
    const proactiveHelper = options.proactiveHelper;
    const proactiveSensitivity = options.proactiveSensitivity;
    const collectProactiveSignals = options.collectProactiveSignals;
    const setIndicator = options.setIndicator;
    const renderNotice = options.renderNotice;
    const renderCard = options.renderCard;
    const hideCard = options.hideCard;
    const newCueId = options.newCueId;
    const createCue = options.createCue;
    const updateCue = options.updateCue;
    const showCueError = options.showCueError;
    const setTimeoutFn = options.setTimeout;
    const clearTimeoutFn = options.clearTimeout;
    const setIntervalFn = options.setInterval;
    const clearIntervalFn = options.clearInterval;
    const now = options.now;
    const visibleDwellMs = options.visibleDwellMs;
    const confirmationTimeoutMs = options.confirmationTimeoutMs;
    let proactiveGrant = null;
    let sampleTimer = null;
    let expiryTimer = null;
    let statusTimer = null;
    let resumeHandler = null;
    const pendingConfirmations = new Map();

    function hasProactiveGrant() {
      return Boolean(proactiveGrant);
    }

    function hasPendingProactiveConfirmation(cueId) {
      return pendingConfirmations.has(cueId);
    }

    function shouldHandleProactiveRevocation(grantId) {
      return !proactiveGrant || !grantId || proactiveGrant.grantId === grantId;
    }

    function clearResumeListeners() {
      if (!resumeHandler) return;
      documentRef.removeEventListener("visibilitychange", resumeHandler, true);
      windowRef.removeEventListener("focus", resumeHandler, true);
      resumeHandler = null;
    }

    function armResume() {
      clearResumeListeners();
      if (!proactiveGrant) return;
      resumeHandler = () => {
        clearResumeListeners();
        if (!proactiveGrant) return;
        if (documentRef.visibilityState === "visible" && documentRef.hasFocus()) {
          sampleTimer = setTimeoutFn(sampleProactivePage, 0);
        } else {
          armResume();
        }
      };
      documentRef.addEventListener("visibilitychange", resumeHandler, { capture: true, once: true });
      windowRef.addEventListener("focus", resumeHandler, { capture: true, once: true });
    }

    function clearTimers() {
      if (sampleTimer) clearTimeoutFn(sampleTimer);
      if (expiryTimer) clearTimeoutFn(expiryTimer);
      if (statusTimer) clearIntervalFn(statusTimer);
      sampleTimer = null;
      expiryTimer = null;
      statusTimer = null;
      clearResumeListeners();
    }

    async function startProactiveGrant() {
      const sensitivity = proactiveSensitivity();
      if (sensitivity.suppressed) {
        setIndicator(false);
        renderNotice("Local suggestions are off here", `This page is suppressed (${sensitivity.reason}). There is no override.`);
        return;
      }
      const response = await sendMessage({ cmd: "proactiveGrantStart" }).catch((error) => ({
        ok: false,
        reason: String(error?.message || error),
      }));
      if (!response?.ok) {
        const reason = response?.suppressed
          ? `This page is suppressed (${response.reason}).`
          : `Could not start local suggestions (${response?.reason || "unavailable"}).`;
        renderNotice("Local suggestions are off", reason);
        return;
      }
      proactiveGrant = {
        grantId: response.grantId,
        expiresAt: Number(response.expiresAt),
        card: null,
      };
      setIndicator(true);
      renderNotice(
        "Local suggestions are on",
        "Watching only structural counts in this visible tab. Nothing from this local observation has been sent. Page text, values, URL, title, screenshots, and history stay out of the observation.",
      );
      sampleTimer = setTimeoutFn(sampleProactivePage, visibleDwellMs);
      expiryTimer = setTimeoutFn(() => stopProactiveGrant("expired"), Math.max(0, proactiveGrant.expiresAt - now()));
      statusTimer = setIntervalFn(checkProactiveGrantStatus, 3000);
    }

    async function sampleProactivePage() {
      sampleTimer = null;
      if (!proactiveGrant) return;
      if (documentRef.visibilityState !== "visible" || !documentRef.hasFocus()) {
        armResume();
        return;
      }
      const sensitivity = proactiveSensitivity();
      if (sensitivity.suppressed) {
        stopProactiveGrant("sensitive", { showNotice: false });
        renderNotice("Local suggestions stopped", `This page became sensitive (${sensitivity.reason}).`);
        return;
      }
      const signals = collectProactiveSignals();
      const card = proactiveHelper()?.classifyStructuralPage(signals);
      if (!signals || !card) {
        stopProactiveGrant("no_suggestion", { showNotice: false });
        renderNotice(
          "Local observation stopped",
          "No local suggestion matched this page. Nothing from this local observation was sent.",
        );
        return;
      }
      const response = await sendMessage({
        cmd: "proactiveSignal",
        grantId: proactiveGrant.grantId,
        signals,
      }).catch(() => null);
      if (!response?.ok || !proactiveGrant) {
        stopProactiveGrant(response?.reason || "revoked", { notify: false, showNotice: false });
        return;
      }
      proactiveGrant.card = card;
      renderCard(card);
    }

    async function checkProactiveGrantStatus() {
      if (!proactiveGrant) return;
      const response = await sendMessage({
        cmd: "proactiveGrantStatus",
        grantId: proactiveGrant.grantId,
      }).catch(() => null);
      if (!response?.ok) stopProactiveGrant(response?.reason || "revoked", { notify: false, showNotice: false });
    }

    function stopProactiveGrant(reason = "manual_stop", stopOptions = {}) {
      const grant = proactiveGrant;
      proactiveGrant = null;
      clearTimers();
      setIndicator(false);
      if (stopOptions.showNotice !== true) hideCard();
      if (grant && stopOptions.notify !== false) {
        sendMessage({ cmd: "proactiveGrantStop", grantId: grant.grantId, reason }).catch(() => {});
      }
    }

    async function acceptProactiveCard(card, button) {
      if (!proactiveGrant || button.disabled) return;
      const sensitivity = proactiveSensitivity();
      if (sensitivity.suppressed) {
        stopProactiveGrant("sensitive_before_accept");
        renderNotice("Suggestion not sent", `This page is now suppressed (${sensitivity.reason}).`);
        return;
      }
      button.disabled = true;
      const grantId = proactiveGrant.grantId;
      const cueId = newCueId();
      createCue(cueId, card.title, { presentation: "card" });
      updateCue(cueId, "Opening the extension-owned confirmation…", "running");
      trackProactiveConfirmationCue(cueId);
      const response = await sendMessage({
        cmd: "proactiveConfirmationOpen",
        grantId,
        kind: card.kind,
        cueId,
      }).catch((error) => ({ ok: false, reason: String(error?.message || error) }));
      if (!response?.ok) {
        clearProactiveConfirmationCue(cueId);
        button.disabled = false;
        showCueError(cueId, response?.reason || "Could not open the extension-owned confirmation.");
        return;
      }
      clearTimers();
      proactiveGrant = null;
      setIndicator(false);
      hideCard();
      if (pendingConfirmations.has(cueId)) {
        updateCue(cueId, "Review the extension-owned confirmation…", "running");
      }
    }

    function clearProactiveConfirmationCue(cueId) {
      const record = pendingConfirmations.get(cueId);
      if (record?.statusTimer) clearIntervalFn(record.statusTimer);
      if (record?.expiryTimer) clearTimeoutFn(record.expiryTimer);
      pendingConfirmations.delete(cueId);
    }

    function clearAllProactiveConfirmationCues() {
      for (const cueId of [...pendingConfirmations.keys()]) clearProactiveConfirmationCue(cueId);
    }

    function trackProactiveConfirmationCue(cueId) {
      clearProactiveConfirmationCue(cueId);
      const record = { statusTimer: null, expiryTimer: null, checking: false };
      const check = async () => {
        if (record.checking || !pendingConfirmations.has(cueId)) return;
        record.checking = true;
        try {
          const response = await sendMessage({ cmd: "proactiveConfirmationStatus", cueId }).catch(() => null);
          if (!response?.ok && pendingConfirmations.has(cueId)) {
            clearProactiveConfirmationCue(cueId);
            showCueError(cueId, "The confirmation expired, closed, or was cleared when the extension restarted.");
          }
        } finally {
          record.checking = false;
        }
      };
      record.statusTimer = setIntervalFn(check, 3000);
      record.expiryTimer = setTimeoutFn(() => {
        if (!pendingConfirmations.has(cueId)) return;
        clearProactiveConfirmationCue(cueId);
        showCueError(cueId, "The confirmation expired without sending anything.");
      }, confirmationTimeoutMs);
      pendingConfirmations.set(cueId, record);
    }

    return Object.freeze({
      acceptProactiveCard,
      checkProactiveGrantStatus,
      clearAllProactiveConfirmationCues,
      clearProactiveConfirmationCue,
      hasPendingProactiveConfirmation,
      hasProactiveGrant,
      sampleProactivePage,
      shouldHandleProactiveRevocation,
      startProactiveGrant,
      stopProactiveGrant,
      trackProactiveConfirmationCue,
    });
  }

  root.AgeeContentProactiveControllerRuntime = Object.freeze({ createContentProactiveControllerRuntime });
})(typeof globalThis !== "undefined" ? globalThis : this);
