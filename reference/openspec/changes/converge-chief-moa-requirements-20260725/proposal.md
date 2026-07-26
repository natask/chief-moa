# Converge Chief Moa Requirements

## Why

Active OpenSpec changes contain hundreds of checkboxes, partial completion
claims, blockers, and historical notes. A checked source box is not enough to
prove that the requested outcome is complete. The repository needs one
deterministic progress control that preserves every explicit task while making
the next observable action visible.

Repeated macOS authorization dialogs also showed that verification itself can
disturb the user. The control must prohibit prompt-capable verification unless
the user explicitly authorizes the exact command and purpose.

## What changes

- Generate one canonical ledger row for every checkbox in every active,
  non-archive OpenSpec `tasks.md`.
- Treat source completion claims as incomplete until exact evidence and
  independent verification are registered.
- Require a smallest next action and observable acceptance check for every
  incomplete row.
- Split partial completion claims without erasing completed sub-slices.
- Mark one bounded planning slice in progress for each program with no checked
  source task; this is progress selection, not an implementation claim.
- Record the current zero-Keychain implementation evidence while keeping runtime
  launch/TCC behavior unverified.
- Forbid prompt-capable or privileged diagnostic tools without explicit user
  approval.

## Scope and authority

This change controls documentation and evidence classification only. It does
not implement product features, access credentials, launch applications,
inspect Keychain contents, change background items, or promote a deployment.
Historical documents and archived changes remain context, not completion
authority.
