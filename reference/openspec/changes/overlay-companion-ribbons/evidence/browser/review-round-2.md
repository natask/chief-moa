# Opus visual review — round 2

- Invocation: noninteractive Claude Code `-p --model opus --effort high`
- Claude Code: `2.1.212`
- Returned model: `claude-opus-4-8`
- Session: `471c3862-e1ba-41b0-80b8-1400bd83897f`
- Inputs: both PNGs under `round-1/`
- Cost reported by the CLI: `$0.3722805`

The review judged contrast and basic legibility good. Its remaining concrete
finding was structural: at the bottom viewport edge the reply ribbon was
clamped through the mascot, weakening the companion anchor. It also asked that
the distinct user and assistant streams remain visibly bounded and that the
expanded state not become stored chat history.

Applied in round 2: when there is no room below the companion, both distinct
streams stack above it with the reply closest and a fixed gap. Their visual
tokens, the 28px collapsed height, the small mascot, and the bounded expanded
behavior remain unchanged.
