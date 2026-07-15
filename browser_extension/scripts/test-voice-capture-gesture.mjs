import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import vm from "node:vm";

const root = resolve(new URL("..", import.meta.url).pathname);
const source = readFileSync(join(root, "extension", "voice-capture-gesture.js"), "utf8");
const context = { globalThis: {} };
vm.createContext(context);
vm.runInContext(source, context, { filename: "voice-capture-gesture.js" });

const gesture = context.globalThis.AgeeVoiceCaptureGesture;
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

assertEqual(tap1.count, 1, "single tap count");
assertEqual(tap2.count, 2, "double tap count");
assertEqual(tap3.count, 3, "triple tap count");
assertEqual(tapReset.count, 1, "tap window reset");

assertEqual(gesture.resolveTapAction({ tapCount: 1, listening: false, conversationActive: false }), "toggle_voice", "single tap action");
assertEqual(gesture.resolveTapAction({ tapCount: 1, listening: true, conversationActive: false }), "toggle_send", "single tap send");
assertEqual(gesture.resolveTapAction({ tapCount: 2, listening: false, conversationActive: false }), "new_voice", "double tap action");
assertEqual(gesture.resolveTapAction({ tapCount: 3, listening: false, conversationActive: false }), "open_text", "triple tap action");

const mutableAdmission = { voiceFirstEnabled: true, draftControlsEnabled: true };
const latchedAdmission = gesture.latchAdmission(mutableAdmission);
mutableAdmission.voiceFirstEnabled = false;
mutableAdmission.draftControlsEnabled = false;
assertEqual(latchedAdmission.voiceFirstEnabled, true, "voice-first admission stays latched after feature change");
assertEqual(latchedAdmission.draftControlsEnabled, true, "draft admission stays latched after capability change");
assertEqual(Object.isFrozen(latchedAdmission), true, "latched admission is immutable");
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

console.log("voice-capture-gesture ok");
