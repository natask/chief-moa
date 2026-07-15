# Repair contract: timeline final-audit-3 blockers

## Privacy policy

- Canonicalize camel, snake, kebab, whitespace, punctuation, and case variants
  into key/path segments before policy. Reject raw-content nouns wherever they
  occur in a composed key: transcript, text, prompt, content, completion,
  message, body, payload, blob, audio samples/content/frames and equivalent
  audio namespaces. Use an explicit metadata allowlist for safe counters such
  as `transcript_chars` and `audio_bytes`; do not infer safety from projection
  later ignoring the field.
- Apply one credential-family policy consistently to keys, arbitrary values,
  and opaque identifiers. Include password, generic secret, session token, ID
  token, webhook secret (`whsec_*`), and all families already covered. Preserve
  explicit `[redacted]` forms.
- Keep all six real sanitized diagnosis projections accepted and hostile input
  code side effects at zero.

## Exact resource admission

- Inspect an ordinary array's own length descriptor and reject length above the
  4,096 item/node limit before materializing indexed descriptors. Only after
  that bound may exact prototype/symbol/hole/accessor/data-entry validation
  traverse the array.
- Compute exact JSON byte size for already validated own data, including every
  delimiter/separator, escaped string/key encoding, booleans/null, and exact
  finite-number encoding. Reject limit+1 for every exported ingest shape and
  accept the exact limit when the schema itself remains valid.
- Keep cycle/exotic/accessor/symbol/non-enumerable/inherited-iterator rejection,
  total node/depth/string/scalar bounds, frozen output, deterministic causal
  order, and O(n log n) construction unchanged.

## Required tests

- all composed content/audio key variants and credential value/ID variants from
  `final-audit-3.md` reject;
- a large dense array rejects before descriptor materialization with a bounded
  descriptor/side-effect probe;
- exact encoded limit and limit+1 matrices for diagnosis and timeline inputs;
- six real diagnosis variants, isotonic permutations, authority/provenance,
  no-I/O static scan, and coverage/full serial gateway gate remain green.

Own only the timeline module, its focused tests, and this lane's notes. Do not
commit, merge, route, preview, or deploy. Record evidence in
`repair-audit-4-result.md`; a different auditor must return PASS.
