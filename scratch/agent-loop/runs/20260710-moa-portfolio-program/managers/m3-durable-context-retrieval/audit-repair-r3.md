# M3 repair R3 audit record

Date: 2026-07-10

## Direct specialized audit verdict

**PASS for the repaired implementation under deterministic file-store scope;
independent verdict unproven.**

Security/privacy review verified the named OAuth, single/double percent-encoded
OAuth, bearer/basic, API-key and PAT corpus is masked before rendering. This is
not claimed as a universal secret detector. Hosted tenant authorization remains
deferred and is not inferred from the source eligibility flag.

Correctness/anti-gaming review verified receipt source ids, ranking, source
count, cache fingerprint and redaction count derive from rendered lines only.
Duplicate source ids are rejected. Tests execute the production implementation,
include non-rendered and duplicate-source repros, and do not claim provider or
production behavior.

Trust-boundary review verified runs and browser tasks require stored session and
branch matches. Forks may include only runs from the declared parent branch that
are explicitly referenced by the already scoped inherited turns; references do
not override stored session or branch.

Performance/resource review verified source candidates are sliced before copy
and sort, with at most 256 or four times `max_sources`; each source inspects at
most eight lines and 4,000 characters per line. Rendering tracks length
linearly rather than repeatedly joining the full output. Production latency and
capacity remain unmeasured.

## Measured gates

- Focused unit/collection tests: 11 pass, 0 fail.
- Artifact smoke and server/module syntax: pass.
- Full gateway check: 184 tests, 183 pass, 1 intentional skip, 0 fail.
- Strict `context-thread-management` OpenSpec: valid.

## Independent audit attempts

1. Codex GPT-5.4/high read-only audit completed repository reads but emitted no
   final verdict. A second narrow run with explicit `--output-last-message` also
   emitted no final and did not create the requested output file.
2. Gemini CLI exited 41 because Vertex project/location or API-key authority was
   not configured. No environment secrets were read or printed.
3. Claude Opus/high plan-mode audit exited without output.

These process launches are not auditor evidence. A fresh Tier-0 or collaboration
auditor must return explicit PASS/BLOCK before integration. No live deployment
or preview was attempted.
