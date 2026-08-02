# Android Capture Controls Evidence

This implementation unit covers the capturing and paused rows of tasks 4.1 and
4.2. The mascot remains the only Send/handoff target. Two separate, tightly
bounded overlay windows expose Pause/Resume and Cancel beside it; coordinates
outside those painted windows remain owned by the underlying app.

Android reads `voice_stream.provider.voice_drafts_v1.supported` from `/health`
and opens a draft session only while that URL-bound advertisement is fresh. A
gateway without the capability keeps the prior live voice path and renders no
draft controls. A supported session must then return matching session, branch,
turn, draft ID, and increasing revision evidence before controls appear.

Pause, Resume, Discard, and Send carry that exact authority plus an idempotency
key. Audio captured while the socket is opening stays in Android's bounded local
queue and cannot cross the socket before exact draft `session_ready` authority;
the gateway's draft bridge then stores PCM without provider or canonical-turn
admission until the authority-bearing `commit_turn`. Discard sends no commit.

Focused JVM coverage verifies deployed health parsing, old-gateway hiding,
ready gating, and the single Pause/Resume label. Physical-phone verification of
TalkBack traversal, control placement at screen edges, touch pass-through, and
real pause/resume audio continuity remains required under task 8.4. Thinking
and speaking controls remain task 4.3 and are not claimed by this unit.
