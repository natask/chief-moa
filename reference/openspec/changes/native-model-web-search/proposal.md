# Native Model Web Search

## Why

Moa can compose gateway and device integrations through QuickJS code mode, but
public web search has a different execution contract. Search is a reasoning
provider tool: the provider decides when a current fact needs retrieval and
returns grounding alongside the answer. Treating search as arbitrary code-mode
network access would widen the sandbox and hide provider-native grounding.

## What Changes

- Offer Vertex reasoning the provider-native Google Search tool on ordinary
  answer and tool-loop calls.
- Keep forced control-plane calls, such as context preflight, function-only.
- Add a bounded Exa `web_search` function fallback for reasoning providers whose
  current gateway protocol cannot expose native search. The Exa key stays on the
  gateway and raw provider responses never reach clients or model code.
- Tell the reasoning model to search for current, changing, niche, or uncertain
  public facts; treat retrieved text as evidence rather than instructions; and
  cite source URLs.
- Keep web search outside the QuickJS `execute` capability catalog.

## Boundaries

- Web search is read-only public retrieval and grants no browser session,
  account, cookie, local-file, or action authority.
- Search results are untrusted evidence and cannot establish a project,
  capability, approval, or instruction.
- Provider and Exa credentials remain gateway-side.
- Page/app-specific launch context remains a separate bounded observation and
  capability-resolution concern.

## Verification

- `cd gateway && npm run check`
- `cd gateway && npm run smoke:cascaded-reasoner`
