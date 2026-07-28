# Tasks

## Workflow/docs

- [x] Define device-local media, bookmark, playlist approval, and overlay-parity boundaries.
- [x] Update `ARCHITECTURE.md`, the Android manual QA checklist, and done ledgers.

## Gateway lane

- [x] Expose visible-label-only `app.launch` and bounded `app.list` through
      typed chat, HTTP voice, cascaded voice, and Android legacy-Live entrypoints.
- [x] Route bounded `media.open`, `media.control`, and `media.playlist` execution
      only to owning local surfaces; never call a YouTube API.
- [x] Add the bounded user-approved synced bookmark record and cross-surface
      create/list/resolve/delete endpoints with tenant/session authorization.
- [x] Prove routing/receipt behavior, bookmark field exclusions, and no
      browser-task/CDP fallback in smokes.
- [x] Bind terminal receipts to the active claimant/lease and make exact retries
      idempotent while conflicting or stale receipts fail closed.

## Android action/accessibility lane

- [x] Keep app launch limited to unique visible launcher apps and make ordinary
      typed/fallback voice turns able to propose it.
- [x] Add user-granted MediaSession observation and guarded transport controls.
- [x] Add a device-local preferred YouTube app alias plus explicit request
      override for installed stock/ReVanced-compatible variants.
- [x] Add validated YouTube open/search/play behavior and versioned,
      package/signature-bound, fail-closed app-specific adapters where needed.
- [x] Make `media.open` receipts distinguish search, accessibility requirement,
      verified selection, and unverified playback; never claim exact playback
      from an intent or search launch alone.
- [x] Add visible-label-only VLC resolution for installed exported handlers and
      explicit HTTPS/content URI handoff; reject package selectors, file/intent
      URIs, ambiguity, and title-only playback without a source connector.
- [x] Add the private named media-spot cache; require a valid real video id and
      explicit approval before bounded gateway sync.
- [x] Resolve saved spots by normalized exact/phrase/token text with ambiguity
      rejection; defer raw-audio matching.
- [x] Add fixed playlist UI state machines plus digest/expiry/package-bound
      local approval, version/signer/profile binding, observed postconditions,
      and terminal receipts.

## Android overlay lane

- [x] Move the anchored orb/card group from the orb or either card header.
- [x] Add voice-card Close/Hide, keep drag-to-remove, and require no full-app visit.
- [x] Replace green-cast hardcoded colors with browser-neutral tokens.
- [x] Make transcript text selectable and suppress swipe while selection is active;
      keep left and right dismissal equivalent.

## Browser lanes

- [x] Keep browser voice behavior unchanged.
- [x] Parse supported canonical YouTube URL shapes and current bounded playback
      position after explicit user activation.
- [x] Open a canonical video id at a timestamp and create/resolve/delete the same
      synced bookmark records used by Android.
- [x] Add browser-local query search that opens only one exact title/channel
      result and fails closed on zero or duplicate matches.
- [x] Persist claim-bound tool receipt retries and bounded bookmark create/delete
      outboxes with delete tombstones and no silent capacity eviction.
- [x] Assert bookmark/open behavior uses no OAuth, cookies, CDP, or authenticated
      browser-agent task.

## Android OTA safety lane

- [x] Replace destructive OTA sync with operation-owned locking, immutable
      release staging, verified prior-state snapshots, rollback, and exact-byte
      acknowledgement before cleanup.
- [x] Add credential-free failure-path smoke coverage and run it in the Android
      OTA CI build before any manual production publish job.
- [x] Make the repo deployment entrypoint resolve the tracked, non-secret
      production VPS target, require exact authenticated public manifest/APK
      verification with the token confined to the running gateway container,
      and record optional ADB installation separately from publication.

## Verification/deploy lane

- [ ] Run gateway, Android, browser media/voice regression, strict OpenSpec, and
      physical-phone QA on at least stock YouTube plus the configured preferred
      variant when installed.
- [ ] Commit coherent units with Conventional Commits.
- [ ] Create Android/gateway release artifacts, promote only when the active gate
      passes, and smoke the installed/promoted exact candidate or record blockers.
