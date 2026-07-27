# Sources

These are primary papers or official technical pages. Links point to stable paper records or publisher pages where possible.

Accessed 2026-07-25.

## Foundations

### S1

Ashish Vaswani et al. "Attention Is All You Need." NeurIPS 2017.  
https://arxiv.org/abs/1706.03762

Use: transformer and scaled dot-product attention.

### S2

Tri Dao, Daniel Y. Fu, Stefano Ermon, Atri Rudra, and Christopher Ré. "FlashAttention: Fast and Memory-Efficient Exact Attention with IO-Awareness." NeurIPS 2022.  
https://arxiv.org/abs/2205.14135

Use: memory hierarchy and attention I/O.

### S3

Joshua Ainslie et al. "GQA: Training Generalized Multi-Query Transformer Models from Multi-Head Checkpoints." EMNLP 2023.  
https://arxiv.org/abs/2305.13245

Use: multi-query and grouped-query attention.

## Serving and KV management

### S4

Woosuk Kwon et al. "Efficient Memory Management for Large Language Model Serving with PagedAttention." SOSP 2023.  
https://arxiv.org/abs/2309.06180

Use: KV growth, fragmentation, paging, and sharing.

### S5

Amey Agrawal et al. "Taming Throughput-Latency Tradeoff in LLM Inference with Sarathi-Serve." 2024.  
https://arxiv.org/abs/2403.02310

Use: chunked prefill and scheduling interference.

### S6

Pratyush Patel et al. "Splitwise: Efficient Generative LLM Inference Using Phase Splitting." ISCA 2024.  
Publisher page: https://www.microsoft.com/en-us/research/publication/splitwise-efficient-generative-llm-inference-using-phase-splitting/  
Paper: https://www.microsoft.com/en-us/research/wp-content/uploads/2023/12/Splitwise_ISCA24.pdf

Use: measured phase differences, disaggregation, power and cost results.

### S7

Yinmin Zhong et al. "DistServe: Disaggregating Prefill and Decoding for Goodput-optimized Large Language Model Serving." OSDI 2024.  
https://www.usenix.org/conference/osdi24/presentation/zhong-yinmin

Use: phase disaggregation and goodput.

## Alternate decode paths and architectures

### S8

Tianle Cai et al. "Medusa: Simple LLM Inference Acceleration Framework with Multiple Decoding Heads." ICML 2024.  
https://arxiv.org/abs/2401.10774

Use: multiple proposal heads and tree verification.

### S9

Shen Nie et al. "Large Language Diffusion Models." 2025.  
https://arxiv.org/abs/2502.09992

Use: masked diffusion with a bidirectional transformer.

This is evidence that autoregressive factorization is not the only path. It does not establish that diffusion language models will replace autoregressive models.

### S10

Albert Gu and Tri Dao. "Mamba: Linear-Time Sequence Modeling with Selective State Spaces." COLM 2024.  
https://arxiv.org/abs/2312.00752

Use: selective state-space recurrence and fixed-size inference state.

## Hardware and current system debate

### S11

NVIDIA. "H100 Tensor Core GPU." Official product specifications.  
https://www.nvidia.com/en-gb/data-center/h100/

Use: H100 SXM peak figures, memory capacity, HBM bandwidth, power, and interconnect. Peak sparse tensor figures should not be treated as achieved dense inference performance.

### S12

Chao Wang et al. "Prefill-Decode Aggregation or Disaggregation? Unifying Both for Goodput-Optimized LLM Serving." 2025.  
https://arxiv.org/abs/2508.01989

Use: evidence that aggregation, disaggregation, and hybrid operation win under different service goals.

This source is a preprint. Treat its measurements as reported results, not settled consensus.

### S13

Meta. "Llama 3.1 8B Model Card." 2024.  
https://huggingface.co/meta-llama/Llama-3.1-8B  
Released Transformers configuration: https://huggingface.co/meta-llama/Llama-3.1-8B/blob/main/config.json

Use: parameter count, context length, GQA, release metadata, and the released model configuration.

### S14

NVIDIA. "Disaggregated Serving." NVIDIA Dynamo documentation.  
https://docs.nvidia.com/dynamo/latest/design-docs/disaggregated-serving

Use: current prefill worker, KV transfer, decode worker, NIXL, routing, and reconfigurable pool design.

This is changing product documentation. Keep the access date with claims.

### S15

Ruoyu Qin et al. "Mooncake: A KVCache-centric Disaggregated Architecture for LLM Serving." 2024.  
https://arxiv.org/abs/2407.00079

Use: distributed KV storage and disaggregated serving.

### S16

Bin Gao et al. "InferCept: Efficient Intercept Support for Augmented Large Language Model Inference." ICML 2024.  
https://arxiv.org/abs/2402.01869

Use: KV keep, discard, and swap choices around paused augmented inference.

### S17

NVIDIA. "NVIDIA Rubin CPX Accelerates Inference Performance and Efficiency for 1M+ Token Context Workloads." 2025.  
https://developer.nvidia.com/blog/nvidia-rubin-cpx-accelerates-inference-performance-and-efficiency-for-1m-token-context-workloads/

Use: announced context-phase hardware and vendor specifications.

This is a vendor announcement about future hardware. Treat availability, performance, and efficiency claims as unverified until measured systems ship.

### S18

Chengyue Wu et al. "Fast-dLLM: Training-free Acceleration of Diffusion LLM by Enabling KV Cache and Parallel Decoding." 2025.  
https://arxiv.org/abs/2505.22618

Use: approximate block-wise KV reuse and parallel decoding for masked diffusion language models.

This source is a preprint.

### S19

NVIDIA. "Inside NVIDIA Groq 3 LPX: The Low-Latency Inference Accelerator for the NVIDIA Vera Rubin Platform." 2026.  
https://developer.nvidia.com/blog/inside-nvidia-groq-3-lpx-the-low-latency-inference-accelerator-for-the-nvidia-vera-rubin-platform/

Use: announced attention-FFN decode disaggregation across GPU and LPX engines.

This is a vendor description of an announced architecture. Treat performance claims as vendor claims.

### S20

Biao Zhang and Rico Sennrich. "Root Mean Square Layer Normalization." NeurIPS 2019.  
https://arxiv.org/abs/1910.07467

Use: RMSNorm definition and motivation.

### S21

Jianlin Su et al. "RoFormer: Enhanced Transformer with Rotary Position Embedding." 2021.  
https://arxiv.org/abs/2104.09864

Use: rotary position embedding.

### S22

Noam Shazeer. "GLU Variants Improve Transformer." 2020.  
https://arxiv.org/abs/2002.05202

Use: SwiGLU feed-forward layer.

### S23

Meta AI. "The Llama 3 Herd of Models." 2024.  
https://arxiv.org/abs/2407.21783

Use: Llama 3 architecture, training, and inference details.

### S24

Dzmitry Bahdanau, Kyunghyun Cho, and Yoshua Bengio. "Neural Machine Translation by Jointly Learning to Align and Translate." ICLR 2015.  
https://arxiv.org/abs/1409.0473

Use: attention added to recurrent encoder-decoder translation and the fixed-vector bottleneck.

### S25

Rico Sennrich, Barry Haddow, and Alexandra Birch. "Neural Machine Translation of Rare Words with Subword Units." ACL 2016.  
https://arxiv.org/abs/1508.07909

Use: byte-pair encoding for subword tokenization.

### S26

Alec Radford et al. "Improving Language Understanding by Generative Pre-Training." OpenAI, 2018.  
https://cdn.openai.com/research-covers/language-unsupervised/language_understanding_paper.pdf

Use: early GPT decoder-only generative pre-training.

## Source rules

- Cite the exact model, device, precision, batch, and context behind a performance claim.
- Separate vendor peak specifications from measured application performance.
- Label preprints.
- Avoid projecting one serving trace into a hardware law.
- Add an access date for changing web pages.
