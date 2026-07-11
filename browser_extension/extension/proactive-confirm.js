(() => {
  "use strict";

  const token = location.hash.slice(1);
  const allowButton = document.getElementById("allow");
  const cancelButton = document.getElementById("cancel");
  const status = document.getElementById("status");
  let loaded = false;
  let deciding = false;

  function setText(id, value) {
    const element = document.getElementById(id);
    if (element) element.textContent = String(value ?? "");
  }

  function setStatus(message, kind = "") {
    status.textContent = message;
    status.className = kind;
  }

  function validToken(value) {
    return /^pc_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  }

  async function loadDetails() {
    if (!validToken(token)) throw new Error("This confirmation link is invalid.");
    const response = await chrome.runtime.sendMessage({ cmd: "proactiveConfirmationDetails", token });
    if (!response?.ok) throw new Error(response?.reason || "Confirmation details are unavailable.");
    const request = response.request || {};
    setText("request-url", request.url);
    setText("request-method", request.method);
    setText("request-redirect", request.redirect === "error" ? "Blocked (fetch redirect=error)" : request.redirect);
    setText("request-content-type", request.headers?.content_type);
    setText("request-authorization", request.headers?.authorization);
    setText("request-digest", request.bodyDigest);
    setText("request-body", JSON.stringify(request.body, null, 2));
    setText("request-exclusions", response.exclusions);
    setText("request-persistence", response.persistence);
    setText(
      "background-connectivity",
      `When this confirmation was created (${response.connectivityObservedAt || "time unavailable"}), separate background automation connectivity was ${response.backgroundConnectivity === "enabled" ? "ENABLED" : "DISABLED"}. Other explicit A.G. workflows can connect separately.`,
    );
    loaded = true;
    allowButton.disabled = false;
    setStatus("Nothing has been sent. Review the exact request, then choose Allow or Cancel.");
  }

  async function decide(decision) {
    if (deciding || !loaded) return;
    deciding = true;
    allowButton.disabled = true;
    cancelButton.disabled = true;
    setStatus(decision === "allow" ? "Sending exactly one disclosed request…" : "Cancelling…");
    try {
      const response = await chrome.runtime.sendMessage({
        cmd: "proactiveConfirmationDecision",
        token,
        decision,
      });
      if (!response?.ok) throw new Error(response?.reason || "The request was not sent.");
      if (decision !== "allow") {
        window.close();
        return;
      }
      setStatus(response.summary || "The text-only response was delivered to the original tab.", "success");
      cancelButton.disabled = false;
      cancelButton.textContent = "Close";
      cancelButton.dataset.closeOnly = "true";
    } catch (error) {
      setStatus(String(error?.message || error), "error");
      cancelButton.disabled = false;
      cancelButton.textContent = "Close";
      cancelButton.dataset.closeOnly = "true";
    }
  }

  allowButton.addEventListener("click", (event) => {
    if (!event.isTrusted) return;
    decide("allow");
  });

  cancelButton.addEventListener("click", (event) => {
    if (!event.isTrusted) return;
    if (cancelButton.dataset.closeOnly === "true") window.close();
    else decide("cancel");
  });

  loadDetails().catch((error) => {
    setStatus(String(error?.message || error), "error");
    cancelButton.textContent = "Close";
    cancelButton.dataset.closeOnly = "true";
  });
})();
