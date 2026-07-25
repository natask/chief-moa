---
artifact_id: knowledge:chief-moa:versioned-knowledge-work:v1
intent_id: intent:chief-moa:versioned-knowledge-work
intent_relation: defines
record_kind: product_direction
source_type: user_product_insight
source_date: 2026-07-25
sensitivity: private-derived-no-raw-speech
owning_agent: chief-moa-product-owner
status: accepted-direction
created_at: 2026-07-25
updated_at: 2026-07-25
supersedes: []
superseded_by: null
---

# Versioned knowledge work

## Current truth

- Chief Moa already says that product decisions and execution evidence must not
  live only in chat. Its event substrate treats product events as canonical,
  work artifacts as durable recall, and telemetry as derived and loss-tolerant.
- The canonical intent runtime makes an intention—not a session, thread, task,
  run, artifact, or telemetry stream—the durable desired outcome.
- Work events and artifacts can survive a worker or chat session and can be
  queried by node, run, kind, or text. The existing reducer proves durable
  materialization, but it does not yet curate general knowledge work.
- Git and Entire already provide the repository path for versioned agent work:
  Git records the artifact change, while Entire links commits to the producing
  conversation/run. This contract currently covers repository artifacts more
  completely than voice, prose, research, and cross-service knowledge.
- Raw chats, recordings, and transcripts are valuable source evidence and
  operational telemetry. They are not, by themselves, the current product
  truth and must not silently become authority.

## Desired system

Chief Moa moves knowledge work out of ephemeral chat sessions without making
conversation slower or less generative.

```text
high-flow chat / speech / tool activity
  -> retained raw source with consent, sensitivity, and retention metadata
  -> provenance-linked extraction
  -> curated text / audio / code / decision artifacts
  -> durable intention + responsible agent
  -> versioned change record with agent/run attribution
  -> indexed projections available across authorized services and devices
  -> background pursuit, progress updates, blockers, and user pings
```

This is Entire-style versioned agent work generalized from code repositories to
all knowledge work. The curated layer evolves through explicit revisions
instead of replacing history with a flattened summary. The raw layer preserves
rhythm, ambiguity, alternatives, and provenance so later extraction can recover
what an early reducer missed.

An artifact is evidence or a maintained knowledge object under an intention. It
does not become a new intention merely because it exists. A responsible,
addressable agent keeps the intention moving within granted authority, records
new evidence and artifact revisions, and pings the user when a decision,
approval, blocker, or meaningful milestone needs attention.

The desired system treats these responsible agents as first-class,
addressable identities. One agent may continue an authorized intention across
devices and services, including open-source self-hosted Chief Moa deployments,
without changing the durable agent, intention, artifact, revision, or
provenance contract. This is a target boundary, not a claim that current
clients, identity federation, or self-hosted installations already provide it.

## Requirements

### Capture and provenance

1. Preserve raw chat and audio only under explicit capture, privacy, retention,
   and deletion rules. Store content-addressed references and bounded metadata;
   do not copy private raw speech into curated public or repository records.
2. Give every curated artifact a stable ID, kind, sensitivity, source
   references, source date, owning agent, creation/update timestamps, status,
   and intention relation.
3. Record the extraction agent/run, extraction policy/version, source spans or
   time ranges, and confidence or unresolved ambiguity. A curated claim must be
   traceable without treating the source as execution authority.
4. Keep raw evidence immutable except for authorized retention/deletion.
   Corrections and changed interpretations create new events or revisions.

### Curated artifacts and revision

5. Support evolving text, audio, code, decisions, plans, questions, and other
   typed artifacts. Each type defines its canonical representation and any
   separately stored media/blob representation.
6. Record meaningful artifact changes through a Git-like commit model:
   immutable revision identity, parent revision, authoring agent, run,
   timestamp, change reason, and content digest. Repository-backed artifacts
   use Git plus Entire; non-repository artifacts need equivalent semantics.
7. Preserve losing, superseded, and conflicting revisions. A projection may
   select current truth, but it must not erase the path or evidence behind it.
8. Separate literal excerpts, derived claims, decisions, desired state, and
   generated output so a summary cannot silently flatten them into one voice.

### Intentions and agents

9. Link each artifact to zero or more durable intentions with typed relations
   such as `evidence_for`, `defines`, `produced_by`, `blocks`, `corrects`, or
   `supersedes`. Creation of an artifact alone never creates or completes an
   intention.
10. Name one responsible agent or owner for maintained artifacts and active
    intentions. Persistent identity survives disposable execution runs.
11. Background agents may advance an intention within explicit authority,
    append progress and artifact revisions, and schedule durable wakeups.
    Completion remains an evidence-backed, authority-checked transition.
12. Notify the user when attention is required or useful: approval, ambiguity,
    blocker, conflict, material revision, milestone, or proposed completion.
    Pings must be deduplicated, rate-limited, sensitivity-aware, and linked to
    the relevant intention and artifact revision.
13. Give first-class addressable agents stable identities that can span
    authorized devices, services, and open-source self-hosted deployments under
    the same intention, artifact, revision, authority, and provenance
    contracts. Transport, hosting mode, or a fresh run must not create a
    competing identity or source of truth.

### Search and access

14. Make curated artifacts searchable by text, semantic similarity, artifact
    type, intention, agent, source, time, sensitivity, status, and relations.
15. Make the same authorized current projection available across services and
    devices. Local caches and UI views are projections, not competing truth.
16. Enforce tenant, user, device, and capability boundaries at retrieval time.
    Search snippets must not disclose content a caller cannot open.
17. Let users inspect provenance, revision history, current owner, related
    intention, background activity, and why an artifact appeared in search.

### Flow preservation

18. Keep capture latency low and never require classification during high-flow
    idea generation. Admission can retain a source first and curate later.
19. Allow multiple candidate interpretations, partial extracts, and unfiled
    inbox material. Ask for clarification only when it changes authority,
    routing, destructive retention, or the meaning of a durable intention.
20. Preserve raw cadence and alternative ideas under the capture policy while
    presenting concise curated projections for resumption.

## Open questions

- What raw chat/audio retention defaults balance recoverability with privacy,
  and how do deletion requests propagate into derived artifact provenance?
- Which artifact kinds use Git directly, which use an event/blob store with
  Git-like revisions, and which need CRDT merge for concurrent editing?
- Who may declare a curated revision current when user and agent edits conflict?
- How should semantic search indexes remove deleted or newly restricted source
  material without leaving recoverable embeddings or snippets?
- What is the minimum useful extraction policy that preserves uncertainty,
  cadence, and alternatives rather than producing generic summaries?
- How are cross-service identities, offline writes, notification preferences,
  and agent ownership synchronized without making a third-party service the
  canonical authority?
- Which background actions are safe by default, and which always require a
  fresh user approval?

## Acceptance tests

1. A user generates a fast, branching spoken idea. Capture returns without
   waiting for classification. Later, a curator produces linked decision,
   question, and draft artifacts while the retained source remains private and
   no raw speech appears in the tracked record.
2. A fresh agent on another device searches by phrase, intention, and artifact
   kind; it retrieves the same authorized current projection, source
   provenance, owner, and revision history without searching the original chat.
3. An agent revises an artifact. The system records a new immutable revision
   with parent, digest, change reason, agent ID, run ID, and timestamp, while the
   prior revision remains inspectable.
4. Two agents produce conflicting interpretations. Both survive; the current
   projection exposes the conflict and does not select authority by
   last-write-wins.
5. A background owner advances an intention, attaches a new artifact revision,
   and emits one deduplicated user ping tied to the exact intention/revision.
   It cannot exceed its authority or declare completion without required
   evidence and acceptance.
6. Removing access to a sensitive source prevents unauthorized artifact opens,
   search hits, snippets, and cross-device projections. Authorized provenance
   still records that a restricted source existed without revealing it.
7. An artifact is corrected or superseded. Stable IDs and typed relations make
   the current record discoverable, the old record points forward, and no
   history is silently overwritten.

## Update and supersession rules

- Edit this artifact when the direction is refined without changing its core
  identity. Update `updated_at` and commit the change with agent/run linkage.
- Add a dated decision section or linked design artifact when an open question
  becomes settled architecture.
- Create a new artifact ID only when the product direction splits or is
  replaced. Set `supersedes` on the replacement and `superseded_by` here.
- Never update this record solely from inferred private content. User-authored
  direction, accepted design decisions, or independently verified product
  evidence must support material changes.

## Related tracked sources

- [Agent workflow](../../AGENT_WORKFLOW.md) establishes durable, resumable
  artifacts instead of chat-only memory.
- [Architecture](../../ARCHITECTURE.md) defines product events, telemetry,
  capture evidence, work artifacts, and cross-device projections.
- [Canonical intent runtime](../openspec/changes/canonical-intent-runtime/design.md)
  separates intentions from sessions, runs, artifacts, and telemetry.
- [Work graph artifact store](../openspec/changes/postgres-work-graph-artifact-store/design.md)
  makes plans, decisions, results, and merged answers durable and queryable.
- [Event substrate](../openspec/changes/self-hostable-event-substrate/design.md)
  defines append-only truth, provenance-bearing events, blobs, projections,
  supersession, and cross-device sync.
- [Voice intent completion loop](../openspec/changes/voice-intent-completion-loop/design.md)
  connects versioned objectives, responsible lanes, evidence artifacts,
  background pursuit, and authority-checked completion.
