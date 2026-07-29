## Why

The product currently presents several competing identities: Chief Moa,
Aggie, A.G., and AG, often alongside “assistant” or “pet.” The intended product
is simpler and more personal: **Ag**, a **personal AI companion**. The Android
package migration is also the best moment to replace a settings checklist with
a guided first experience in which Ag helps the user enable, verify, and
understand its capabilities.

## What Changes

- Make `Ag` the exact canonical user-facing name across active product UI,
  speech, notifications, settings labels, accessibility labels, and current
  documentation.
- Describe Ag as a `personal AI companion`. Do not position it as an assistant,
  a friend, a pet, or a simulated relationship.
- Create Android application id `ag.companion` as a clean parallel install. It
  is a new Android app identity and does not pretend to be an OTA update of
  `ai.moa.assistant`.
- Build progressive, conversational onboarding: establish a useful first voice
  exchange with minimum access, then let Ag explain, open, detect, verify, and
  demonstrate each optional capability.
- Preserve user agency. Ag may navigate to Android-owned settings and interpret
  returned state, but cannot grant its own permissions or treat server output
  as local authority.
- Retain historical records and compatibility identifiers where technically
  required; do not rewrite Git history or old release receipts.

## Capabilities

### New Capabilities

- `ag-product-identity`: canonical name, positioning, package identity, and
  compatibility boundary for Ag.
- `android-guided-onboarding`: progressive self-guided setup and capability
  verification on Android.

## Impact

- Android package/application id, source namespaces, manifests, resources,
  backup rules, deep links, release channel, tests, and distribution records.
- Active Android, browser, web, gateway, and desktop user-facing copy and spoken
  identity.
- Gateway account/session reconnection so the new package can restore
  gateway-owned history without claiming transfer of old app-private data.
- Repository and infrastructure naming can migrate separately where external
  rename operations or compatibility aliases are required.
