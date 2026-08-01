# Project-linked history capture audit — 2026-08-01

This is a read-only evidence inventory. It does not contain raw conversation
text and does not authorize any inferred implementation or deployment.

Command:

```sh
node scripts/intent-history/audit-entire-history.mjs \
  --kind direct-user --format json
```

## Coverage

- 371 materialized Entire session directories.
- 307 materialized full transcripts and 368 prompt snapshots.
- 55 Entire refs spanning 355 reachable checkpoint commits.
- 12 full transcripts recovered from refs for sessions that were prompt-only
  in the materialized metadata.
- 319 transcript-bearing sessions after recovery; 52 remain prompt-only.
- 1,061 user-shaped messages parsed from the selected maximal sources.
- 185 exact duplicates removed before classification counts.
- 464 records classified as direct-user candidates by deterministic wrapper
  exclusion.
- Timestamped JSONL coverage from 2026-06-20T21:40:26Z through
  2026-08-01T07:43:23Z.
- Zero malformed JSONL records in the selected sources.

Topic tags overlap by design. Among direct-user candidates the audit found 159
work/intent, 115 voice, 113 identity/privacy, 101 release, 97 memory/context, 94
surface UI, 86 browser, 86 companion, 75 Android, 56 action/authority, and 21
desktop candidates.

## Known limitations

- Entire covers captured work in this repository and linked worktrees. It is
  not proof of complete ChatGPT, Claude, Codex, phone, browser, or gateway
  account history.
- Fifty-two sessions have only a prompt snapshot after ref recovery.
- User-shaped transport records include injected contracts, environment
  blocks, delegated-agent instructions, task notifications, and local-command
  events. Deterministic classification reduces that noise but does not prove
  semantic authorship.
- Exact deduplication does not resolve repeated STT spans, paraphrases, changes
  of mind, or supersession. Those remain alignment work.
- Absence from this corpus is not evidence that the user never expressed an
  intent.
- The production gateway history export remains unaudited because this task did
  not use or request a gateway credential.

## Safety result

The audit command is stdout-only. It has no output-file option, writes no
review decisions, and cannot launch agents, edit code, approve actions, publish
artifacts, or deploy. Excerpts require the explicit local
`--include-excerpts` flag.
