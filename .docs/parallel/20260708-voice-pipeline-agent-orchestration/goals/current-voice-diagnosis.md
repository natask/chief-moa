# Goal: current-voice-diagnosis

Branch: read-only
Worktree: current checkout or assigned read-only workspace

## Goal

Inspect existing local gateway data, provider events, and source paths to
determine what evidence currently exists for "voice breaks when long text is
generated and audio is produced." Do not read `.env` files and do not mutate the
active gateway.

## Target Files And Data

Read only:

- `gateway/data/voice-turns/` if present
- `gateway/data/events/` or event substrate files if present
- `gateway/data/provider-events*` if present
- `gateway/lib/voice-providers.js`
- `gateway/lib/voice-session-server.js`
- `gateway/scripts/smoke-cascaded-voice.js`

## Acceptance Criteria

- Report what voice/provider evidence exists locally and what is missing.
- Identify recent error shapes or absence of logs without printing raw secrets.
- Name the exact additional evidence fields needed for future diagnosis.
- Do not run commands that restart or contact the active production gateway.

## Do Not Touch

No file edits. Do not print `.env` values or raw provider credentials.

