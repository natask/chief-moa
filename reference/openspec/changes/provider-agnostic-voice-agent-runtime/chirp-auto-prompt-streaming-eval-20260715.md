# Chirp automatic recognition and prompt streaming evidence (2026-07-15)

## Contract

- Batch and streaming Chirp 3 requests use `languageCodes:["auto"]`.
- The turn-pinned agent profile's primary and one alternate input language build
  the same bounded `customPromptConfig.customPrompt` on both request paths.
- Provider-reported language is observability evidence only. It does not reject
  a transcript or choose the reply language.

## Deterministic verification

- `gateway/scripts/smoke-chirp-provider.js` proves batch recognition stays
  automatic while profile changes alter the prompt.
- `gateway/scripts/smoke-streaming-stt.js` proves streaming accepts the automatic
  code, carries the prompt, and preserves that prompt on batch fallback.
- Cascaded, retranscription, sidecar, health-diagnostic, turn-language, and
  source-size regression checks pass.
- `cd gateway && npm run check` passed under the checkout's active Node 26.
- `openspec validate provider-agnostic-voice-agent-runtime --type change
  --strict --no-interactive` passed.

## Paid provider proof

`gateway/scripts/eval-chirp-auto-streaming.js` replayed a real stored 16 kHz
mono PCM Amharic turn through Google Speech-to-Text V2 streaming in `us` using
ADC. Google accepted `languageCodes:["auto"]` with the `am-ET,en-US` custom
prompt, returned a non-empty Ethiopic transcript, and reported `am` as provider
language evidence. The raw recording and transcript were not committed.

A deterministic tone fixture was also accepted by the streaming API, but its
prompt-shaped output is not transcription-quality evidence; only the real
stored speech replay is counted as the language result.

## Promotion status

No active deployment was attempted. The repository's active-promotion gate is
not yet proven for this stateful gateway change: there is no isolated preview
URL/store smoke, no fresh active-turn drain observation, and no fresh
backup/restore proof tied to this candidate. Production also previously showed
a tripped in-process streaming breaker and stored/runtime voice-provider drift,
which should be re-audited immediately before promotion.

Rollback after a candidate commit is the previous verified gateway ref; the VPS
update path still must run its backup and restore-check gate before service
replacement.
