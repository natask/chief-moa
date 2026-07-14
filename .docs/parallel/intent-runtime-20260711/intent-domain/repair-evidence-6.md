# Intent domain repair evidence 6

Status remains `BLOCK` pending a fresh independent audit.

The configured stale threshold is now honored exactly. The real child suite
proves that a same-PID prior process instance is not reaped below a configured
30-second threshold, is recoverable after that threshold, and that an aged
lock carrying this exact live process-instance ID times out instead of being
reaped.

Partial focus push recovery now has a deterministic compensation event. If the
return-target suspension exists, the child admission does not, and an
intervening legal mutation makes child admission impossible, retry appends one
idempotent `intent.focus_popped` restoration to the suspended return target and
returns `INTENT_FOCUS_PUSH_COMPENSATED`. Later retries return the same stable
failure without duplicating compensation. The ordinary immediate retry path
still completes either transiently failed half.

Candidate gates:

- Event-substrate child lock suite: 7/7 pass.
- Intent runtime suite: 18/18 pass.
- Syntax and diff checks: pass.

No commit, merge, preview, promotion, or deployment was performed.
