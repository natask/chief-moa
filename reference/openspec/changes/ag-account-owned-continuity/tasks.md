## 1. Establish account-owned restore

- [x] 1.1 Audit every Android persistence site and classify it as
      must-stay-local, should-be-server-owned, or transient, with file:line.
- [x] 1.2 Serve the account's restorable settings to a device-authenticated
      `ag.companion` install at `/v1/device-enrollments/continuity/settings`,
      withholding routing, provider, trust-policy, and prompt fields.
- [x] 1.3 Apply the snapshot on the client with fail-safe merge semantics: never
      blank a stored value, never drop an unrecognized field.
- [x] 1.4 Version the snapshot and carry client-side forward migrations, with
      explicit older/newer/unverifiable behavior.
- [x] 1.5 Restore during enrollment and report restored, partial, or not
      restored without claiming an outcome that did not happen.

## 2. Move wrongly-local settings onto the account

- [ ] 2.1 Add account profile fields for orb scale, voice-first gestures,
      spoken-reply preference, and preferred media player.
- [ ] 2.2 Add the media spots (`MoaMediaSpotStore`) to account-owned storage and
      restore them on a clean install.
- [ ] 2.3 Write the local values through to the account on change, and add them
      to the restorable projection behind a schema-version bump plus the
      matching client migration.

## 3. Make unsent capture durable

- [ ] 3.1 Persist a promoted offline draft to app-private storage with a
      client-generated turn id before upload is attempted.
- [ ] 3.2 Reconcile through the existing reserve/complete/acknowledge outbox
      rather than a second queue, using the turn id as the idempotency key.
- [ ] 3.3 Enforce the byte bound and retention window, surfacing an expired or
      overflowed turn as a visible failure.

## 4. Finish per-user scoping

- [ ] 4.1 Scope the agent profile store by owner instead of `global`/`device`
      only, behind the existing `readAccountSettings(principal)` seam.
- [ ] 4.2 Authorize profile routes by the authenticated principal rather than a
      single shared `MOA_GATEWAY_TOKEN`.
- [ ] 4.3 Verify two enrolled owners on one gateway receive different settings.

## 5. Verify

- [x] 5.1 Gateway: `npm run check`.
- [x] 5.2 Android: `lintDebug assembleDebug testDebugUnitTest`.
- [ ] 5.3 Real-device check: install `ag.companion` beside `ai.moa.assistant`,
      enroll, and confirm settings return with no local transfer claimed.
