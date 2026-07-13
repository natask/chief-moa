# Repair contract 4 — current execution surface authority

Require `canExecuteProposal` callers to provide a valid full canonical current
surface object. Match ID, kind, mode, and optional device-ID presence/value to
the proposal before considering approval. Fail closed when full surface context
is missing or malformed; a legacy `surface_id` is not authority. Add the exact
hostile mixed-mode/device reproduction and missing-context test, retain quality
thresholds, and rerun every M5 and gateway gate. No compatibility weakening.
