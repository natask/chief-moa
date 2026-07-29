(function initAgeeAssistantAudioReplay(global) {
  "use strict";

  // Retained reply audio, so turning voice on can replay a turn from its first
  // frame. Frames are 16kHz mono int16 (~32KB/s), so this caps one turn's
  // retained audio at roughly five minutes of speech.
  const FRAME_CAP = 600;

  // Frames are retained BEFORE the mute gate in the playback path: turning voice
  // on mid-reply can only start from the beginning if the frames that arrived
  // while muted were kept. Bounded per turn, so this holds one reply's audio.
  function retainFrame(state, buffer) {
    if (!state || !buffer?.byteLength) return;
    state.assistantAudioFrames ||= [];
    if (state.assistantAudioFrames.length < FRAME_CAP) state.assistantAudioFrames.push(buffer.slice(0));
  }

  function clearFrames(state) {
    if (state?.assistantAudioFrames) state.assistantAudioFrames.length = 0;
  }

  // Restart the reply from its first frame. Audio is synthesized in
  // sentence-sized chunks with no cursor into the text, so "resume where it
  // would have been" lands on an arbitrary chunk boundary; starting over is the
  // only position that means anything to the listener.
  function restart(state, { isActive, stop, currentTime, play } = {}) {
    const frames = state?.assistantAudioFrames;
    if (!frames?.length) return false;
    if (typeof isActive === "function" && !isActive(state)) return false;
    stop?.(state);
    const now = currentTime?.();
    if (!Number.isFinite(now)) return false;
    state.playbackTime = now;
    for (const frame of frames) play(state, frame);
    return true;
  }

  global.AgeeAssistantAudioReplay = Object.freeze({ FRAME_CAP, retainFrame, clearFrames, restart });
})(globalThis);
