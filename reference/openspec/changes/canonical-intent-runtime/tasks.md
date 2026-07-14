## 1. Domain

- [ ] 1.1 Add the product-events-backed intent reducer and legal transition
  commands.
- [ ] 1.2 Add typed relations, idempotency, focus push/pop, and restart tests.
- [ ] 1.3 Add bounded project/intent rehydration with source receipts.

## 2. Admission and bridges

- [ ] 2.1 Capture every non-incognito ordinary turn before route/launch/tools.
- [ ] 2.2 Persist broker capture before route decisions and launches.
- [ ] 2.3 Make explicit new/fork/incognito context selection precede retrieval.
- [ ] 2.4 Link broker events, work tasks/nodes, runs, artifacts, and receipts to
  the intent aggregate without replacing their current APIs.

## 3. Transactional child

- [ ] 3.1 Wrap one profile-control command as a child intent.
- [ ] 3.2 Prove focus push -> bounded tool -> receipt -> complete -> focus pop.

## 4. Surface/API

- [ ] 4.1 Add authenticated intent list/detail/rehydration routes.
- [ ] 4.2 Add intent/focus/brief events to the bounded Aggie protocol.
- [ ] 4.3 Carry intent correlation additively on Android/browser turns.

## 5. Verification and release

- [ ] 5.1 Run focused lifecycle, privacy, route-order, broker-fault, restart,
  resource, and no-gaming tests.
- [ ] 5.2 Run `cd gateway && npm run check`.
- [ ] 5.3 Create isolated preview evidence; promote only after rollback,
  compatibility, no-interruption, backup/restore, and smoke gates pass.
