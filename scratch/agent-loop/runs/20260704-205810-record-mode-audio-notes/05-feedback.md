# Feedback

## Codex adversarial review (T0071) — completed against master 99d9656^..fde11be

Verdict FAIL (2 high) at review time; triage and resolution:

- High, extension record/voice race (real): in the async gap around the
  voice session-ticket fetch, a record session could start and the delayed
  voice start would steal the mic, routing note audio into the STT socket.
  FIXED: background capture mutex/pending state + post-fetch recheck +
  content-side refusal while a voice turn is live.
- High, local-mode auth on /v1/audio-notes (accepted, not a regression):
  with no MOA_GATEWAY_TOKEN in MOA_MODE=local, authorized() admits requests.
  This is the gateway's deliberate local-dev design and applies identically
  to every /v1 route (chat, voice turns, sessions). Remote modes require the
  token at boot. Recorded as an accepted architecture decision; any change
  belongs to a gateway-wide auth hardening change, not record mode.
- Medium, gateway disk growth (fixed in the refuse direction): new
  AUDIO_NOTES_MAX_TOTAL_BYTES quota (default 2 GiB) returns 507 for new
  notes at cap and never prunes stored notes, because auto-deleting notes
  would violate the spoken-input-is-never-lost rule (2fe60b0).
- Medium, Android failed-upload local files unbounded (follow-up ticket):
  retention/retry policy for kept-local notes needs a product decision
  consistent with never losing spoken input; logged in the feedback ledger.
- Medium, Android collapse path kept capturing (real): FIXED, collapse now
  cancels capture (83f119e).
- Low, extension cap overshoot by one chunk (real): FIXED with exact-room
  append in the record fix commit.

Checked clean by the review: path traversal via note id, gateway byte
fidelity, no STT/LLM/TTS on the gateway notes path, both clients' normal
upload paths.

## Operational feedback

- Background `codex exec` jobs need `< /dev/null`; without it the first
  review attempt hung reading stdin.
- A concurrent master-consolidation agent deleted record-mode worktrees
  three times mid-run and cherry-picked lane commits onto master itself.
  Committing each lane as soon as it verifies is the effective defense;
  uncommitted work in shared-repo worktrees is not safe while that loop is
  active.

## Deployment

No live promotion was performed. The live gateway, extension reload, and
Android OTA publish stay gated on the user explicitly saying
promote/apply/deploy, with the backup + restore check first.
