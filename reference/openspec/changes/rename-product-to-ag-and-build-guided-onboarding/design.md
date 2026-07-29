## Product contract

```text
Canonical name: Ag
Category: personal AI companion
Android application id: ag.companion
Relationship: useful continuity, familiarity, and user-controlled memory
Not: assistant, friend simulation, pet simulation, or claims of sentience
```

`Ag` is case-sensitive. Active product surfaces must not render `AG`, `A.G.`,
`A-G`, `Aggie`, `Moa`, or `Chief Moa` as the current user-facing product name.
Historical evidence, migration copy, source history, and unavoidable legacy
protocol aliases may name old identities when clearly marked as legacy.

## Android migration

`ag.companion` is a new package, installed beside `ai.moa.assistant`. Android
will not carry private preferences, permissions, notification state,
accessibility enablement, overlay approval, assistant role, cached downloads,
or local-only receipts into the new package. That is acceptable and explicit.

Gateway-owned account identity, conversations, runs, profile data, and other
server records are recovered only after authentication to the same account and
normal authorization checks. The old package grants no authority to the new
one. No shared storage, exported migration component, or signing assumption may
silently copy secrets or permissions.

The new package receives its own stable/preview channel identity. The old OTA
channel remains immutable or receives only an explicit retirement notice; it
must never serve an `ag.companion` APK as though it were an update.

## Guided onboarding

Onboarding optimizes for one trustworthy useful moment before breadth:

1. Introduce Ag and explain what is local versus account-backed.
2. Connect or create the account and restore authorized gateway continuity.
3. Request microphone access in context.
4. Complete and visibly verify one real conversation.
5. Offer notifications as the minimum continuity capability.
6. Offer optional capability cards progressively: overlay, Android assistant
   role/invocation, screen/accessibility actions, browser connection, media and
   communication integrations, and direct app updates.

Each capability follows one state machine:

```text
not_requested -> explained -> system_prompt_or_settings_opened
  -> returned -> verified_enabled | declined | blocked
  -> demonstrated (when enabled)
```

Ag explains why the capability matters in plain language, opens the narrowest
Android-owned prompt/settings destination, detects return, verifies actual
state, and demonstrates only the authority just granted. Optional capabilities
remain deferrable and discoverable later. Declining one does not block the core
conversation unless it is intrinsically required for that action.

## Trust and relationship boundary

The relationship is built through reliable memory, continuity, explanation,
and respect for choices—not through pet mechanics, friendship claims,
dependency cues, guilt, exclusivity, or deceptive personhood. Ag states when a
capability is unavailable and never claims a permission, action, migration, or
memory restore without observable verification or a receipt.

Server/model output remains a proposal. Android owns permission requests,
settings navigation, verification, approvals, local execution, and receipts.

## Completion and recovery

Onboarding progress is resumable and idempotent. It records capability state,
not permission secrets. On every resume, actual Android state wins over cached
progress. Users can skip optional steps, revisit onboarding from the full app,
or reset instructional progress without clearing account data.
