# Repair contract: timeline final-audit-2 blockers

## 1. Preserve causal order in the synchronized display

Permutation determinism is necessary but not sufficient. Build a canonical
navigation key that respects every same-clock monotonic chain and remains a
transitive total order globally.

One acceptable bounded construction is:

1. group records by exact source/observer/surface/clock domain when monotonic
   time exists;
2. deterministically order each group by monotonic time plus canonical ties;
3. assign each group an isotonic navigation wall time using the running maximum
   of its observed wall times, so a later monotonic event can never navigate
   before its predecessor solely because the wall clock moved backward;
4. globally sort the precomputed navigation tuple, then canonical ties.

Do not reintroduce a pair-dependent comparator or quadratic topological scan.
The six-permutation receipt wall=3000/mono=100, playout wall=1000/mono=200,
server wall=2000 case must yield one order with receipt before playout.

## 2. Close remaining raw-content and credential channels

Canonicalize camelCase, kebab, snake, whitespace, and punctuation variants into
one key form. Recursively reject generic raw/payload/blob/body/data/header/key
content where it can carry unbounded audio/model/tool/credential material,
including nested `audio.*`, `tool.arguments|results`, `rawHeaders`, plain
authorization/header/cookie/key fields, and AWS secret-access-key variants.

Extend secret-value and opaque-ID rejection for at least:

- `api_key_*`, `access_token_*`, `refresh_token_*`, `client_secret_*`;
- Slack `xox*` including `xoxc`/`xoxd`;
- SendGrid `SG.*`, GitHub/GitLab, npm, Stripe, bearer/JWT, OpenAI/Google, AWS key
  IDs and private-key material.

Apply the same path/key/value policy to all exported ingest shapes. Retain all
six real current `voiceDiagnosisPayload()` variants and `[redacted]` values.

## Required evidence

- all prior 26 tests plus new isotonic/causal and path/key/value/ID matrices;
- independent original probes now fail with zero input-executed code;
- focused coverage of every reachable rejection/attribution rule;
- serial gateway gate, with any unrelated flake rerun and recorded honestly;
- syntax and tracked/per-untracked whitespace.

Own only the timeline module/test and lane notes. Do not touch routes, stores,
other surfaces, active tree, commit, merge, or deploy. Write
`repair-audit-2-result.md`; root will require a different final auditor.
