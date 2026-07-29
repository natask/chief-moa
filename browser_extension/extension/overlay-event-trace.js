(function initAgeeOverlayEventTrace(global) {
  "use strict";

  // A timestamped record of what the overlay DID while a video note was
  // recording: the gestures the user made and the state the app moved through.
  //
  // Frames alone show that a box appeared; they do not show whether it appeared
  // because a partial transcript landed, because the user clicked, or because a
  // linger timer fired. Pairing the recording with this track is what lets the
  // model answer "why does it look like that" instead of guessing from pixels.
  //
  // Recording only runs while a video note is open, so an idle overlay costs
  // nothing. Entries are capped and carry no page content — overlay state and
  // gesture names only, never the text of a turn or anything from the page.

  const MAX_ENTRIES = 600;

  function createTrace({ now = () => Date.now() } = {}) {
    let startedAt = 0;
    let entries = [];
    let running = false;

    function start() {
      startedAt = now();
      entries = [];
      running = true;
      return startedAt;
    }

    // `at` is milliseconds from the first frame, so an entry lines up with a
    // position in the recording without depending on wall-clock skew.
    function mark(kind, name, detail) {
      if (!running || entries.length >= MAX_ENTRIES) return;
      const entry = { at: Math.max(0, now() - startedAt), kind, name: String(name || "") };
      if (detail && typeof detail === "object") {
        // Numbers and booleans only. Anything else risks carrying turn text or
        // page content into a payload the user did not choose to share.
        const safe = {};
        for (const [key, value] of Object.entries(detail)) {
          if (typeof value === "number" || typeof value === "boolean") safe[key] = value;
        }
        if (Object.keys(safe).length) entry.detail = safe;
      }
      entries.push(entry);
    }

    function stop() {
      running = false;
      const track = { started_at: startedAt, duration_ms: Math.max(0, now() - startedAt), entries };
      entries = [];
      return track;
    }

    return {
      start,
      stop,
      isRunning: () => running,
      count: () => entries.length,
      // The two things worth separating when reading the track back: what the
      // person did, and what the app did in response.
      gesture: (name, detail) => mark("gesture", name, detail),
      state: (name, detail) => mark("state", name, detail),
      snapshot: () => entries.slice(),
    };
  }

  global.AgeeOverlayEventTrace = Object.freeze({ MAX_ENTRIES, createTrace });
})(globalThis);
