(function installContentNoteControllerRuntime(global) {
  "use strict";

  const root = global || globalThis;

  function createContentNoteControllerRuntime(options) {
    const sendMessage = options.sendMessage;
    const isExtensionContextInvalidated = options.isExtensionContextInvalidated;
    const openSurface = options.openSurface;
    const isVoiceActive = options.isVoiceActive;
    const setCaptureState = options.setCaptureState;
    const newCueId = options.newCueId;
    const materializeCue = options.materializeCue;
    const updateCue = options.updateCue;
    const reactLauncher = options.reactLauncher;
    const now = options.now;
    let recordActive = false;
    let recordPending = false;
    let recordStartedAt = 0;
    let videoNoteActive = false;
    let videoNotePending = false;

    function isRecordActive() {
      return recordActive;
    }

    function isVideoNoteActive() {
      return videoNoteActive;
    }

    function showCue(label, text, kind = "error", statusText = "") {
      const cueId = newCueId();
      materializeCue(cueId, label, statusText);
      if (text) updateCue(cueId, text, kind);
      return cueId;
    }

    function setRecordState(active) {
      recordActive = active;
      setCaptureState("audio", active);
    }

    function setVideoNoteState(active) {
      videoNoteActive = active;
      setCaptureState("video", active);
    }

    function toggleRecordMode() {
      if (recordPending) return;
      openSurface();
      if (recordActive) return stopRecordMode();
      if (isVoiceActive()) {
        showCue("Audio note", "Voice is active. Stop voice before recording a note.");
        return;
      }
      return startRecordMode();
    }

    async function startRecordMode() {
      recordPending = true;
      try {
        const response = await sendMessage({ cmd: "recordSessionStart" });
        recordPending = false;
        if (!response && isExtensionContextInvalidated()) return;
        if (!response?.ok) {
          showCue("Audio note", response?.error || "Could not start recording.");
          return;
        }
        recordStartedAt = now();
        setRecordState(true);
      } catch (error) {
        recordPending = false;
        showCue("Audio note", String(error?.message || error));
      }
    }

    async function stopRecordMode() {
      recordPending = true;
      const startedAt = recordStartedAt;
      setRecordState(false);
      const cueId = showCue("Audio note", "", "running", "storing...");
      try {
        const response = await sendMessage({ cmd: "recordSessionStop" });
        recordPending = false;
        if (!response && isExtensionContextInvalidated()) return;
        if (response?.stored) {
          const durationMs = Number(response.note?.duration_ms ?? response.durationMs)
            || (startedAt ? now() - startedAt : 0);
          const seconds = Math.max(1, Math.round(durationMs / 1000));
          updateCue(cueId, `note stored (${seconds}s)`, "done");
          reactLauncher("done");
          return;
        }
        updateCue(cueId, response?.error || "Audio note upload failed.", "error");
        reactLauncher("error");
      } catch (error) {
        recordPending = false;
        updateCue(cueId, String(error?.message || error), "error");
        reactLauncher("error");
      }
    }

    function toggleVideoNoteMode() {
      if (videoNotePending || recordPending) return;
      openSurface();
      if (videoNoteActive) return stopVideoNoteMode();
      if (recordActive) {
        showCue("Video note", "An audio note is recording. Finish it before starting a video note.");
        return;
      }
      if (isVoiceActive()) {
        showCue("Video note", "Voice is active. Stop voice before recording a video note.");
        return;
      }
      return startVideoNoteMode();
    }

    async function startVideoNoteMode() {
      videoNotePending = true;
      try {
        const response = await sendMessage({ cmd: "videoSessionStart" });
        videoNotePending = false;
        if (!response && isExtensionContextInvalidated()) return;
        if (!response?.ok) {
          showCue("Video note", response?.error || "Could not start the video note.");
          return;
        }
        setVideoNoteState(true);
      } catch (error) {
        videoNotePending = false;
        showCue("Video note", String(error?.message || error));
      }
    }

    async function stopVideoNoteMode() {
      videoNotePending = true;
      setVideoNoteState(false);
      const cueId = showCue("Video note", "", "running", "storing...");
      try {
        const response = await sendMessage({ cmd: "videoSessionStop", cueId });
        videoNotePending = false;
        if (!response && isExtensionContextInvalidated()) return;
        if (response?.stored) {
          updateCue(cueId, "video stored — sending to A.G. ...", "running");
          return;
        }
        updateCue(cueId, response?.error || "Video note upload failed.", "error");
        reactLauncher("error");
      } catch (error) {
        videoNotePending = false;
        updateCue(cueId, String(error?.message || error), "error");
        reactLauncher("error");
      }
    }

    return Object.freeze({
      isRecordActive,
      isVideoNoteActive,
      startRecordMode,
      startVideoNoteMode,
      stopRecordMode,
      stopVideoNoteMode,
      toggleRecordMode,
      toggleVideoNoteMode,
    });
  }

  root.AgeeContentNoteControllerRuntime = Object.freeze({ createContentNoteControllerRuntime });
})(typeof globalThis !== "undefined" ? globalThis : this);
