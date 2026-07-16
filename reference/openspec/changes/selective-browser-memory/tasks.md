# Tasks: Selective Browser Memory

## 1. Local semantic memory

- [x] 1.1 Add a pure extension policy for canonicalization, bounding,
      deduplication, 30-day expiry, and a 100-card cap.
- [x] 1.2 Capture only visible active HTTP(S) page metadata, first `h1`, meta
      description, and structural kind after sensitive-page suppression.
- [x] 1.3 Add extension-owned On/Off, Erase, and recent-card projection to the
      A.G. side panel.
- [x] 1.4 Add deterministic policy tests and include the new runtime in source
      classification and verification.
- [x] 1.5 Run complete extension verify/smoke, strict OpenSpec validation, bump
      the release version to `0.1.48`, and package `A.G.-0.1.48.zip`.
- [ ] 1.6 Reload the user's unpacked extension and verify the loaded version
      independently. Blocked on 2026-07-15 because the isolated agent could not
      prove a reload would avoid interrupting active browser work; packaging is
      not claimed as a reload or active deployment.

Acceptance: with Browser memory off, visits produce no card. After the user
turns it on, an eligible visible page produces one local bounded card; revisiting
it deduplicates; query/hash data is absent; a recognized sensitive page produces
no card; Pause prevents later capture; Erase removes retained cards; no memory
operation makes a gateway request.

## 2. User correction and retrieval (follow-up)

- [ ] 2.1 Add per-site exclusion and card delete/pin/edit controls.
- [ ] 2.2 Add local text search and “where did I see this?” retrieval.
- [ ] 2.3 Evaluate opt-in gateway synchronization as a separate retention and
      deletion contract. Do not attach memory to model turns implicitly.
