const previousGesture = globalThis.AgeeVoiceCaptureGesture;
delete globalThis.AgeeVoiceCaptureGesture;
await import(`../extension/voice-capture-gesture.js?test=${Date.now()}`);
const gesture = globalThis.AgeeVoiceCaptureGesture;
if (!gesture) {
  throw new Error("voice-capture-gesture.js did not install AgeeVoiceCaptureGesture");
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

const tap1 = gesture.continueTapChain(null, { time: 100, x: 50, y: 50 });
const tap2 = gesture.continueTapChain(tap1, { time: 250, x: 58, y: 53 });
const tap3 = gesture.continueTapChain(tap2, { time: 420, x: 56, y: 51 });
const tapReset = gesture.continueTapChain(tap3, { time: 900, x: 56, y: 51 });
const tapFar = gesture.continueTapChain(tap1, { time: 110, x: 500, y: 500 });
const tapBackwards = gesture.continueTapChain(tap1, { time: 90, x: 50, y: 50 });
const tapCapped = gesture.continueTapChain({ count: 4, point: { time: 100, x: 0, y: 0 } }, { time: 101, x: 0, y: 0 });
const tapDefaults = gesture.continueTapChain({ point: {} }, null, { tapWindowMs: 1, tapSlopPx: 1 });

assertEqual(tap1.count, 1, "single tap count");
assertEqual(tap2.count, 2, "double tap count");
assertEqual(tap3.count, 3, "triple tap count");
assertEqual(tapReset.count, 1, "tap window reset");
assertEqual(tapFar.count, 1, "tap slop reset");
assertEqual(tapBackwards.count, 1, "backwards time reset");
assertEqual(tapCapped.count, 4, "tap count cap");
assertEqual(tapDefaults.count, 1, "missing point defaults");

assertEqual(gesture.resolveTapAction({ tapCount: 1, listening: false, conversationActive: false }), "toggle_voice", "single tap action");
assertEqual(gesture.resolveTapAction({ tapCount: 1, listening: true, conversationActive: false }), "toggle_send", "single tap send");
assertEqual(gesture.resolveTapAction({ tapCount: 2, listening: false, conversationActive: false }), "new_voice", "double tap action");
assertEqual(gesture.resolveTapAction({ tapCount: 3, listening: false, conversationActive: false }), "open_text", "triple tap action");
assertEqual(gesture.resolveTapAction({ tapCount: 4, listening: false, conversationActive: false }), "noop", "overflow tap action");
assertEqual(gesture.resolveTapAction({ tapCount: 1, listening: false, conversationActive: true }), "toggle_send", "active conversation sends");
assertEqual(gesture.resolveTapAction({ tapCount: 0, listening: false, conversationActive: false }), "toggle_voice", "missing count defaults");

assertEqual(
  gesture.resolveVoiceFirstTransition({ tapCount: 1, capturing: false }),
  "start_current",
  "single starts current-thread capture"
);
assertEqual(
  gesture.resolveVoiceFirstTransition({ tapCount: 1, capturing: true, captureOrigin: "single" }),
  "commit_current",
  "single sends active current-thread capture"
);
assertEqual(
  gesture.resolveVoiceFirstTransition({ tapCount: 1, capturing: true, captureOrigin: "double" }),
  "noop",
  "single cannot send a fresh-thread capture"
);
assertEqual(
  gesture.resolveVoiceFirstTransition({ tapCount: 2, capturing: false }),
  "start_new",
  "double starts fresh-thread capture"
);
assertEqual(
  gesture.resolveVoiceFirstTransition({ tapCount: 2, capturing: true, captureOrigin: "double" }),
  "commit_new",
  "second double sends its fresh-thread capture"
);
assertEqual(
  gesture.resolveVoiceFirstTransition({ tapCount: 2, capturing: true, captureOrigin: "single" }),
  "cancel_then_start_new",
  "double cancels a single-started capture before starting fresh"
);
assertEqual(
  gesture.resolveVoiceFirstTransition({ tapCount: 3, capturing: true, captureOrigin: "double" }),
  "cancel_then_open_chat",
  "triple opens chat without sending active capture"
);
assertEqual(
  gesture.resolveVoiceFirstTransition({ tapCount: 4, capturing: true, captureOrigin: "single" }),
  "noop",
  "fourth click stays inert"
);

const mutableAdmission = { voiceFirstEnabled: true, draftControlsEnabled: true };
const latchedAdmission = gesture.latchAdmission(mutableAdmission);
mutableAdmission.voiceFirstEnabled = false;
mutableAdmission.draftControlsEnabled = false;
assertEqual(latchedAdmission.voiceFirstEnabled, true, "voice-first admission stays latched after feature change");
assertEqual(latchedAdmission.draftControlsEnabled, true, "draft admission stays latched after capability change");
assertEqual(Object.isFrozen(latchedAdmission), true, "latched admission is immutable");
assertEqual(gesture.latchAdmission().voiceFirstEnabled, false, "missing admission defaults off");
assertEqual(
  gesture.latchAdmission({ voiceFirstEnabled: false, draftControlsEnabled: true }).draftControlsEnabled,
  false,
  "draft controls cannot outlive voice-first admission"
);

assertEqual(
  gesture.resolveDraftHoldAction({
    start: { x: 100, y: 100 },
    end: { x: 100, y: 100 },
    pointerCancel: false,
    draftControlsEnabled: true,
  }),
  "commit_turn",
  "still hold release"
);
assertEqual(
  gesture.resolveDraftHoldAction({
    start: { x: 100, y: 100 },
    end: { x: 20, y: 102 },
    pointerCancel: false,
    draftControlsEnabled: true,
  }),
  "pause_capture",
  "left drag pauses"
);
assertEqual(
  gesture.resolveDraftHoldAction({
    start: { x: 100, y: 100 },
    end: { x: 102, y: 20 },
    pointerCancel: false,
    draftControlsEnabled: true,
  }),
  "park_turn",
  "up drag parks"
);
assertEqual(
  gesture.resolveDraftHoldAction({
    start: { x: 100, y: 100 },
    end: { x: 98, y: 190 },
    pointerCancel: false,
    draftControlsEnabled: true,
  }),
  "discard_turn",
  "down drag discards"
);
assertEqual(
  gesture.resolveDraftHoldAction({
    start: { x: 100, y: 100 },
    end: { x: 170, y: 170 },
    pointerCancel: false,
    draftControlsEnabled: true,
  }),
  "commit_turn",
  "ambiguous diagonal stays unlatched"
);
assertEqual(
  gesture.resolveDraftHoldAction({
    start: { x: 100, y: 100 },
    end: { x: 20, y: 36 },
    pointerCancel: false,
    draftControlsEnabled: true,
  }),
  "pause_capture",
  "left needs 1.25x dominance"
);
assertEqual(
  gesture.resolveDraftHoldAction({
    start: { x: 100, y: 100 },
    end: { x: 20, y: 100 },
    pointerCancel: true,
    draftControlsEnabled: true,
  }),
  "discard_turn",
  "pointer cancel discards"
);
assertEqual(
  gesture.resolveDraftHoldAction({
    start: { x: 100, y: 100 },
    end: { x: 20, y: 100 },
    pointerCancel: false,
    draftControlsEnabled: false,
  }),
  "commit_turn",
  "unsupported draft controls fall back to commit"
);

assertEqual(gesture.resolveHoldDirection(null, null), "release", "missing hold points release");
assertEqual(gesture.resolveHoldDirection({ x: 0, y: 0 }, { x: 100, y: 0 }), "release", "right drag is unbound");
assertEqual(gesture.resolveHoldDirection({ x: 0, y: 0 }, { x: -100, y: 0 }), "left", "left drag resolves");
assertEqual(gesture.resolveHoldDirection({ x: 0, y: 0 }, { x: 0, y: -100 }), "up", "up drag resolves");
assertEqual(gesture.resolveHoldDirection({ x: 0, y: 0 }, { x: 0, y: 100 }), "down", "down drag resolves");
assertEqual(
  gesture.resolveHoldDirection({ x: 0, y: 0 }, { x: 5, y: 5 }, { directionalDeadzonePx: 4, directionalBias: 2 }),
  "release",
  "ambiguous custom threshold releases"
);

if (previousGesture === undefined) delete globalThis.AgeeVoiceCaptureGesture;
else globalThis.AgeeVoiceCaptureGesture = previousGesture;

console.log("voice-capture-gesture ok");
