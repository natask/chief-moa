# Browser implementation evidence

Candidate: `feat/browser-transcript-revisions-20260802`

The browser extension negotiates `transcript_revisions_v1` version 1 and
accepts rolling whole-transcript replacements only for the exact session,
branch, turn, user speaker, and canonical projected message identity. Sequence,
batch revision, and sealed PCM byte offset must move forward. The browser does
not infer overlap between corrected and live text.

Ordinary audio sessions explicitly send
`transcript_reconciliation:{enabled:true,version:1,privacy_scope:"retained"}`.
Incognito and non-audio/sample sessions omit the opt-in, leaving them
ineligible for the second provider pass.

`transcript-revision-protocol.js` is shared by the service worker, page
companion, and side panel. The service worker rejects mismatched events before
they reach a surface. Each surface independently rejects stale delivery. The
side panel also keeps a monotonic finalized-history ledger, so an old HTTP
response cannot downgrade corrected text or the value read by Copy. Bounded
post-turn refreshes pick up a completed tail revision after the turn socket is
closed.

Deterministic coverage proves:

- a corrected sealed prefix and its authoritative live tail replace one whole
  snapshot;
- an out-of-order prefix cannot rewind a newer partial;
- a newer partial may follow a natural streaming-final boundary;
- duplicate revision, regressing sealed byte offset, wrong branch, wrong
  message, and assistant-speaker events fail closed;
- a stale or mutated same-revision History response cannot replace the newer
  corrected Copy source;
- an older gateway without the capability keeps legacy whole-snapshot display.
- retained normal sessions opt in while incognito and non-audio sessions do not.

Verification:

- `cd browser_extension && npm run verify`: passed, 261 tests.
- `cd browser_extension && npm run smoke`: passed in real headless Chrome.
- `cd browser_extension && npm run smoke:sidepanel`: passed in real headless
  Chrome, including exact retained-message Copy and revision selection.
- `node scripts/source-size-policy.js`: passed; `background.js` and
  `content.js` remain at their existing ceilings.
- strict OpenSpec validation: passed.

Not claimed here: loaded-user-browser reload, a live provider correction, merge,
push, package publication, or deployment. Those belong to integration and
release after the gateway implementation is combined.
