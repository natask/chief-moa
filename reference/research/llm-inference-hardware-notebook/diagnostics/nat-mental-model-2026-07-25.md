# Private diagnostic snapshot

Date: 2026-07-25

Purpose: preserve Nat's wording before instruction. This is evidence of the current mental model, not a statement of fact.

> attention likely predates encoder-decoder; current LMs are decoder-only; encoder-decoder compressed text then decoded; current text is chunked by something he calls "pipe here encoding" (likely byte-pair encoding), mapped to vocabulary IDs/numbers, fed into layers; each layer starts with attention; he recalls Q and V but forgets K and exact elementwise math; thinks queries may multiply values directly; knows multi-head attention computes separate versions and a fully connected projection merges heads; knows a feed-forward/fully connected stage follows; recalls residual/skip additions but suspects the original vector may be added n times; expects final output to become a token distribution sampled using temperature; thinks the sampled token is passed into the KV cache.

Do not treat this note as polished prose. Update the dated diagnostic record after Nat answers the reconstruction questions in the lesson.
