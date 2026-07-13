# Research: trust and data

- The gateway is the only authoritative retrieval assembler; model output is not
  allowed to select hidden sources or bypass bounds.
- Incognito branches are already marked by `inc-` ids and skipped by the thread
  store. The artifact collector must also skip them explicitly so future source
  additions do not regress privacy.
- Current session-scoped reads do not yet carry MF's tenant authority contract.
  This unit must therefore avoid inventing cross-tenant semantics and instead
  keep the artifact scoped to the existing session/branch read model.
- Secret-like text can appear in transcripts, receipts, and browser evidence.
  The artifact layer needs allowlist-style masking before those strings become a
  reusable retrieval product.
