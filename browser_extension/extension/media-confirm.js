(() => {
  "use strict";
  const id = location.hash.slice(1);
  const allow = document.getElementById("allow");
  const cancel = document.getElementById("cancel");
  const status = document.getElementById("status");
  let digest = "";
  let ready = false;
  let deciding = false;

  function text(name, value) {
    const element = document.getElementById(name);
    if (element) element.textContent = String(value ?? "—");
  }

  async function load() {
    if (!/^mc_[0-9a-f-]{36}$/i.test(id)) throw new Error("This media confirmation is invalid.");
    const response = await chrome.runtime.sendMessage({ cmd: "mediaConfirmationDetails", id });
    if (!response?.ok) throw new Error(response?.reason || "This media confirmation is unavailable.");
    digest = response.digest;
    const details = response.details || {};
    text("operation", details.operation);
    text("label", details.label || "—");
    text("query", details.query || "—");
    text("title", details.title || "—");
    text("channel", details.channel || "—");
    text("video-id", details.video_id);
    text("position", `${details.position_seconds}s`);
    text("note", details.note || "No note");
    text("digest", digest);
    text("disclosure", details.disclosure);
    ready = true;
    allow.disabled = false;
    status.textContent = "Nothing has changed yet. Choose Allow or Cancel.";
  }

  async function decide(decision) {
    if (!ready || deciding) return;
    deciding = true;
    allow.disabled = true;
    cancel.disabled = true;
    const response = await chrome.runtime.sendMessage({ cmd: "mediaConfirmationDecision", id, digest, decision });
    if (!response?.ok) throw new Error(response?.reason || "The decision was rejected.");
    window.close();
  }

  allow.addEventListener("click", (event) => { if (event.isTrusted) decide("allow").catch(showError); });
  cancel.addEventListener("click", (event) => { if (event.isTrusted) decide("cancel").catch(showError); });
  function showError(error) {
    status.textContent = String(error?.message || error);
    status.className = "error";
    cancel.disabled = false;
    cancel.textContent = "Close";
    cancel.onclick = (event) => { if (event.isTrusted) window.close(); };
  }
  load().catch(showError);
})();
