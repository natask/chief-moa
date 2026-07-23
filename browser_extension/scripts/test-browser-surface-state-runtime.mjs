import assert from "node:assert/strict";

import {
  findActiveDictationSession,
  findListeningDictationSession,
  persistedDictationBlocksStart,
  planDictationRestartReconciliation,
  planGlobalDictationToggle,
  sanitizeBrowserAgentOwner,
  transitionVoiceOwner,
} from "../extension/browser-surface-state-runtime.js";

const listening = {
  id: "voice-a",
  tabId: 11,
  transcriptionOnly: true,
  committed: false,
  closed: false,
};
const committed = {
  id: "voice-b",
  tabId: 12,
  transcriptionOnly: true,
  committed: true,
  closed: false,
};
const ordinaryVoice = {
  id: "voice-c",
  tabId: 13,
  transcriptionOnly: false,
  committed: false,
  closed: false,
};

assert.equal(
  findListeningDictationSession([committed, ordinaryVoice, listening]),
  listening,
  "the worker must address the one still-listening dictation session",
);
assert.equal(
  findListeningDictationSession([committed, ordinaryVoice]),
  null,
  "a committed dictation must not be toggled a second time",
);
assert.equal(
  findActiveDictationSession([committed, ordinaryVoice]),
  committed,
  "a processing dictation remains the single active capture until its terminal event",
);
assert.deepEqual(
  planGlobalDictationToggle([ordinaryVoice, listening]),
  {
    action: "commit",
    voiceSessionId: "voice-a",
    ownerTabId: 11,
    turnId: undefined,
  },
  "a global invocation from any other tab commits the worker-owned capture",
);
assert.deepEqual(
  planGlobalDictationToggle([ordinaryVoice, committed]),
  { action: "wait", voiceSessionId: "voice-b", ownerTabId: 12 },
  "another invocation cannot start a second capture while transcription is processing",
);
assert.deepEqual(planGlobalDictationToggle([ordinaryVoice]), { action: "start" });
const pendingLease = {
  activity: "dictation",
  lease_id: "lease-a",
  status: "starting",
  updated_at: "2026-07-23T00:00:00.000Z",
};
assert.equal(
  persistedDictationBlocksStart(pendingLease),
  true,
  "the persisted start lease blocks a fast second invocation before a runtime session exists",
);
assert.deepEqual(
  planDictationRestartReconciliation({
    owner: pendingLease,
    hasRuntimeSession: false,
    now: Date.parse("2026-07-23T00:00:01.000Z"),
  }),
  { action: "wait" },
);
assert.deepEqual(
  planDictationRestartReconciliation({
    owner: { ...pendingLease, status: "listening", voice_session_id: "orphan" },
    hasRuntimeSession: false,
    offscreenCaptureId: "orphan",
    now: Date.parse("2026-07-23T00:00:01.000Z"),
  }),
  { action: "reconcile_error", stopCaptureId: "orphan" },
  "worker restart reconciles the orphan offscreen capture before another start",
);

assert.deepEqual(
  sanitizeBrowserAgentOwner({
    tab_id: 11,
    page_url: "https://private.example/path",
    page_title: "Private page",
    last_result: "literal private transcript",
    status: "listening",
  }),
  { tab_id: 11, status: "listening" },
  "shared owner state must not persist page identity",
);

const owner = {
  tab_id: 11,
  voice_session_id: "voice-a",
  activity: "dictation",
  status: "listening",
  transition_sequence: 1,
};
assert.deepEqual(
  transitionVoiceOwner(owner, "voice-a", {
    status: "processing",
    last_result: "literal words must be dropped",
    transition_sequence: 2,
  }),
  {
    tab_id: 11,
    voice_session_id: "voice-a",
    activity: "dictation",
    status: "processing",
    transition_sequence: 2,
  },
);
assert.equal(
  transitionVoiceOwner(owner, "voice-other", { status: "completed", transition_sequence: 2 }),
  null,
  "late events from an old voice session must not overwrite the active owner",
);
const processingOwner = transitionVoiceOwner(owner, "voice-a", {
  status: "processing",
  transition_sequence: 2,
});
const detached = transitionVoiceOwner(owner, "voice-a", {
  tab_id: null,
  transition_sequence: 2,
});
assert.equal(detached.tab_id, null, "closing tab A detaches its view without terminalizing dictation");
assert.equal(
  planGlobalDictationToggle([{ ...listening, tabId: null }]).action,
  "commit",
  "tab B can commit the worker-owned session after tab A closes",
);
const respondingOwner = transitionVoiceOwner(processingOwner, "voice-a", {
  status: "responding",
  transition_sequence: 3,
});
const respondingDetached = transitionVoiceOwner(respondingOwner, "voice-a", {
  tab_id: null,
  transition_sequence: 4,
});
assert.equal(respondingDetached.status, "responding");
assert.equal(respondingDetached.tab_id, null);
const noSpeech = transitionVoiceOwner(owner, "voice-a", {
  status: "no_speech",
  transition_sequence: 2,
});
assert.equal(noSpeech.status, "no_speech");
const errored = transitionVoiceOwner(owner, "voice-a", {
  status: "error",
  transition_sequence: 2,
});
assert.equal(errored.status, "error", "the error terminal transition is reachable");
assert.equal(
  transitionVoiceOwner(processingOwner, "voice-a", {
    status: "listening",
    transition_sequence: 3,
  }),
  null,
  "a later asynchronous write cannot regress processing back to listening",
);
assert.equal(
  transitionVoiceOwner(processingOwner, "voice-a", {
    status: "error",
    transition_sequence: 2,
  }),
  null,
  "a stale same-sequence terminal write cannot overwrite newer state",
);
assert.equal(
  transitionVoiceOwner(
    transitionVoiceOwner(processingOwner, "voice-a", {
      status: "completed",
      transition_sequence: 3,
    }),
    "voice-a",
    { status: "responding", transition_sequence: 4 },
  ),
  null,
  "terminal state cannot be resurrected by a late response",
);

console.log("browser surface state runtime tests passed");
