## Product model

The companion is one conversational front door to a system of agents. It owns
the active conversation and knows the catalog of durable threads. A work branch
is a first-class thread with its own history, lineage, run state, and summary;
it is not merely a child call hidden inside the current chat.

```text
resumable voice draft
        |
   explicit send
        |
        +--> foreground reply lane --> stream short speech immediately
        |
        +--> intent extraction --> zero or more durable branch/run proposals
                                      |
                                      +--> independent execution and receipts
```

The foreground lane answers or acknowledges the user as soon as enough meaning
is available. It does not wait for planning, tools, runs, summaries, or every
requested deliverable. Agent work continues independently and reports durable
status/completion events back into the conversation.

## Three different continuations

1. **Resume draft** continues audio that has not been sent. It invokes no model,
   tool, TTS, or agent work until send.
2. **Continue thread** adds a new turn to an existing first-class history.
3. **Continue run** sends steering or feedback to one unambiguous active run in
   that thread. Ambiguous follow-up returns to normal intent resolution.

These operations must never be inferred from one another merely because they
occur close together in time.

## Fan-out

One message may contain several explicit outcomes. The coordinator produces a
bounded dispatch plan with one item per outcome. Each item records its source
turn, target branch (new, fork, or existing), proposed action, and whether user
approval is required. Admitting one item does not require admitting all items.
Retries are idempotent by source turn and dispatch item identifier.

Creating a post draft, a longer essay, and a durable memory from one thought is
therefore three inspectable outcomes, not one oversized chat reply. Publication
remains a separate approved action.

## Thread recovery

The user may ask which threads were active, what each was about, or to return to
one. The gateway answers from the thread store and rolling summaries, not model
memory. A switch changes the active branch only after an unambiguous selection;
otherwise the companion asks a short disambiguating question.

The companion may feel continuous, but provider conversation state is scoped to
the selected branch. Stable prefixes and summaries may improve cache reuse; KV
cache behavior is an optimization and never the source of thread identity or
durability.

## Latency contract

- Transcript events are whole-turn snapshots and replace prior client text.
- Model text streams into phrase-sized TTS before generation completes.
- The first speakable phrase is prioritized over completing the full answer.
- Background branch creation and agent execution never block first audio.
- Every stage records admission, first transcript, model first token, TTS first
  audio, client playout, and final completion timing.

## Safety and ownership

The gateway owns classification, thread/run persistence, provider credentials,
and dispatch. Android owns microphone state, pause/resume controls, approvals,
local actions, and receipts. Server/model dispatch items are proposals until the
existing authority boundary admits them.
