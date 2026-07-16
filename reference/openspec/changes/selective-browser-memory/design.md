# Design: Selective Browser Memory

## Data Flow

```text
explicit panel toggle (default off)
  -> active visible HTTP(S) tab completes or becomes active
  -> existing sensitive-page preflight
  -> content script proposes bounded metadata + first h1 + meta description
  -> background policy strips query/hash and bounds every string
  -> exact-card deduplication + 30-day expiry + 100-card cap
  -> chrome.storage.local
  -> extension-owned side-panel list / Pause / Erase
```

There is no network edge in this flow. The browser content script is an
untrusted proposer; the background module revalidates protocol, URL, shape,
length, allowed page kind, retention, and cardinality before writing.

## Capture Semantics

“What the user saw” means a page that was active and visible, not every open or
background tab. Navigation completion and tab activation are the only capture
triggers in the first unit. Repeated visits to an unchanged card increment its
visit count; changed title/heading/description creates a new revision card.

Useful information is deliberately conservative: page identity and
publisher/author-provided summary signals. The runtime does not infer what is
important by reading all body text. Later ranking can be added over this small
store only after the user can inspect and correct what was retained.

## Privacy And Authority

- Disabled is the fresh-install behavior.
- Retained cards stay in the extension profile and are never attached to an
  A.G. turn in this unit.
- URL query, fragment, and embedded credentials are rejected or removed before
  persistence.
- Existing password, credential/payment autocomplete, form-metadata, and
  sensitive-route suppression runs before semantic fields are read.
- Erase deletes all cards but does not silently change the on/off preference.
- Restricted browser pages and non-HTTP(S) pages are never captured.

The suppression set is defense in depth, not a universal privacy classifier.
The panel copy names the actual exclusions and local retention boundary.

## Staging

This unit proves transparent local capture and review. Follow-up units may add
per-site exclusion, card editing/pinning, local search, or an explicitly
approved gateway sync. Raw continuous recording is not a prerequisite for any
of them.
