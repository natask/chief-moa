# Predecessor Moa repository classification

Recorded 2026-07-25 (intent in-rgh.3, tick 215). Classifies each older Moa
repository under `~/projs` as a migration source or a retired root, and links
every identified surviving artifact to its canonical destination in chief-moa.

## Frame

chief-moa began as a fresh bootstrap, not a fork: the initial commit
`7deb6254` ("chore: initial commit", 2026-06-20, Devin-generated) creates the
whole tree from nothing, and the repo has a single remote
(`github.com/natask/chief-moa`). No predecessor is a git ancestor. Every
survival is therefore a copy- or design-migration, and the classification
below rests on in-repo evidence: chief-moa's file tree (exact + fuzzy greps,
ticks 210/214) and, new this tick, its complete commit history
(`git log --all` message search per predecessor name).

## moa-assistant — MIGRATION SOURCE (confirmed)

Three independent commit bodies document the copy-migration:

- `f2cae3f6` "chore(repo): wire commit/changelog protocol for agents" —
  "Bring chief-moa to parity with moa-assistant's commit discipline …
  Fix AGENTS.md header to name chief-moa instead of moa-assistant."
- `50e1bbc7` "fix(gateway): correct REPO_ROOT for flat top-level layout" —
  "REPO_ROOT used '../..' which was correct for the old
  moa-assistant/software/moa_gateway nesting."
- `80d6d269` "fix(scripts): repath deploy/smoke for flattened layout" —
  "Drop the moa-assistant software/* nesting from OTA build/sync and browser
  smoke scripts."

Surviving artifacts → canonical destinations:

| Artifact in moa-assistant | Canonical destination in chief-moa |
| --- | --- |
| `software/moa_gateway` | `gateway/` |
| Android app (software/* nesting) | `android_app/` |
| Browser extension (software/* nesting) | `browser_extension/` |
| Agent operating contract (AGENTS.md) | `AGENTS.md` |
| OTA build/sync + smoke scripts | `android_app/deploy/ota/`, `browser_extension/scripts/`, `scripts/` |

## moa-bare ("Moa Bear") — MIGRATION SOURCE (plausible, design-level)

The self-hostable-event-substrate change cites "Moa Bear" as its validated
design source:

- `reference/openspec/changes/self-hostable-event-substrate/proposal.md:11` —
  "The older Moa Bear planning and code points to the right substrate."
- `design.md:5` — "The Moa Bear research and implementation add the missing
  [event-log + CRDT substrate]."
- `design.md:101` — "Loro is the strongest reuse candidate from Moa Bear
  because the codebase already [validated it]."
- `adoption-research.md:75` — "Loro remains the best CRDT candidate because
  the Moa Bear code already validated" snapshot export, incremental updates,
  import/merge, version vectors, undo, and browser/mobile WASM packaging.

Surviving artifact → canonical destination: the event-log + CRDT substrate
design validation (Loro) → the self-hostable-event-substrate change, concrete
adoption point `tasks.md:31` (task 5.2, "Add Loro snapshot/update persistence
linked from event crdt_refs"). No code artifact migrated — design and
validation knowledge only.

Confidence caveat: "Moa Bear" is a prose name; the match to the `moa-bare`
directory is phonetic/thematic (bare/Bear; local-first CRDT subject matter),
not a verified identifier. `git log --all` for "moa-bare" returns no product
commits. Upgrading to confirmed needs one attended read of
`~/projs/moa-bare` (README/package.json/git log for "Loro"/"CRDT"/"event
log"); if absent there, "Moa Bear" names a fifth, not-yet-located predecessor
and this row should be re-pointed at it.

## moa.backup — RETIRED ROOT (exhaustive in-repo negative)

Zero references anywhere in chief-moa: file tree (exact "moa.backup" and
fuzzy "moa backup" greps, ticks 210/214) and full commit-history message
search (this tick) all return nothing. No surviving artifact has a
destination in the canonical repo, and the name marks it as a snapshot, not a
lineage. Classified retired.

## moa-chrome-bare — RETIRED ROOT (exhaustive in-repo negative)

Same exhaustive negative: zero file-tree hits (exact "moa-chrome-bare" and
fuzzy "moa chrome"/"chrome bare" greps, ticks 210/214) and zero commit-history
hits (this tick). chief-moa's browser-extension lineage traces to
moa-assistant (`80d6d269`), superseding any older Chrome-line repo. Classified
retired.

## Status

Classification complete at this evidentiary standard: all four predecessors
classified, every identified surviving artifact linked to its canonical
destination. The single open residual is a confidence upgrade (moa-bare
plausible → confirmed), which requires read access outside this repo and does
not change any destination link recorded above.
