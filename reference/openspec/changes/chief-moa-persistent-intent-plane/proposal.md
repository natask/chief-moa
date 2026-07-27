# Proposal: Chief Moa Persistent Intent Plane

Chief Moa needs one durable, cross-surface view of confirmed intentions and the
agents working on them. This slice belongs inside the existing gateway and its
product-event substrate. It does not introduce a parallel intent-management
product or competing JSON store.

The slice adds authenticated create/read/list/update routes for intentions,
manual first-class-agent registration, idempotent progress, an explainable
intent/agent/run/artifact relation, and receiptable completion/needs-user pings.
MoaMac, Android, browser, web/ag.app and future iPhone clients share the same
canonical ids.

No launcher is automatically trusted. Current Codex subagent identities persist
only if an explicit adapter registers them. This change supplies the manual
fixture path and records the contract a future launcher adapter must call.
