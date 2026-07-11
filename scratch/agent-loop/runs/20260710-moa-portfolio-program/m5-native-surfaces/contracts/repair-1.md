# Repair contract 1 — approval provenance and typed event semantics

Repair only the two fresh-audit blockers. Require a complete validated
`action.approved` envelope bound to the same version, proposal, session and
surface, with a decision timestamp between proposal creation and eligibility
evaluation. Add exact typed payload validators for every declared message type;
hello/resume must reject malformed negotiation/cursors and operational events
must require their semantic identifiers/statuses. Add hostile tests reproducing
the auditor findings. Do not add transport, persistence, UI or platform code.
