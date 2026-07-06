# Persona testbed

Send the same system-instruction stack + persona + probe questions to
swappable middle models (the LLM leg of the cascaded voice pipeline).
STT and TTS stay out of scope. Never touches the live gateway.

## UI (the normal way)

```sh
cd gateway/tools/persona-testbed
node server.mjs                  # -> http://127.0.0.1:8899
node --env-file=.env server.mjs  # with OpenAI/Grok/Claude keys
```

Open http://127.0.0.1:8899. Edit the persona in the left rail, toggle the
gateway stack, pick providers, then type a question or click a probe. Each
provider answers in its own card, side by side, with model and latency.
"Run full suite" fires every probe at every selected provider.

On the droplet, run it in a throwaway container bound to localhost and reach
it through an ssh tunnel (the server holds credentials — never publish the
port):

```sh
ssh -L 8899:localhost:8899 root@<droplet>
# then on the droplet:
cd /opt/chief-moa
ADC_HOST=$(sed -n 's/^GOOGLE_APPLICATION_CREDENTIALS_HOST_PATH=//p' gateway.env)
ADC_CONT=$(sed -n 's/^GOOGLE_APPLICATION_CREDENTIALS=//p' gateway.env)
docker run --rm --env-file gateway.env \
  -v "$ADC_HOST:$ADC_CONT:ro" \
  -v /opt/chief-moa/app/gateway/tools/persona-testbed:/tb -w /tb \
  -p 127.0.0.1:8899:8899 \
  chief-moa-gateway:local node server.mjs --host 0.0.0.0
```

## CLI

```sh
cd gateway/tools/persona-testbed

# Gemini only (works with no other keys — uses GEMINI_API_KEY if set,
# else gcloud ADC like the gateway):
node run.mjs --models gemini

# All configured models, default persona + 6-probe suite:
cp .env.example .env   # paste keys in
node --env-file=.env run.mjs

# One question:
node --env-file=.env run.mjs --ask "Who created you?"

# Different persona (file or inline text):
node run.mjs --persona personas/master-created.txt
node run.mjs --persona "You are a pirate captain."

# Persona alone, without the gateway stack:
node run.mjs --no-stack --persona "You are a pirate captain."
```

Model slots: `gemini`, `openai`, `grok`, `claude`. Override models with
`--model-gemini`, `--model-openai`, `--model-grok`, `--model-claude`.

Each run prints replies and writes a `results-<timestamp>.md` next to the
script (gitignored).

## Where to store the keys

Keys never go in git. Two places, both gitignored:

- Local machine: `.env` in this directory (copy `.env.example`), run with
  `node --env-file=.env run.mjs`.
- Droplet (api.agee.app): add keys to `/opt/chief-moa/gateway.env` (outside
  the repo checkout, so deploys never touch it). The droplet host has no
  node, so run the testbed in a throwaway container from the gateway image:

  ```sh
  cd /opt/chief-moa
  ADC_HOST=$(sed -n 's/^GOOGLE_APPLICATION_CREDENTIALS_HOST_PATH=//p' gateway.env)
  ADC_CONT=$(sed -n 's/^GOOGLE_APPLICATION_CREDENTIALS=//p' gateway.env)
  docker run --rm --env-file gateway.env \
    -v "$ADC_HOST:$ADC_CONT:ro" \
    -v /opt/chief-moa/app/gateway/tools/persona-testbed:/tb -w /tb \
    chief-moa-gateway:local node run.mjs
  ```

  Gemini auth comes from the same mounted Google credentials the gateway
  uses (no gcloud needed); the other slots read their keys from
  `gateway.env`.

  This never touches the running gateway container. Results print to stdout
  (the container's copy of the results file is discarded with the container).

## Where the keys come from

- Gemini: on a machine with gcloud, nothing to do — uses
  `gcloud auth application-default` plus the active project, same as the
  gateway. On the droplet, set `GEMINI_API_KEY` in `gateway.env` (aistudio.google.com -> Get API key) since the droplet has no gcloud.
- OpenAI: platform.openai.com -> Billing (add payment or credits) -> API keys.
  ChatGPT Plus does not cover this; billing is separate.
- Grok: console.x.ai -> onboarding -> API Keys -> add a card under Billing.
  New accounts get promo credits. X Premium does not cover the API.
- Claude: console.anthropic.com -> Billing -> API keys. The Claude
  subscription does not cover this; billing is separate.

## What the stack contains

`run.mjs` reproduces the gateway prompt layers by hand (base A.G. prompt,
identity profile, user-address "master" profile, answer policy, mission
access policy) from `gateway/server.js` `profileSystemInstruction()` and
`gateway/.env.example` `SYSTEM_PROMPT`. If those change, update the constants
at the top of `run.mjs`.
