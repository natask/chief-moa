# Verification

All three record-mode lanes are implemented on `master`.

## Main-Checkout Checks

- `cd gateway && npm run check` -> passed, including `smoke-audio-notes`.
- `cd browser_extension && npm run verify` -> passed.
- `cd browser_extension && npm run smoke` -> passed.
- `cd android_app && ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew assembleDebug` -> passed.

## Subagent Checks

The gateway subagent also reported these targeted checks passed in the isolated
worktree:

- `node --check lib/audio-notes.js`
- `node --check server.js`
- `node --check scripts/smoke-audio-notes.js`
- `npm run smoke:audio-notes`

The subagent's full `npm run check` was blocked by its sandbox when an existing
localhost-listening smoke tried to bind `127.0.0.1`; the same full gateway
check passed in the main checkout after consolidation.

## Review Note

A read-only Codex adversarial review was spawned against the temporary
record-mode worktree, but it hung at stdin startup before producing findings.
It was terminated so the worktree could be removed.

## Codex Adversarial Review (completed on retry)

The stdin-hung review was retried with `< /dev/null` against master
`99d9656^..fde11be` and completed. Verdict at review time: FAIL (2 high).
Triage and fixes in 05-feedback.md; all real findings were fixed and
re-verified:

- `83f119e` fix(android): collapse path cancels record capture
  (`assembleDebug` pass, orchestrator re-run).
- `2fe60b0` feat(gateway): refuse-at-quota guard, never prunes
  (`smoke-audio-notes` pass incl. new quota step, orchestrator run).
- `2390ec7` fix(extension): record/voice capture mutex + exact 5-min cap
  (`npm run verify` + `npm run smoke` pass, orchestrator re-run).

The remaining high finding (local-mode no-token auth) is the gateway's
deliberate `MOA_MODE=local` design shared by every `/v1` route; recorded as
accepted, not a record-mode regression.

Additional evidence from earlier in the run: a live roundtrip against a
throwaway gateway instance (ephemeral port, temp DATA_DIR) returned 201 on
POST, 200 on audio GET with byte-identical content (`cmp`), listed the note,
and rejected a tokenless POST with 401.

## Remaining Gap

Phone QA against a promoted gateway was not run because live deployment and
promotion are gated by the active-app freeze. The extension's in-browser
upload against the real gateway route is the matching manual QA once the
gateway is promoted.
