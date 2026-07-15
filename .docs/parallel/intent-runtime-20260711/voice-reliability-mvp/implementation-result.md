# Voice reliability timeline implementation result

## Candidate result

The isolated pure-model candidate is ready for an independent audit. It does
not add routes, persistence, exporters, or live behavior.

Implemented:

- exact, bounded metadata records with closed event/source vocabularies;
- server-injected tenant/release authority and endpoint-origin restrictions;
- recursive raw-content/credential rejection and accessor/prototype defenses;
- one exact session/turn/endpoint-observer join;
- endpoint process-clock epochs, server-calculated calibration uncertainty, and
  monotonic-only same-clock durations;
- projection of the existing Chief Moa voice-diagnosis payload;
- explicit `deterministic_derived` provenance for archive/diagnosis evidence so
  it is not mislabeled as a directly timed gateway observation;
- conservative playback attribution that distinguishes gateway write, endpoint
  receipt, and endpoint-observed playout without claiming human hearing; and
- attribution-time revalidation/recomputation so callers cannot forge derived
  duration or authority fields.

## Verification evidence

- `node --test test/voice-reliability-timeline.test.js`: 19/19 pass.
- The focused suite includes an actual `voiceDiagnosisPayload()` result from the
  existing gateway, not only a hand-built projection fixture.
- `MOA_SKIP_SLOW=1 node --test --test-concurrency=1 "test/**/*.test.js"`:
  281 pass, 0 fail, 1 intentional skip after the final hardening pass.
- The default parallel project gate was run twice after isolated `npm ci`.
  Each run exposed a different shared-state/timing failure that immediately
  passed alone; the serial project gate above is green and includes both tests.
- Module/test syntax checks: pass.
- `git diff --check` and no-index whitespace checks for every untracked lane
  file: pass.

## Deliberate non-goals / next integration

- No endpoint ingestion credential, replay store, route, or browser emission is
  implemented in this slice.
- No percentile/cohort query, raw-media retention, evaluator, improvement agent,
  or CI optimization is claimed.
- Gateway and browser integration must preserve realtime failure isolation and
  use a separate authenticated, bounded, write-only endpoint boundary.
- This draft schema is Chief Moa-local and is not advertised as a frozen public
  or OpenTelemetry standard.
- `resource-profile.md` fixes provisional queue/export/spool/latency gates; they
  remain unclaimed and must pass the integration fault matrix before enablement.
