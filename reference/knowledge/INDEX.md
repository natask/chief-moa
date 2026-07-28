# Product knowledge index

This directory is the tracked, searchable home for curated product knowledge
that must survive a chat, run, device, or service boundary. Raw private capture
does not belong here. Each record carries a stable artifact ID, an intention
relation, provenance metadata, ownership, lifecycle state, and update rules.

| Artifact ID | Title | Intent relation | Status | Updated |
| --- | --- | --- | --- | --- |
| `knowledge:chief-moa:versioned-knowledge-work:v1` | [Versioned knowledge work](versioned-knowledge-work.md) | Defines `intent:chief-moa:versioned-knowledge-work` | Accepted direction | 2026-07-25 |

## Record rules

- Keep the artifact ID stable across ordinary edits.
- Record meaningful changes in Git so the commit identifies the authoring
  agent/run through the repository's Entire linkage.
- Replace a record only when its meaning or authority moves to a different
  canonical artifact. The replacement must name the old artifact under
  `supersedes`, and the old artifact must point forward under `superseded_by`.
- Link only to tracked canonical sources. Summarize necessary decisions from
  private or ignored capture without making that capture the only authority.
- Do not embed raw speech, private transcripts, credentials, or secret-bearing
  source material.
