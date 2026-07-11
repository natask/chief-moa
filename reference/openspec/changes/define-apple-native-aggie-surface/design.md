## Decision

Use a UI-independent Swift package shared by macOS and iOS. The package is a
thin protocol consumer and local decision authority, not a canonical store or
application. All effectful services are injected and absent in production code.

## Non-goals

No permanent companion/seamless UX decision, network client, token storage,
Keychain policy, permissions, platform action, signing, update, distribution,
physical-device, accessibility, or production performance claim.
