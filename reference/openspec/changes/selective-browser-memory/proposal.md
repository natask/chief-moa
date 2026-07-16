# Selective Browser Memory

## Why

The useful part of a Screenpipe-like product is continuity: remembering what the
user encountered so they can find or resume it later. A raw browser recording is
the wrong first primitive for A.G. Most pixels, repeated frames, page chrome,
forms, and incidental text have no durable value, while retaining them creates
privacy, storage, and review problems.

## What Changes

- Add an explicit, default-off Browser memory control to the extension-owned
  side panel.
- While enabled, retain a bounded semantic card when the user visits a normal
  visible browser page.
- A card may contain only the query-free/hash-free page URL, site hostname,
  document title, first `h1`, publisher-authored meta description, structural
  page kind, first/last seen times, and visit count.
- Apply the existing recognized-sensitive-page suppression before extraction.
- Keep cards in extension-local storage. Do not send them to the gateway or a
  model in this unit.
- Deduplicate exact semantic repeats, retain at most 100 cards, expire cards
  after 30 days, and provide Pause and Erase controls beside the visible list.

## Explicit Non-Goals

- No screenshot, video, audio, OCR, body-text, selection, accessibility-tree,
  form/control-value, cookie, browser-history, or cross-application capture.
- No claim that route/DOM sensitivity detection recognizes every private page.
- No semantic model ranking, embeddings, search, gateway synchronization, or
  use of retained cards as model context yet.
- No replacement for explicit video notes or the temporary proactive-helper
  grant.

## Impact

This adds one browser-local store and panel projection. It changes no Android or
gateway authority, introduces no provider credential, and creates no remote
deployment/state compatibility requirement. The release unit is an extension
package and verified reload only.
