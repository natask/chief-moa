# Native Model Web Search Design

## Provider Selection

For `reasoning_provider=vertex`, ordinary `generateContent` and
`streamGenerateContent` requests include `{ "googleSearch": {} }` in the
provider tool list. Existing function declarations remain alongside it. The
forced `context_management` preflight does not receive search because it must
make exactly one routing decision and produce no answer.

For a provider path without native-search support in the gateway protocol, the
gateway offers an Exa-backed `web_search` function only when `EXA_API_KEY` is
configured. The first fallback is intentionally small: query length is capped,
result count is clamped, the endpoint is fixed/configured gateway-side, timeout
is bounded, only HTTP(S) URLs survive normalization, highlights are capped, and
provider errors disclose neither the key nor raw response bodies.

## Model Interface

Native search remains a provider tool and does not appear as
`tools.moa.web_search` inside QuickJS. The model's built-in runtime instruction
describes when to search and how to handle sources. Exa appears as a normal
function tool because it emulates missing provider functionality rather than
granting the code sandbox network access.

## Rollout

`MODEL_NATIVE_WEB_SEARCH=1` is the default for Vertex and can disable the native
tool if a selected model rejects it. `EXA_API_KEY` is optional. Health reports
only whether native Vertex search is enabled and whether the fallback is
configured; it never reports credential material.
