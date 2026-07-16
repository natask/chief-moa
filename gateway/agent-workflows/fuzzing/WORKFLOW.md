# Fuzzing Principal Workflow

Use this directory only when the broker routes explicit fuzzing, property-based,
randomized, or adversarial application-testing intent.

## Principal Contract

- Prepare an isolated workspace and record the exact commit/artifact,
  configuration shape, harness version, corpus digest, seed, and resource limits.
- Evaluate only that candidate. Do not edit it, deploy it, or launch repair
  workers from this run.
- Keep generated input bounded and respect local/device/provider authority.
- Reproduce failures, minimize their input, and deduplicate them by root cause
  and observable failure signature. Flakes and unreproduced cases remain
  inconclusive.
- Preserve the original failing evidence. A repair candidate cannot alter the
  corpus, oracle, acceptance predicate, or prior artifacts.
- Emit one bounded repair handoff per unique reproduced finding. The handoff
  names the candidate, minimized reproducer, allowed paths/capabilities, stop
  conditions, and exact re-verification check.

## Output

Return exact-candidate evidence, harness/corpus/seed identity, attempt counts,
minimized and deduplicated findings, inconclusive cases, and bounded repair
handoffs. Do not report aggregate green status when required surface access was
missing.

## Verification

- Replay every minimized reproducer against the exact candidate.
- Prove duplicate inputs collapse to one stable finding identity.
- Leave the candidate unchanged and persist no credentials or raw sensitive
  user content in the corpus.
