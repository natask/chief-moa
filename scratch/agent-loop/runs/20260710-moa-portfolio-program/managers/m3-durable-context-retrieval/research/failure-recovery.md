# Research: failure and recovery

- Retrieval failure today is fail-soft: if a block cannot be built, the turn can
  still answer without extra context. The artifact unit must preserve that
  property.
- Thread-summary recall already tolerates missing gbrain and stale summaries.
  The new artifact should treat missing recall, redacted snippets, or truncated
  sections as partial degradation rather than fatal errors.
- Cache identity must be deterministic so stale client/provider caches can be
  invalidated by source revision changes instead of silently reusing old context.
- Because no new persistence is introduced, rollback is a normal source rollback
  to the prior commit.
