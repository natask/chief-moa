# Media Note Consolidation Evidence — 2026-07-16

## Candidate

- Architecture guardrail: `4345be02`
- Media-note consolidation: `8c8e573c`
- Verification repair: `1cb44456`
- Exact verified tip: `1cb44456ae6aa7fad3b7f26b43ffa48ca4975f60`

## Result

Audio and video note persistence and HTTP mechanics moved behind the named
`media-note-store.js` and `media-note-http.js` boundaries. The existing audio
and video factories, routes, stored JSON/blob formats, quotas, response headers,
streaming behavior, and video-only deletion contract remain in their domain
wrappers.

Production source fell from 753 to 490 physical lines for a net reduction of
263 lines. The repository production/UI total and non-growth ceiling are both
94,945 lines; the final acceptance target remains 50,000.

## Verification

Before the host volume filled, the focused production gates passed:

- audio wrapper: 100% lines, branches, and functions;
- video wrapper: 100% lines, branches, and functions;
- shared store: 100% lines, 92.31% branches, 100% functions;
- shared HTTP: 100% lines, 96.61% branches, 93.33% functions.

At exact tip `1cb44456`, independent static verification passed:

- clean worktree and `git diff --check`;
- `node --check` for all four media-note modules;
- `node scripts/source-size-policy.js` at 94,945 / 94,945 lines;
- strict OpenSpec validation;
- compatibility review of exports, stored formats, quotas, errors, response
  codes, headers, streaming, and deletion behavior.

## Verification And Promotion Blocker

The later full `gateway npm run check` and repeated focused coverage run could
not complete because the host data volume reached `ENOSPC` while tests created
temporary stores and Node wrote coverage JSON. Those failures were
environmental, but the full check is not claimed as passing.

No gateway preview or active promotion was attempted. Promotion remains blocked
until the full gateway check passes on a host with adequate temporary space and
the stateful gateway promotion gate has isolated preview, rollback,
state-compatibility, backup, and restore-check evidence.
