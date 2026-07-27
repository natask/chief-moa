# LLM inference and hardware notebook

This notebook builds a first-principles model of language-model inference. It also tests a hardware idea:

> Power and memory limits may favor different systems for prompt prefill and token decode.

That is a hypothesis. It is not the starting assumption.

The notebook keeps six kinds of notes separate:

- `Fact`: a claim supported by a cited source or a direct derivation.
- `Mental model`: a useful simplification with named limits.
- `Hypothesis`: Nat's claim or a claim we want to test.
- `Counterargument`: evidence or reasoning that could weaken a hypothesis.
- `Question`: something we do not know yet.
- `Experiment`: a calculation or measurement that could resolve a question.

## Start here

1. Read [Transformer inference from first principles](01-transformer-inference.md).
2. Study [One token through Llama](03-one-token-through-llama.md).
3. Use [Correcting the forward-pass mental model](04-correcting-the-forward-pass.md) to check recall.
4. Open the [tensor-shape explorer](visuals/transformer-shapes.html).
5. Work through [A quantitative test of phase specialization](02-phase-specialization-worksheet.md).
6. Add corrections and questions to [Questions and experiments](questions-and-experiments.md).

## Map

| File | Purpose | State |
|---|---|---|
| [01-transformer-inference.md](01-transformer-inference.md) | Tokens, transformer blocks, prefill, decode, KV cache, batching, roofline, energy | First substantive chapter |
| [02-phase-specialization-worksheet.md](02-phase-specialization-worksheet.md) | Named-model calculations, agent workload metrics, and the current architecture frontier | Quantitative worksheet |
| [03-one-token-through-llama.md](03-one-token-through-llama.md) | Exact decoder-only transformer equations, tensor shapes, toy arithmetic, and self-test | Teaching core |
| [04-correcting-the-forward-pass.md](04-correcting-the-forward-pass.md) | Point-by-point corrections to Nat's current mental model | Diagnostic lesson |
| [visuals/transformer-shapes.html](visuals/transformer-shapes.html) | Browser-viewable shape and KV-size explorer | Interactive aid |
| [thesis-map.md](thesis-map.md) | Current thesis, threats, and architecture branches | Initial map |
| [questions-and-experiments.md](questions-and-experiments.md) | Calculations and measurements to run | Seeded backlog |
| [glossary.md](glossary.md) | Terms in plain language | Initial |
| [sources.md](sources.md) | Exact primary and official sources | Initial |

## Scope

This path sits under `reference/research` because the work is durable research, not Chief MOA product behavior. Nothing here changes production code.

## Update rule

When a result changes the thesis:

1. Add the source or experiment.
2. Mark what changed.
3. Record the boundary of the claim.
4. Keep the old claim in git history.

Last reviewed: 2026-07-25.
