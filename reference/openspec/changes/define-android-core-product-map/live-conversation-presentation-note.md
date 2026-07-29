# Live conversation presentation implementation

The Android overlay keeps presentation timing local to the phone. A pure
turn-scoped state separates the complete display response from the spoken
segment ledger. The user placeholder begins at session invocation. Recognition
partials replace one live entry and accent only their newest token. The
assistant placeholder begins at commit.

Hosted response text becomes visible in the collapsed assistant bubble only as
the `AudioTrack` playback head crosses the PCM ranges associated with text
segments. One Choreographer callback coalesces projection to a display frame.
Provider receipt and `audio_done` retain data and initiate drain respectively;
neither is treated as device playback completion. Expansion reads the complete
display response. Turn identity and controller generation checks reject stale
callbacks after replacement, cancellation, or barge-in.

The collapsed spoken window is a paint-time override inside `MoaRibbonView`:
the retained ribbon buffer always holds the complete reply, so Copy and the
expanded view can never take a half-spoken response, and the override is active
only while the collapsed spoken text differs from the full reply. Live state is
cleared whenever the transcript surface is removed, a turn reaches ready, or a
"(not spoken)"/"(not saved)" marker is written, so a stale live turn cannot
shadow later voiceLog writes.

The user ribbon's Copy action is also a capture disposition. During live
capture it requests commit, keeps the copy pending while provider hypotheses
settle, and writes only the authoritative final transcript to the clipboard.
After finalization, Copy remains an immediate local clipboard action. This
keeps the overlay useful for dictation into other apps without making partial
streaming text look canonical.

Acceptance is covered by `MoaLiveConversationStateTest` plus the existing audio
progress, playback-drain, transcript-log, overlay-layout, and streaming voice
controller suites. Physical-phone QA must still prove word timing against the
selected hosted voice and confirm TalkBack action order.
