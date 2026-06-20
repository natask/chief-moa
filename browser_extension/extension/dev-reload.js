// Dev auto-reload — unpacked installs only.
//
// `npm run dev` (in browser_extension/) serves a version at
// http://localhost:7777/__agee-dev/version that bumps whenever a file under
// extension/ changes. We poll it from the service worker; on a change we reload
// the active tab and then the whole extension, so your edits show up in your
// real Chrome with no manual reload.
//
// Silent no-op in two cases: packaged builds (they carry an update_url), and
// whenever the dev server is not running (fetch just fails quietly).

const IS_DEV = !("update_url" in chrome.runtime.getManifest());
const DEV_VERSION_URL = "http://localhost:7777/__agee-dev/version";
const POLL_MS = 1000;

if (IS_DEV) {
  let knownVersion = null;

  const poll = async () => {
    let info;
    try {
      const res = await fetch(DEV_VERSION_URL, { cache: "no-store" });
      if (!res.ok) return;
      info = await res.json();
    } catch {
      return; // dev server not running — stay quiet
    }
    if (knownVersion === null) {
      knownVersion = info.version; // first sighting: remember, do not reload
      return;
    }
    if (info.version === knownVersion) return;

    knownVersion = info.version;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) await chrome.tabs.reload(tab.id); // re-inject the content script
    } catch {}
    chrome.runtime.reload(); // pick up manifest / background / icon changes
  };

  // A 1s fetch loop also keeps the worker awake while you are iterating.
  setInterval(poll, POLL_MS);
  poll();
}
