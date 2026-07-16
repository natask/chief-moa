# Android Screen-Aware Draft Insertion Authority Candidate

## Candidate scope

This ticket-5 candidate starts from the repaired Android integration candidate
`ee97c4fa`. It adds only Android-local insertion authority; it does not change
the gateway, browser, macOS, screenshot grant, transcription transport, install,
OTA, or deployment paths.

The exact visible IME candidate becomes a `screen.insert_text` proposal bound to
the expected package and a SHA-256 fingerprint of the semantic `EditorInfo`
identity. Pressing the dedicated Insert control is the explicit local approval
and binds the proposal digest. Immediately before execution the IME re-reads the
package/editor fingerprint, rejects stale, changed, unsupported, private, or
password targets, and invokes exactly one `InputConnection.commitText(text, 1)`.
The approval is terminal before the platform call, so an editor refusal cannot
be retried into a second mutation.

Each terminal attempt appends a local hash-chained receipt with proposal id,
target package/fingerprint, effect path, status/reason, and proposed-text digest.
The receipt does not retain the proposed text. `send` is independently refused;
the candidate adds no click, editor action, submit, or Accessibility
`ACTION_SET_TEXT` path.

## Deterministic evidence

- Focused trust tests cover exact-text preservation, explicit approval,
  approval mismatch, expiry, target freshness, package/fingerprint drift,
  password suppression, missing/failed effect, replay refusal, and the distinct
  unsupported Send action.
- `verifyDraftInsertionPolicyCoverage` requires at least 90 percent line,
  branch, and method coverage for the pure authority module.
- The final candidate must run full Android unit tests, all focused coverage
  gates, `assembleDebug`, and strict OpenSpec validation before commit.

## Physical and integration blockers

No APK is installed or deployed in this ticket. Physical-phone proof remains
not measured: exact insertion into two ordinary apps, password/private field
suppression, package/field switch refusal, persisted receipt inspection, and
screen-derived proposal ingress. The current candidate deliberately uses only
the already visible IME candidate; wiring model-derived draft proposals into
that local review surface remains a later integration step.
