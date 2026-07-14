# Native-audio provider trial (2026-07-14)

## Scope

The protected five-file Amharic/English corpus was offered to three native or
multimodal audio endpoints using server-side credentials supplied for this
one-time evaluation. Raw audio and credentials were not committed.

## Results

| Provider/model | Endpoint reached | Audio processed | Result |
| --- | --- | --- | --- |
| Vertex `gemini-3.5-flash` | Yes | Yes, 20 requests | Full prompt-ablation evidence recorded in `gemini-35-audio-understanding-eval-20260714.md` |
| OpenAI `gpt-realtime` | Yes | No | GA handshake reached; every session rejected before audio for exceeded/missing project quota or billing |
| xAI `grok-voice-latest` | Yes | No | Key authenticated; every upgrade rejected before audio because the xAI team has no credits or licenses |

The first OpenAI probe included the retired Realtime Beta header and was
rejected with an instruction to use the GA API. The evaluator removed that
header and repeated the calls; the resulting blocker was quota, not protocol
version.

The initial xAI probe exposed only HTTP 403. The evaluator then captured the
bounded provider response body, which identified the no-credits/no-license
condition. The team identifier and credential material are excluded from the
committed evidence.

## Credential handling

The user copied existing OpenAI and xAI keys from their password manager into a
mode-0600 temporary file outside the repository. The evaluator read the values
without logging them. Presence and permissions were verified without printing
the values. The temporary file was deleted immediately after both provider
attempts and its absence was verified.

No browser cookies, local storage, authenticated session material, `.env`
files, or client-side credential extraction were used.

## What is required to finish the comparison

- OpenAI: enable billing or add usable API credits to the project associated
  with the supplied key, and ensure that project can use `gpt-realtime`.
- xAI: purchase credits or assign a qualifying license to the team associated
  with the supplied key.
- Recreate the temporary credential handoff after those account changes. The
  original temporary file was intentionally destroyed.

No conclusion about GPT Realtime or Grok's Amharic/code-switch quality can be
drawn because neither provider accepted audio.

## Reproduction

```text
cd gateway
node scripts/eval-realtime-audio-provider.mjs \
  openai /tmp/moa-native-audio-eval-20260714 /tmp/chief-moa-voice-eval-keys
node scripts/eval-realtime-audio-provider.mjs \
  xai /tmp/moa-native-audio-eval-20260714 /tmp/chief-moa-voice-eval-keys
```

This evaluator is live, paid, and opt-in. It must not run in the default test
suite.
