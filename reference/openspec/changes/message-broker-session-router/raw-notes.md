# Raw Notes

Source: dictated user turn on 2026-06-22.

Preserved phrases and intent:

- "when I send a message, I should know that that message should be the one
  making the change"
- "the text should be able to make sense of that message ... from all the
  previous messages"
- "Every message could be to continue some already existing session"
- "we need to upkeep sessions, say projects, subprojects"
- "The fundamental thing to do is have a broker"
- "When the message comes in, it looks at all existing sessions and feeds that
  message to them"
- "the skill gets invoked"
- "a bunch of different models are initiated"
- "search online using as many search tools as possible"
- "find and refine the most important information"
- "provide me with a report"
- "sometimes you know the answer"
- "the most optimal path"

Interpretation:

The broker is not just a model prompt. It is a gateway-owned durable routing
layer that stores the message, compares it against active work, invokes the
right skill/workflow, and records why it chose that route. It can be cheap and
deterministic when obvious, or it can escalate to multi-agent research when the
message demands it.
