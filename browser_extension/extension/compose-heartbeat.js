// Compose heartbeat: an unsent typed line is work in progress, and the
// dev-reload gate has to be able to see it from the service worker.
//
// The ribbon runtime reports every compose state change (one per keystroke), so
// this throttles to a timestamp write and clears it when the box empties or
// closes. A stale timestamp must never block a deploy forever — the gate ages
// it out, and this clears it as soon as the caret leaves.
(function initAgeeComposeHeartbeat(global) {
  "use strict";

  const WRITE_EVERY_MS = 5000;

  function create({ write, now = () => Date.now(), key = "ageeComposingAt" } = {}) {
    let lastWriteAt = 0;
    return function report({ composing, hasText } = {}) {
      if (composing && hasText) {
        const at = now();
        if (at - lastWriteAt < WRITE_EVERY_MS) return;
        lastWriteAt = at;
        write?.({ [key]: at });
        return;
      }
      if (!lastWriteAt) return;
      lastWriteAt = 0;
      write?.({ [key]: 0 });
    };
  }

  global.AgeeComposeHeartbeat = Object.freeze({ WRITE_EVERY_MS, create });
})(globalThis);
