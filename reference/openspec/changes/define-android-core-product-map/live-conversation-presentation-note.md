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

Acceptance is covered by `MoaLiveConversationStateTest` plus the existing audio
progress, playback-drain, transcript-log, overlay-layout, and streaming voice
controller suites. Physical-phone QA must still prove word timing against the
selected hosted voice and confirm TalkBack action order.
