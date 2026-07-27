# Glossary

Arithmetic intensity
: The number of operations performed per byte moved from a named memory level.

Autoregressive
: A generation rule that samples the next token from prior tokens, then repeats.

Batch
: Requests or token positions processed together.

Causal attention
: Attention that blocks each position from reading later positions.

Decode
: The phase that produces output tokens after prefill.

Embedding
: A learned vector associated with a token ID.

Goodput
: Work that completes within a stated service goal.

Human-originated intent
: A goal submitted by a person. It may create several tasks and model requests.

Intent throughput
: Completed human-originated intents per unit time under a fixed success test.

GQA
: Grouped-query attention. Several query heads share each K and V head.

HBM
: High-bandwidth memory placed near an accelerator.

Head dimension
: The vector width inside one attention head.

KV cache
: Stored keys and values from prior positions, kept per attention layer for reuse.

Latency
: Time for one request or event.

Logits
: Unnormalized scores over the vocabulary.

MLP
: The per-position feed-forward sublayer in a transformer block.

Prefill
: The phase that processes the input prompt and builds initial inference state.

Residual stream
: The sequence of hidden vectors that layers read and update through residual connections.

Roofline
: A performance bound set by peak compute and memory bandwidth.

Speculative decoding
: A method that proposes several tokens cheaply and verifies them with the target model.

Agent-created task
: A delegated unit of work created while an agent pursues an intent.

State-space model
: A sequence model that updates a recurrent state instead of retaining all prior attention keys and values.

Throughput
: Total work completed per unit time.

Token
: An integer vocabulary item produced by a tokenizer.

TPOT
: Time per output token.

TTFT
: Time to first token.
