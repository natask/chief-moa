# Browser voice sampler audit

## Claims ledger

| Implementer claim | Evidence checked | Verdict |
|---|---|---|
| Samples are sequential | `background.js` advances `sampler.index` only on `turn_done`; static gate in `verify-extension.mjs` | Verified |
| Sampling cannot persist the profile | sampler calls only the voice ticket/socket path; override is emitted only as `session_start.profile_override`; no profile/storage write in sampler code | Verified |
| Untrusted actions are bounded | `parseVoiceSamplerAction` requires the v1 type/version, caps 16 entries, validates IDs, and caps text at 300 characters; focused smoke covers rejection/cap | Verified |
| Cancellation prevents later samples | cancellation deletes the tab-owned sampler and closes its active session; `playNextVoiceSample` checks identity/cancelled state | Verified |
| Every sample produces audible output | no live gateway/provider/audio-device evaluation was run | Unproven |

## Adversarial verdicts

- Goal correctness: **PASS** for browser consumption of the existing v1 action.
- Security/trust boundary: **PASS**. Provider credentials remain gateway-only;
  model-provided fields are data-validated and never evaluated.
- Resource efficiency: **PASS**. One socket/sample at a time, capped plan, no mic
  capture, no client audio retention.
- Anti-gaming: **PASS WITH RESIDUAL UNKNOWN**. Verification proves control flow,
  not audible provider behavior. The real extension smoke loaded the worker and
  exercised existing browser behavior, but it did not run a paid/live sampler.

## Scores

No measured benchmark score is claimed. Architecture-confidence rating: **90%**
for bounded, non-persisting sequential orchestration, based on focused tests,
static gates, and the real-extension smoke. Residual unknowns are live gateway
compatibility, provider audio delivery, playback ordering on a real browser audio
device, and failure behavior under real socket latency.
