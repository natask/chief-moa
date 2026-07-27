# Model-Owned Gateway Message Routing

## Why

The gateway still interpreted user language with phrase tables before the
reasoning model could choose a tool. This made settings and routing brittle:
“speak Amharic,” “be quiet,” “run an agent,” and similar requests worked only
when a transcript matched gateway-authored words.

## What Changes

- Send every free-form voice message through the reasoning model and its typed
  tool catalog.
- Use tools for profile updates and reverts, silence, agent launch/list/cancel,
  browser proposals, memory writes, context filing, and profile-option reads.
- Remove transcript regexes as authorization gates after the model selects a
  tool. Keep typed parameter validation, authentication, scope, device
  authority, allowlists, proposal boundaries, and receipts.
- Keep typed client intent/context hints for explicit UI controls.
- On model/tool failure, default to ordinary chat and the existing profile
  state. Never guess a language, setting, action, or route from words.
- Preserve the surface boundary: gateway tools may mutate gateway-owned
  profile/session/run state; phone/browser actions are bounded proposals for the
  owning surface.

## Acceptance

1. Language, voice, tone, speaking rate, modality, silence, agent control,
   memory, and context changes are represented by registered tools with typed
   parameters.
2. Tool handlers produce the same validated state changes and proposals as the
   previous matched paths.
3. Former trigger phrases classify as ordinary chat when no model tool call is
   returned.
4. A missing or malformed model tool call leaves current settings intact and
   does not launch, cancel, persist, or execute work.
5. `cd gateway && npm run check` passes.

## Boundaries

- Model output remains a proposal for device/browser-local execution.
- The gateway continues to own profile, conversation, broker, and agent-run
  storage.
- Capability validation and safety policy are deterministic; only semantic
  interpretation of the user message moves to model tool use.

