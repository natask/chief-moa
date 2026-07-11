# Research: topology

- The current retrieval path is split across `gateway/server.js` helpers:
  `recallMemoryContext`, `durableSessionContextBlock`, and
  `threadRecallContext`.
- Those helpers already enforce bounded char windows and fork inheritance, but
  they emit plain strings and lose source ids, ranking rationale, and cache
  identity.
- Chat HTTP, HTTP voice fallback, cascaded voice reasoning, and agent prompt
  helpers all consume those blocks directly. A pure artifact module plus a thin
  server collector can improve the shared seam without changing storage formats.
- Existing `thread-store` and Brain memory stores already provide the durable
  inputs needed for an artifact envelope. No vector DB or new persistence layer
  is required for this unit.
