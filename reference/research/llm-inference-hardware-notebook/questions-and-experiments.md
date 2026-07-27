# Questions and experiments

## Calculation 1: model and KV bytes

Build a small calculator with these inputs:

```text
parameter count
weight bits
layers
query heads
KV heads
head dimension
KV bits
prompt length
output length
batch size
```

Return:

```text
weight bytes
KV bytes per token
KV bytes after prefill
KV bytes after generation
total live bytes
```

## Calculation 2: phase-transfer break-even point

Compare:

```text
disaggregated time =
prefill time on P
+ KV transfer time
+ decode time on D
+ queueing

aggregated time =
prefill time on G
+ decode time on G
+ interference
+ queueing
```

Sweep prompt length, output length, batch size, and interconnect bandwidth.

## Calculation 3: pause policy

For paused agent work, compare:

```text
keep cost = device_byte_seconds * occupancy price

swap cost =
device_to_host_transfer
+ host_byte_seconds
+ host_to_device_transfer

recompute cost =
token replay latency
+ replay energy
+ queue delay
```

Question: at what pause duration should the policy change?

## Measurement 1: local inference trace

Use one open model and one serving engine. Record:

- TTFT.
- TPOT.
- prompt and output lengths.
- active batch.
- device power.
- HBM traffic if counters allow it.
- KV allocation over time.

Run short and long prompts. Run batch 1, then larger batches.

## Measurement 2: roofline

Choose a device. Use vendor peak compute and memory bandwidth as ceilings. Measure achieved values for:

- prefill projection GEMMs,
- decode projection GEMMs,
- prefill attention,
- decode attention,
- KV transfer.

Plot measured points. Do not infer them from labels such as "compute-bound."

## Reading questions

- How much temporary KV state does tree verification create?
- Can diffusion decoding reuse intermediate state between denoising steps?
- Which recurrent models keep state size independent of context?
- Does a long tool pause favor compressed KV, host swap, or recompute?
- What voltage and frequency range minimizes joules per accepted token?
- Does the answer change when the memory stack dominates package power?

## Personal curriculum

### Session 1

Trace one token through embeddings, attention, MLP, residual connections, and logits. Derive KV size.

### Session 2

Learn arithmetic intensity and roofline reasoning. Calculate a weight-streaming lower bound.

### Session 3

Study batching, paging, prefix reuse, and pause or resume policies.

### Session 4

Compare aggregated, disaggregated, and hybrid prefill/decode serving.

### Session 5

Trace speculative decoding and Medusa. Mark which work becomes parallel.

### Session 6

Compare causal attention, masked diffusion, and recurrent state. Rewrite the hardware thesis for each one.
