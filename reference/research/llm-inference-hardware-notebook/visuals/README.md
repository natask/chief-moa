# Visual learning path: decoder-only transformer inference

This index replaces “boxes and arrows” with resources that animate values, let
you manipulate a real model, or work through a concrete computation. Use the
resources in order. Do not try to make any one GPT-2 visualization stand in for
a current Llama-style inference engine.

## The short path

### 1. See the complete machine move

[Brendan Bycroft — LLM Visualization](https://bbycroft.net/llm)

- **Goal:** form one spatial mental model from token IDs through embeddings,
  repeated decoder blocks, residual additions, logits, and sampled output.
- **Use:** choose the guided walkthrough. Pause and rotate at every “embedding,”
  “attention,” “project,” “add,” and “MLP” transition. Zoom down to individual
  multiplies only after the full pass makes sense.
- **Teaches well:** a live, manipulable, end-to-end GPT-style computation;
  tensors as banks of actual numbers rather than abstract labeled rectangles.
- **Does not teach:** modern Llama details (RMSNorm, RoPE, GQA, SwiGLU),
  prefill/decode separation, or a growing per-layer KV cache. Treat it as the
  coordinate system, not the final architecture reference.
- **Prerequisite:** none beyond basic vectors and matrix multiplication.
- **Check:** Point to the number that is a token ID, the row retrieved from the
  embedding table, and the evolving residual vector. Why are they three
  different things?
- **Kind:** interactive conceptual and numerical visualization.

### 2. Build the Q/K/V mental model

[3Blue1Brown — Attention in transformers, step by step](https://www.3blue1brown.com/lessons/attention/)

- **Goal:** understand attention as “the current token poses a query; prior
  tokens expose keys; matches select and mix value updates.”
- **Use:** the sections **Motivating Examples**, **Querying**, **Keys**, **Values**,
  and **Attention Pattern**. The page mirrors the animation and includes
  embedded check questions, so section names are more robust than video
  timestamps.
- **Teaches well:** why Q and K produce relevance scores, why V is the payload,
  and how the update changes a token’s residual representation. The “mole”
  example makes contextualization visible.
- **Limit/modern correction:** it deliberately pretends tokens are words and
  uses a simplified single-head story with nonstandard `Value_down` /
  `Value_up` names. It does not cover causal masking, GQA, RoPE, or caching.
  The semantic stories for individual heads are intuition, not a guarantee
  that trained heads specialize cleanly.
- **Prerequisite:** comfort with dot products helps but is not required.
- **Check:** Why is `softmax(QKᵀ)V` a lookup-and-mix operation rather than three
  interchangeable projections?
- **Kind:** animated conceptual explanation with mathematics.

### 3. Manipulate a real forward pass

[Georgia Tech Polo Club — Transformer Explainer](https://poloclub.github.io/transformer-explainer/)

- **Goal:** connect the mental model to live GPT-2 tensors and next-token
  probabilities.
- **Use:** enter a short prompt with a repeated noun. Expand, in order,
  **Embedding → Transformer Block → Multi-Head Self-Attention**. Hover the
  token IDs and shapes; inspect dot product → mask → softmax → value mix. Then
  change temperature, top-k, and top-p under output probabilities.
- **Teaches well:** BPE-like subword tokenization and IDs, embedding-table
  lookup, Q/K/V projections, head splitting, causal mask, MLP, residual
  connections, logits/probabilities, and sampling. It runs GPT-2 Small locally
  in the browser, so displayed values change with the prompt.
- **Limit/modern correction:** GPT-2 uses learned absolute position embeddings,
  LayerNorm, GELU MLPs, equal Q/K/V head counts, and no presented KV-cache.
  A Llama block instead commonly uses RMSNorm, RoPE on Q/K, GQA, and SwiGLU.
  “Heads focus on grammar/meaning” is a useful possibility, not a fixed rule.
- **Prerequisite:** resource 2 or equivalent attention intuition.
- **Check:** For the last prompt token, identify the mask row, its attention
  probability row, the weighted value result, and the final next-token
  distribution. What changes when temperature changes, and what does not?
- **Kind:** interactive architecture plus live tensor/numerical visualization.

### 4. Make the decoder-only time axis explicit

[Jay Alammar — The Illustrated GPT-2](https://jalammar.github.io/illustrated-gpt2/)

- **Goal:** see why generation is repeated next-token inference and why a
  decoder-only causal mask prevents information from flowing backward in time.
- **Use:** **Part 1: Transformers for Language Modeling** through **A Deeper
  Look Inside**, then **Part 2: Create Query, Key, and Value → Score → Sum → The
  Illustrated Masked Self-Attention**. Skip Part 3.
- **Teaches well:** the residual-stream-like evolving vector, one decoder block,
  autoregressive token loop, masked attention, multiple heads, and a clear
  worked visual sequence.
- **Limit/modern correction:** the author explicitly uses “word” and “token”
  loosely, rotates/transposes vectors for layout, omits much normalization, and
  shows inference as processing one item at a time without explaining prefill
  batching or KV reuse. It is GPT-2-era: no RoPE, GQA, RMSNorm, SwiGLU, or cache.
- **Prerequisite:** resource 3.
- **Check:** During generation, which earlier token representations may the
  newest token read, and which token’s final state is projected to logits?
- **Kind:** conceptual visual narrative and architecture bridge.

### 5. Upgrade attention to modern Llama-style GQA

[Sebastian Raschka — Grouped-Query Attention guide](https://sebastianraschka.com/llms-from-scratch/ch04/04_gqa/)

- **Goal:** replace the false “every query head owns unique K and V heads”
  assumption and tie head sharing directly to KV-cache cost.
- **Use:** **Why It Exists**, **What Changes in the Block**, and the linked
  **KV-cache memory comparison for MHA versus GQA**. Keep the picture:
  many Q heads, fewer K/V heads, several Q heads reading one K/V group.
- **Teaches well:** MHA → GQA mapping, the quality/efficiency tradeoff, and why
  GQA is common in Llama, Qwen, Gemma, and Mistral-family models.
- **Limit:** this is a compact visual/reference guide, not a token-by-token
  numerical attention animation. RoPE is mentioned as composable but not taught;
  use the notebook’s Llama forward-pass chapter for the exact “rotate Q and K
  after projection, before score” placement.
- **Prerequisite:** exact Q/K/V flow from resources 2–4.
- **Check:** If there are 32 query heads and 8 KV heads, how many query heads
  share each K/V head, and by what factor does the K/V portion of cache shrink
  versus 32-head MHA?
- **Kind:** modern architecture visual and mathematical reference.

### 6. Watch the cache appear and grow

[Hugging Face community article — The KV Cache: How It Eliminates Redundancy](https://huggingface.co/blog/atharv6f/kv-cache-basics)

- **Goal:** visualize the per-layer state that connects prefill to every
  autoregressive decode step.
- **Use:** **Without KV Cache**, **With KV Cache**, **The Compute-Memory
  Tradeoff**, and **Summary: The KV Cache in One Picture**. Answer its three
  check questions.
- **Teaches well:** prefill computes K/V for every prompt token; each layer
  stores its own K and V; decode creates one new Q/K/V per layer, uses the new Q
  to look up all cached K, mixes cached V, then appends the new K/V. Cache length
  grows by one per generated token. It also supplies a worked memory formula.
- **Modern correction:** for MHA,
  `bytes = 2 × layers × tokens × KV_heads × head_dim × bytes/value × batch`.
  For GQA, `KV_heads` is the smaller K/V head count, not the query-head count.
  The article’s example table uses older MHA-style Llama configurations; do not
  transfer those exact numbers to a current model without reading its config.
- **Prerequisite:** resources 3 and 5.
- **Check:** Why is Q not cached? For batch 1, 32 layers, 8 KV heads, head
  dimension 128, BF16, and 4096 cached tokens, compute the K+V cache size:
  `2 × 32 × 4096 × 8 × 128 × 2 = 536,870,912 bytes` (512 MiB).
- **Kind:** worked inference sequence and quantitative reference.

## Gap map

| Diagnostic gap | Best visual | Required correction |
|---|---|---|
| BPE/token → ID → embedding confusion | Polo, then Bycroft | An ID is an integer index; the embedding is the selected learned row. |
| “Residual stream” feels like another layer | Bycroft + Alammar | It is the evolving per-token state; attention and MLP contribute updates through residual adds. |
| One decoder block / exact QKV flow | 3Blue1Brown + Polo | Scores come from Q against K; probabilities mix V; output projection returns the update to model width. |
| Causal mask | Polo + Alammar | It blocks future key positions during parallel prompt processing; during one-token decode no future entries exist. |
| Multi-head versus GQA | Raschka | Q-head count may exceed KV-head count; grouped Q heads share cached K/V. |
| RoPE | Notebook Llama forward-pass chapter | None of the strongest interactive tools models it correctly. Rotate Q and K by position before `QKᵀ`; do not add a position vector to the residual stream. |
| MLP/SwiGLU | Polo for MLP role; notebook for Llama equation | GPT-2’s GELU MLP is not SwiGLU: Llama gates one projection with SiLU before the down projection. |
| Logits and sampling | Polo | Sampling transforms/selects from logits after the model forward pass; it does not alter attention activations. |
| Prefill versus decode | Hugging Face KV article | Prefill processes prompt tokens in parallel and creates every layer’s cache; decode processes one new position and repeatedly reads/appends it. |
| KV-cache location/growth/cost | Hugging Face + Raschka | Cache is per layer and stores only K/V across positions; multiply by batch and use KV-head count for GQA. |

## What not to use as the main teacher

- The original *Illustrated Transformer* centers an encoder–decoder translation
  model. It is historically valuable but adds cross-attention and encoder state
  Nat does not need for vanilla decoder-only inference.
- Static Mermaid/tensor-shape diagrams remain useful as lookup sheets, not as
  the first explanation. They expose topology without showing values moving or
  a representation being updated.
- Karpathy’s *Zero to Hero / Let’s build GPT* is excellent implementation
  practice, but it is a long coding lecture rather than the shortest visual
  repair for these diagnostic gaps. Use it after this path when implementing.

## Rights and attribution

This directory contains links and original study notes only. It does not copy
third-party illustrations, animation frames, or source assets.

- Bycroft’s visualization and Polo’s explainer are linked at their hosted sites;
  their source repositories should be consulted for current code-license terms
  before reuse. A source-code license does not automatically license every
  hosted visual asset.
- Jay Alammar identifies his explanatory work as
  [CC BY-NC-SA 4.0](https://jalammar.github.io/explaining-transformers/);
  attribution and noncommercial/share-alike conditions apply to reuse.
- 3Blue1Brown materials are copyrighted. Link to or embed the official hosted
  lesson; do not copy frames or redistribute assets without permission.
- The Hugging Face article and Raschka guide are linked, not reproduced.
  Re-check their page/repository terms before any reuse beyond quotation allowed
  by law.

Last URL and content review: 2026-07-25.
