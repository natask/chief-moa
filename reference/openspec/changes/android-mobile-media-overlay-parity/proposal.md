# Android Mobile Media And Overlay Parity

## Why

The Android surface can already launch a uniquely matched launcher app and open
an HTTPS URL, but ordinary phone turns do not yet expose a complete device-local
media tool family. The installed overlay also needs browser-parity movement,
dismissal, neutral styling, and transcript selection behavior.

## What Changes

- Expose visible-label-only `app.launch` and bounded read-only `app.list`
  through ordinary typed chat, HTTP voice turns, cascaded voice reasoning, and
  Android legacy-Live dispatch, with Android retaining unique-launcher
  resolution authority.
- Route bounded Android media proposals through the existing tool-request queue.
- Let Android inspect and control active media sessions after the user grants
  Notification access.
- Search/open YouTube locally across the user's preferred installed variant,
  control playback, and store named video positions only after resolving a real
  YouTube video id.
- Sync a bounded user-approved bookmark record through the gateway so Android
  and the browser extension can recall and open the same video and timestamp.
- Give the browser extension media parity for parsing canonical YouTube URLs,
  opening a video at a timestamp, selecting one exact local search result by
  title/channel, and creating/opening synced bookmarks.
- Manage YouTube playlists through a package-bound, fail-closed Accessibility
  adapter with a local confirmation before mutation.
- Let the orb-anchored card group move from either the orb or a card header,
  expose close/hide controls without opening the full app, use the browser's
  neutral palette, and preserve text selection over swipe dismissal.
- Make client execution receipts claim-bound and durable, retain bookmark
  create/delete retry state with deletion tombstones, and fail closed instead
  of evicting unacknowledged work.
- Publish Android OTA releases transactionally with an owner lock, verified
  pre-publish snapshot, immutable releases, automatic rollback before commit,
  and a separate exact-byte acknowledgement before cleanup.

## Boundaries

- No YouTube API, OAuth, browser cookie, provider credential, or remote YouTube
  playlist state is added to Android, the browser, or the gateway.
- The gateway queues execution proposals and stores only the bounded approved
  bookmark record. Android/browser validate and execute local media actions and
  receipt every terminal result.
- Media/accessibility observations are evidence, never instructions.
- Android resolves `YouTube` through a device-local alias that defaults to the
  installed Advanced/ReVanced app, keeps stock YouTube as a named compatible
  choice, and permits an explicit user-visible per-request override. The model
  never chooses an unapproved package.
- Undocumented app-specific adapters are allowed only behind a named adapter,
  supported-version/package/signature boundary, bounded fixtures, and
  fail-closed behavior when the installed UI drifts.
- V1 saved spots require a syntactically valid real `video_id`; title-only or
  other weak identity may assist transient search but cannot create a bookmark.
  Recall uses normalized textual exact/phrase/token matching with ambiguity
  rejection. Raw-audio matching is deferred; voice uses its transcript.
- Browser voice remains unchanged. Browser media URL/open/bookmark behavior is
  in scope, while browser CDP, authenticated-session automation, and cookies are
  not required for these operations.

## Verification

- Gateway: `cd gateway && npm run check && npm run smoke:surface-skills && npm run smoke:surface-entrypoints && npm run smoke:device-hub`
- Android: `cd android_app && ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew testDebugUnitTest assembleDebug`
- Browser regression: `cd browser_extension && npm run verify && npm run smoke`
- OTA publication: `bash android_app/deploy/ota/test-sync-vps.sh`
- OpenSpec: `openspec validate android-mobile-media-overlay-parity --strict`
- Physical phone: stock/preferred-variant app launch, YouTube search/play/seek, named spot recall,
  confirmed disposable-playlist lifecycle, overlay movement/removal, and text
  selection versus left/right swipe.
- Browser: parse/open/bookmark a canonical YouTube video URL and reopen the
  synced bookmark at the same timestamp without OAuth, cookies, or CDP.
