# M3 repair R4 evidence

The fresh collaboration audit blocked integration on canonical decoding,
metadata privacy, operational-source lifecycle/provenance, all-branches hostile
coverage, and the absence of measured complexity/CRAP results.

R4 canonicalizes valid percent runs for a maximum of three rounds with tolerant
handling of malformed adjacent escapes, then applies redaction. It validates or
redacts query/scope/source metadata and hashes revisions/dedupe material. Run and
task collection now filters stored deleted/incognito state—including incognito
branch identity—before all-branches results are returned, while retaining only
explicitly referenced runs from the declared fork parent. Source construction
uses each record's stored branch rather than the requested branch.

## Measured evidence

- Focused hostile tests: 14 pass, 0 fail.
- Full gateway: 187 tests, 186 pass, 1 intentional skip, 0 fail.
- Strict context OpenSpec: valid.
- ESLint 9 complexity rule maximum 10: pass with no findings after refactor.
- c8 Istanbul coverage plus `crap-score`: maximum complexity 10 and maximum CRAP
  10.137174 for `normalizeSource`; all functions are below the contract's 15.

The temporary CRAP tool installation initially replaced the worktree dependency
tree and caused unrelated executor smoke failures. `npm ci` restored the exact
lockfile dependency set; the reported full green gate is the post-restore run.
No package or lockfile change is included. `npm ci` still reports two existing
high-severity dependency findings; no forced breaking upgrade was attempted.

No preview, live deployment, paid evaluation, or production benchmark ran.
Fresh independent collaboration re-audit is still required.
