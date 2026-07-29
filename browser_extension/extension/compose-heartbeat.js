// Compose heartbeat: an unsent typed line is work in progress, and the
// dev-reload gate has to be able to see it from the service worker.
//
// The ribbon runtime reports every compose state change (one per keystroke), so
// this throttles to a timestamp write and clears it when the box empties or
// closes. A stale timestamp must never block a deploy forever — the gate ages
// it out, and this clears it as soon as the caret leaves.
//
// Every caller must treat this file as OPTIONAL and reach it through
// `globalThis.AgeeComposeHeartbeat?.create?.(...)`. An unpacked extension
// serves fresh file CONTENTS from disk on every injection, but re-reads the
// manifest's file LIST only on a real extension reload. A newly added content
// script is therefore missing from tabs whose reload silently did not happen,
// while content.js already references it — and a hard reference throws during
// overlay setup, before the launcher's gesture listeners are attached. That
// failure looks like an overlay that paints perfectly and ignores every click.
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
